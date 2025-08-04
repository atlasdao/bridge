const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { Markup } = require('telegraf');
const config = require('../core/config');
const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');

const safeCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (e) { logger.error("Error in safeCompare:", e); return false; }
};

const processWebhook = async (webhookData, dbPool, bot, expectationQueue, expirationQueue) => {
    const { blockchainTxID, qrId, status } = webhookData;

    try {
        const reminderJobId = `expectation-${qrId}`;
        const expirationJobId = `expiration-${qrId}`;
        const reminderJob = await expectationQueue.getJob(reminderJobId);
        if (reminderJob) { await reminderJob.remove(); logger.info(`[Process] Reminder job ${reminderJobId} removed.`); }
        const expirationJob = await expirationQueue.getJob(expirationJobId);
        if (expirationJob) { await expirationJob.remove(); logger.info(`[Process] Expiration job ${expirationJobId} removed.`); }
    } catch (queueError) { logger.error(`[Process] Error removing jobs for qrId ${qrId}:`, queueError); }

    const { rows } = await dbPool.query('SELECT transaction_id, user_id, requested_brl_amount, qr_code_message_id, reminder_message_id, payment_status FROM pix_transactions WHERE depix_api_entry_id = $1', [qrId]);

    if (rows.length === 0) {
        logger.warn(`[Process] No transaction found for qrId '${qrId}'.`);
        return { success: false, message: 'Transaction not found.' };
    }

    const transaction = rows[0];
    const { transaction_id: ourTransactionId, user_id: recipientTelegramUserId, requested_brl_amount: requestedAmountBRL, qr_code_message_id: qrMessageId, reminder_message_id: reminderMessageId, payment_status: currentStatus } = transaction;

    if (currentStatus !== 'PENDING') {
        logger.warn(`[Process] Transaction '${ourTransactionId}' is already in status '${currentStatus}'. Ignoring duplicate webhook.`);
        return { success: true, message: 'Transaction already processed.' };
    }

    let newPaymentStatus;
    if (status === 'depix_sent') newPaymentStatus = 'PAID';
    else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) newPaymentStatus = 'FAILED';
    else {
        logger.warn(`[Process] Webhook for qrId ${qrId} has a non-terminal status: '${status}'.`);
        return { success: true, message: 'Non-terminal status received.' };
    }

    await dbPool.query('UPDATE pix_transactions SET payment_status = $1, depix_txid = $2, webhook_received_at = NOW(), updated_at = NOW() WHERE transaction_id = $3', [newPaymentStatus, blockchainTxID, ourTransactionId]);
    logger.info(`[Process] Transaction ${ourTransactionId} updated from PENDING to ${newPaymentStatus}`);

    if (!bot || !recipientTelegramUserId) {
        logger.error(`[Process] Notification NOT sent for transaction ${ourTransactionId}: bot instance or recipientTelegramUserId is missing.`);
        return { success: true, message: 'Processed, but notification failed.' };
    }

    // CORREÇÃO: A LÓGICA DE NOTIFICAÇÃO E LIMPEZA ESTÁ DE VOLTA
    if (qrMessageId) {
        try { await bot.telegram.deleteMessage(recipientTelegramUserId, qrMessageId); logger.info(`[Process] Deleted QR message ${qrMessageId}`); }
        catch (e) { logger.error(`[Process] Failed to delete QR message ${qrMessageId}: ${e.message}`); }
    }
    if (reminderMessageId) {
        try { await bot.telegram.deleteMessage(recipientTelegramUserId, reminderMessageId); logger.info(`[Process] Deleted reminder message ${reminderMessageId}`); }
        catch (e) { logger.error(`[Process] Failed to delete reminder message ${reminderMessageId}: ${e.message}`); }
    }

    let userMessage;
    if (newPaymentStatus === 'PAID') {
        userMessage = `✅ Pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))} confirmado\\!\nSeus DePix foram enviados\\.\n`;
        if (blockchainTxID) userMessage += `ID da Transação Liquid: \`${escapeMarkdownV2(blockchainTxID)}\``;
    } else {
        userMessage = `❌ Falha no pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\\.\nStatus da API DePix: ${escapeMarkdownV2(status)}\\. Se o valor foi debitado, entre em contato com o suporte\\.`;
    }

    try {
        await bot.telegram.sendMessage(recipientTelegramUserId, userMessage, { parse_mode: 'MarkdownV2' });
        logger.info(`[Process] Notification SENT to user ${recipientTelegramUserId} for transaction ${ourTransactionId}`);

        if (newPaymentStatus === 'PAID') {
            const feedbackMessage = "O bot está te ajudando? Não estamos conseguindo cobrir os custos de infraestrutura, considere fazer uma doação para manter o bot no ar e financiar o desenvolvimento contínuo. Envie Depix para: \n\n VJLBCUaw6GL8AuyjsrwpwTYNCUfUxPVTfxxffNTEZMKEjSwamWL6YqUUWLvz89ts1scTDKYoTF8oruMX";
            const feedbackLink = "https://coinos.io/AtlasDAO";
            
            setTimeout(async () => {
                try {
                    await bot.telegram.sendMessage(recipientTelegramUserId, feedbackMessage, Markup.inlineKeyboard([
                        [Markup.button.url('Ou, clique aqui para doar BTC lightning, On-chain ou Liquid', feedbackLink)]
                    ]));
                    logger.info(`[Process] Donation request sent to user ${recipientTelegramUserId}.`);
                } catch (feedbackError) {
                    logger.error(`[Process] FAILED to send donation request to user ${recipientTelegramUserId}. Error: ${feedbackError.message}`);
                }
            }, 2000);
        }
    } catch (notifyError) {
        logger.error(`[Process] FAILED to send Telegram notification to user ${recipientTelegramUserId}. Error: ${notifyError.message}`);
    }

    return { success: true, message: 'Webhook processed successfully.' };
};

const createWebhookRoutes = (bot, dbPool, devDbPool, expectationQueue, expirationQueue) => {
    // A lógica do roteador/forwarder em si não precisa mudar.
    const router = express.Router();
    router.post('/depix_payment', async (req, res) => {
        try {
            logger.info(`--- Webhook Request Received on [${config.app.nodeEnv}] from IP [${req.ip}] ---`);
            if (!req.headers.authorization || !req.headers.authorization.startsWith('Basic ') || !safeCompare(req.headers.authorization.substring(6), config.depix.webhookSecret)) {
                logger.warn(`[Router-${config.app.nodeEnv}] WEBHOOK AUTHORIZATION FAILED.`);
                return res.status(401).send('Unauthorized');
            }
            logger.info(`[Router-${config.app.nodeEnv}] Webhook authorized.`);
            const webhookData = req.body;
            const { qrId } = webhookData;
            if (!qrId) return res.status(400).send('Bad Request: Missing qrId.');

            if (config.app.nodeEnv === 'production') {
                const { rows } = await dbPool.query('SELECT 1 FROM pix_transactions WHERE depix_api_entry_id = $1', [qrId]);
                if (rows.length > 0) {
                    logger.info(`[Router-Prod] Webhook for qrId '${qrId}' found in PROD DB. Processing locally.`);
                    const result = await processWebhook(webhookData, dbPool, bot, expectationQueue, expirationQueue);
                    return res.status(200).send(result.message);
                }

                if (!devDbPool) {
                    logger.warn(`[Router-Prod] Webhook for unknown qrId '${qrId}' received, but DEV DB is not configured for forwarding. Discarding.`);
                    return res.status(404).send('Transaction not found in production.');
                }

                const { rows: devRows } = await devDbPool.query('SELECT 1 FROM pix_transactions WHERE depix_api_entry_id = $1', [qrId]);
                if (devRows.length > 0) {
                    logger.warn(`[Router-Prod] Webhook for qrId '${qrId}' NOT in PROD, found in DEV. Attempting to forward to ${config.developmentServerUrl}...`);
                    try {
                        await axios.post(`${config.developmentServerUrl}/webhooks/depix_payment`, webhookData, { headers: { 'Authorization': req.headers.authorization } });
                        logger.info(`[Router-Prod] Webhook for qrId '${qrId}' forwarded successfully.`);
                        return res.status(200).send('OK: Forwarded to development.');
                    } catch (forwardError) {
                        logger.error(`[Router-Prod] FAILED to forward webhook for qrId '${qrId}'.`);
                        if (forwardError.response) {
                            logger.error(`--> Details: Received HTTP ${forwardError.response.status} from development server.`);
                            logger.error(`--> Response Data: ${JSON.stringify(forwardError.response.data)}`);
                        } else if (forwardError.request) {
                            logger.error(`--> Details: No response received from development server. This is likely a connection error.`);
                            logger.error(`--> Error Code: ${forwardError.code}`);
                        } else {
                            logger.error('--> Details: Error setting up the forward request.');
                            logger.error(`--> Message: ${forwardError.message}`);
                        }
                        return res.status(502).send('Error forwarding webhook to dev.');
                    }
                }

                logger.warn(`[Router-Prod] Webhook for qrId '${qrId}' not found in PROD or DEV databases. Discarding.`);
                return res.status(404).send('Transaction not found in any environment.');
            } else {
                logger.info(`[Router-Dev] Webhook received in DEV environment. Processing locally.`);
                const result = await processWebhook(webhookData, dbPool, bot, expectationQueue, expirationQueue);
                return res.status(200).send(result.message);
            }
        } catch (error) {
            logger.error('[Router] FATAL ERROR in webhook router logic:', error);
            if (!res.headersSent) res.status(500).send('Internal Server Error');
        }
    });
    return router;
};
module.exports = { createWebhookRoutes };