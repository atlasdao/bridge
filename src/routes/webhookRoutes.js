const express = require('express');
const crypto = require('crypto');
const { Markup } = require('telegraf');
const config = require('../core/config');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');

const safeCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') { return false; }
    try {
        const bufA = Buffer.from(a);
        const bufB = Buffer.from(b);
        if (bufA.length !== bufB.length) { return false; }
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) { console.error("Error in safeCompare:", e); return false; }
};

const createWebhookRoutes = (bot, dbPool, expectationMessageQueue, expirationQueue) => {
    const router = express.Router();

    router.post('/depix_payment', async (req, res) => {
        try {
            console.log('Received DePix Webhook POST request.');
            console.log('Webhook Body:', JSON.stringify(req.body, null, 2));

            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Basic ') || !safeCompare(authHeader.substring(6), config.depix.webhookSecret)) {
                console.warn('WEBHOOK AUTHORIZATION FAILED.');
                return res.status(401).send('Unauthorized: Invalid or missing secret.');
            }
            console.log('Webhook authorized successfully.');

            const webhookData = req.body;
            const { blockchainTxID, qrId, status } = webhookData;

            if (!qrId || !status) {
                console.error('Webhook payload missing qrId or status.');
                return res.status(400).send('Bad Request: Missing required fields.');
            }
            
            const reminderJobId = `expectation-${qrId}`;
            const expirationJobId = `expiration-${qrId}`;
            try {
                const reminderJob = await expectationMessageQueue.getJob(reminderJobId);
                if (reminderJob) { await reminderJob.remove(); console.log(`Reminder job ${reminderJobId} removed.`); }
                
                const expirationJob = await expirationQueue.getJob(expirationJobId);
                if (expirationJob) { await expirationJob.remove(); console.log(`Expiration job ${expirationJobId} removed.`); }
            } catch (queueError) { console.error(`Error removing jobs for qrId ${qrId} from BullMQ:`, queueError); }

            console.log(`Processing webhook for qrId: ${qrId}, status: ${status}`);

            const { rows } = await dbPool.query(
                'SELECT transaction_id, user_id, requested_brl_amount, qr_code_message_id, reminder_message_id, payment_status FROM pix_transactions WHERE depix_api_entry_id = $1',
                [qrId]
            );

            // BLINDAGEM DE CÓDIGO: Lida com o caso de a transação não ser encontrada ou já ter sido processada.
            if (rows.length === 0) {
                console.warn(`[Graceful Exit] Webhook received for qrId '${qrId}', but no transaction was found with this ID in the database.`);
                return res.status(200).send('OK: Transaction not found.');
            }

            const transaction = rows[0];
            const { transaction_id: ourTransactionId, user_id: recipientTelegramUserId, requested_brl_amount: requestedAmountBRL, qr_code_message_id: qrMessageId, reminder_message_id: reminderMessageId, payment_status: currentStatus } = transaction;

            if (currentStatus !== 'PENDING') {
                console.warn(`[Graceful Exit] Webhook received for an already processed transaction. qrId: '${qrId}', Current Status: '${currentStatus}'.`);
                return res.status(200).send('OK: Transaction already processed.');
            }
            
            let newPaymentStatus;
            if (status === 'depix_sent') { newPaymentStatus = 'PAID'; }
            else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) { newPaymentStatus = 'FAILED'; }
            else {
                console.warn(`Webhook for qrId ${qrId} has a non-terminal status: '${status}'. No update will be made.`);
                return res.status(200).send('OK: Non-terminal status received.');
            }
            
            await dbPool.query( 'UPDATE pix_transactions SET payment_status = $1, depix_txid = $2, webhook_received_at = NOW(), updated_at = NOW() WHERE transaction_id = $3', [newPaymentStatus, blockchainTxID, ourTransactionId]);
            console.log(`Transaction ${ourTransactionId} updated from PENDING to ${newPaymentStatus}`);

            if (!bot || !recipientTelegramUserId) {
                console.error(`Notification NOT sent for transaction ${ourTransactionId}: bot instance or recipientTelegramUserId is missing.`);
                return res.status(200).send('OK: Webhook processed, but notification failed.'); // Ainda retorna 200 OK
            }
            
            if (qrMessageId) {
                try { await bot.telegram.deleteMessage(recipientTelegramUserId, qrMessageId); console.log(`Deleted QR message ${qrMessageId}`); }
                catch (e) { console.error(`Failed to delete QR message ${qrMessageId}: ${e.message}`); }
            }
            if (reminderMessageId) {
                try { await bot.telegram.deleteMessage(recipientTelegramUserId, reminderMessageId); console.log(`Deleted reminder message ${reminderMessageId}`); }
                catch (e) { console.error(`Failed to delete reminder message ${reminderMessageId}: ${e.message}`); }
            }

            let userMessage = '';
            if (newPaymentStatus === 'PAID') {
                userMessage = `✅ Pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))} confirmado\\!\n` +
                              `Seus DePix foram enviados\\.\n`;
                if (blockchainTxID) { userMessage += `ID da Transação Liquid: \`${escapeMarkdownV2(blockchainTxID)}\``; }
            } else { 
                userMessage = `❌ Falha no pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\\.\n` +
                              `Status da API DePix: ${escapeMarkdownV2(status)}\\. Se o valor foi debitado, entre em contato com o suporte\\.`;
            }
            
            await bot.telegram.sendMessage(recipientTelegramUserId, userMessage, { parse_mode: 'MarkdownV2' });
            console.log(`Notification SENT to user ${recipientTelegramUserId} for transaction ${ourTransactionId}`);

            if (newPaymentStatus === 'PAID') {
                const feedbackMessage = "O bot está te ajudando? Não estamos conseguindo cobrir os custos de infraestrutura, considere fazer uma doação para manter o bot no ar e financiar o desenvolvimento contínuo. Envie Depix para: \n\n VJLBCUaw6GL8AuyjsrwpwTYNCUfUxPVTfxxffNTEZMKEjSwamWL6YqUUWLvz89ts1scTDKYoTF8oruMX";
                const feedbackLink = "https://coinos.io/AtlasDAO";
                
                setTimeout(async () => {
                    try {
                        await bot.telegram.sendMessage(
                            recipientTelegramUserId,
                            feedbackMessage,
                            Markup.inlineKeyboard([
                                [Markup.button.url('Ou, clique aqui para doar BTC lightning, On-chain ou Liquid', feedbackLink)]
                            ])
                        );
                        console.log(`Donation request sent to user ${recipientTelegramUserId}.`);
                    } catch (feedbackError) {
                        console.error(`FAILED to send donation request to user ${recipientTelegramUserId}. Error: ${feedbackError.message}`);
                    }
                }, 2000);
            }
            
            res.status(200).send('OK: Webhook processed successfully.');

        } catch (error) {
            console.error('FATAL ERROR in webhook processing logic:', error);
            // Evita que o processo trave, enviando uma resposta de erro genérica.
            if (!res.headersSent) {
                res.status(500).send('Internal Server Error while processing webhook.');
            }
        }
    });
    return router;
};
module.exports = { createWebhookRoutes };