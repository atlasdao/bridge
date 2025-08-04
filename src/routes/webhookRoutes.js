const express = require('express');
const crypto = require('crypto');
const axios = require('axios'); // Precisamos do axios para o forward
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

// A função que processa o webhook, agora separada para ser reutilizada.
const processWebhook = async (webhookData, dbPool, bot, expectationQueue, expirationQueue) => {
    const { blockchainTxID, qrId, status } = webhookData;

    const reminderJobId = `expectation-${qrId}`;
    const expirationJobId = `expiration-${qrId}`;
    try {
        const reminderJob = await expectationQueue.getJob(reminderJobId);
        if (reminderJob) { await reminderJob.remove(); logger.info(`Reminder job ${reminderJobId} removed.`); }
        const expirationJob = await expirationQueue.getJob(expirationJobId);
        if (expirationJob) { await expirationJob.remove(); logger.info(`Expiration job ${expirationJobId} removed.`); }
    } catch (queueError) { logger.error(`Error removing jobs for qrId ${qrId} from BullMQ:`, queueError); }

    const { rows } = await dbPool.query(
        'SELECT transaction_id, user_id, requested_brl_amount, qr_code_message_id, reminder_message_id, payment_status FROM pix_transactions WHERE depix_api_entry_id = $1',
        [qrId]
    );

    if (rows.length === 0) {
        logger.warn(`Webhook processor: No transaction found for qrId '${qrId}'.`);
        return { success: false, message: 'Transaction not found.' };
    }

    const transaction = rows[0];
    const { transaction_id: ourTransactionId, user_id: recipientTelegramUserId, requested_brl_amount: requestedAmountBRL, qr_code_message_id: qrMessageId, reminder_message_id: reminderMessageId, payment_status: currentStatus } = transaction;

    if (currentStatus !== 'PENDING') {
        logger.warn(`Webhook processor: Transaction '${ourTransactionId}' is already in status '${currentStatus}'. Ignoring duplicate webhook.`);
        return { success: true, message: 'Transaction already processed.' };
    }
    
    let newPaymentStatus;
    if (status === 'depix_sent') newPaymentStatus = 'PAID';
    else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) newPaymentStatus = 'FAILED';
    else {
        logger.warn(`Webhook for qrId ${qrId} has a non-terminal status: '${status}'.`);
        return { success: true, message: 'Non-terminal status received.'};
    }
    
    await dbPool.query('UPDATE pix_transactions SET payment_status = $1, depix_txid = $2, webhook_received_at = NOW(), updated_at = NOW() WHERE transaction_id = $3', [newPaymentStatus, blockchainTxID, ourTransactionId]);
    logger.info(`Transaction ${ourTransactionId} updated from PENDING to ${newPaymentStatus}`);

    if (!bot || !recipientTelegramUserId) {
        logger.error(`Notification NOT sent for transaction ${ourTransactionId}: bot instance or recipientTelegramUserId is missing.`);
        return { success: true, message: 'Processed, but notification failed.' };
    }
    
    // Notificações e Limpeza de Mensagens
    if (qrMessageId) {
        try { await bot.telegram.deleteMessage(recipientTelegramUserId, qrMessageId); logger.info(`Deleted QR message ${qrMessageId}`); }
        catch (e) { logger.error(`Failed to delete QR message ${qrMessageId}: ${e.message}`); }
    }
    if (reminderMessageId) {
        try { await bot.telegram.deleteMessage(recipientTelegramUserId, reminderMessageId); logger.info(`Deleted reminder message ${reminderMessageId}`); }
        catch (e) { logger.error(`Failed to delete reminder message ${reminderMessageId}: ${e.message}`); }
    }

    let userMessage = '';
    if (newPaymentStatus === 'PAID') {
        userMessage = `✅ Pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))} confirmado\\!\nSeus DePix foram enviados\\.\n`;
        if (blockchainTxID) { userMessage += `ID da Transação Liquid: \`${escapeMarkdownV2(blockchainTxID)}\``; }
    } else { 
        userMessage = `❌ Falha no pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\\.\nStatus da API DePix: ${escapeMarkdownV2(status)}\\. Se o valor foi debitado, entre em contato com o suporte\\.`;
    }
    
    await bot.telegram.sendMessage(recipientTelegramUserId, userMessage, { parse_mode: 'MarkdownV2' });
    logger.info(`Notification SENT to user ${recipientTelegramUserId} for transaction ${ourTransactionId}`);

    if (newPaymentStatus === 'PAID') {
        // ... (código da mensagem de doação)
    }
    
    return { success: true, message: 'Webhook processed successfully.' };
};


// O Ponto de Entrada Principal para Webhooks
const createWebhookRoutes = (bot, prodDbPool, devDbPool, expectationQueue, expirationQueue) => {
    const router = express.Router();
    router.post('/depix_payment', async (req, res) => {
        try {
            logger.info('Received DePix Webhook POST request.');

            if (!req.headers.authorization || !req.headers.authorization.startsWith('Basic ') || !safeCompare(req.headers.authorization.substring(6), config.depix.webhookSecret)) {
                logger.warn('WEBHOOK AUTHORIZATION FAILED.');
                return res.status(401).send('Unauthorized');
            }
            logger.info('Webhook authorized.');

            const webhookData = req.body;
            const { qrId } = webhookData;
            if (!qrId) return res.status(400).send('Bad Request: Missing qrId.');

            // Lógica do Roteador
            if (config.app.nodeEnv === 'production') {
                const { rows } = await prodDbPool.query('SELECT 1 FROM pix_transactions WHERE depix_api_entry_id = $1', [qrId]);
                if (rows.length > 0) {
                    logger.info(`Webhook for qrId '${qrId}' found in PROD DB. Processing locally.`);
                    const result = await processWebhook(webhookData, prodDbPool, bot, expectationQueue, expirationQueue);
                    return res.status(200).send(result.message);
                }

                if (devDbPool) {
                    const { rows: devRows } = await devDbPool.query('SELECT 1 FROM pix_transactions WHERE depix_api_entry_id = $1', [qrId]);
                    if (devRows.length > 0) {
                        logger.warn(`Webhook for qrId '${qrId}' NOT found in PROD DB, but found in DEV DB. Forwarding...`);
                        try {
                            await axios.post(`${config.developmentServerUrl}/webhooks/depix_payment`, webhookData, {
                                headers: { 'Authorization': req.headers.authorization }
                            });
                            logger.info(`Webhook for qrId '${qrId}' forwarded to development server successfully.`);
                            return res.status(200).send('OK: Forwarded to development environment.');
                        } catch (forwardError) {
                            logger.error(`Failed to forward webhook for qrId '${qrId}' to development server.`, forwardError.message);
                            return res.status(502).send('Error forwarding webhook to dev.');
                        }
                    }
                }
                
                logger.warn(`Webhook for qrId '${qrId}' not found in any known database.`);
                return res.status(404).send('Transaction not found in any environment.');

            } else { // Ambiente de Desenvolvimento
                logger.info(`Webhook for qrId '${qrId}' received in DEV environment. Processing locally.`);
                const result = await processWebhook(webhookData, prodDbPool, bot, expectationQueue, expirationQueue);
                return res.status(200).send(result.message);
            }

        } catch (error) {
            logger.error('FATAL ERROR in webhook router logic:', error);
            if (!res.headersSent) res.status(500).send('Internal Server Error');
        }
    });
    return router;
};

module.exports = { createWebhookRoutes };