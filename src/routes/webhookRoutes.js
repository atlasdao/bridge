const express = require('express');
const crypto = require('crypto');
const { Markup } = require('telegraf'); // Importar Markup para criar botões
const config = require('../core/config');
const { escapeMarkdownV2 } = require('../bot/handlers'); // Importar a função de escape

const safeCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') { return false; }
    try {
        const bufA = Buffer.from(a);
        const bufB = Buffer.from(b);
        if (bufA.length !== bufB.length) { return false; }
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) { console.error("Error in safeCompare:", e); return false; }
};

const createWebhookRoutes = (dbPool, expectationMessageQueue) => {
    const router = express.Router();

    router.post('/depix_payment', async (req, res) => {
        console.log('Received DePix Webhook POST request.');
        console.log('Webhook Raw Headers:', JSON.stringify(req.headers, null, 2));
        console.log('Webhook Body:', JSON.stringify(req.body, null, 2));

        const authHeader = req.headers.authorization;
        let authorized = false;

        if (authHeader && authHeader.startsWith('Basic ')) {
            const providedSecret = authHeader.substring(6); 
            console.log(`Webhook Auth Attempt: Secret from header: "${providedSecret}" (length: ${providedSecret?.length})`);
            console.log(`Expected Secret from config: "${config.depix.webhookSecret}" (length: ${config.depix.webhookSecret?.length})`);
            if (providedSecret && config.depix.webhookSecret && safeCompare(providedSecret, config.depix.webhookSecret)) {
                authorized = true;
            } else { console.warn('Webhook secret mismatch.'); }
        } else { console.warn('Webhook Authorization header missing or not "Basic " type.'); }

        if (!authorized) {
            console.warn('WEBHOOK AUTHORIZATION FAILED.');
            return res.status(401).send('Unauthorized: Invalid or missing secret.');
        }
        console.log('Webhook authorized successfully.');

        const webhookData = req.body;
        const { blockchainTxID, qrId, status, valueInCents } = webhookData;

        if (!qrId || !status) {
            console.error('Webhook payload missing qrId or status.');
            return res.status(400).send('Bad Request: Missing required fields.');
        }
        
        const jobToRemoveId = `expectation-${qrId}`;
        try {
            const job = await expectationMessageQueue.getJob(jobToRemoveId);
            if (job) { await job.remove(); console.log(`Expectation job ${jobToRemoveId} removed for qrId ${qrId}.`);}
            else { console.log(`No active expectation job ${jobToRemoveId} found for qrId ${qrId}.`); }
        } catch (queueError) { console.error(`Error removing job ${jobToRemoveId} from BullMQ:`, queueError); }

        console.log(`Processing webhook for qrId: ${qrId}, status: ${status}, valueInCents: ${valueInCents}, blockchainTxID: ${blockchainTxID || 'N/A'}`);

        try {
            const { rows } = await dbPool.query(
                'SELECT transaction_id, user_id, requested_brl_amount FROM pix_transactions WHERE depix_api_entry_id = $1 AND payment_status = $2',
                [qrId, 'PENDING']
            );

            if (rows.length === 0) {
                console.warn(`No PENDING transaction found for depix_api_entry_id (qrId): ${qrId}. Current webhook status: ${status}.`);
                return res.status(200).send('OK: Transaction not found in PENDING state or already processed.');
            }

            const transaction = rows[0];
            const ourTransactionId = transaction.transaction_id;
            const recipientTelegramUserId = transaction.user_id;
            const requestedAmountBRL = Number(transaction.requested_brl_amount).toFixed(2); 

            let newPaymentStatus;
            if (status === 'depix_sent') { newPaymentStatus = 'PAID'; }
            else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) { newPaymentStatus = 'FAILED'; }
            else if (['under_review', 'pending'].includes(status)) { console.log(`Webhook for qrId ${qrId} is still in a pending-like state: ${status}. No update.`); return res.status(200).send('OK: Status is still pending-like.'); }
            else { console.warn(`Unknown status '${status}' received in webhook for qrId ${qrId}.`); return res.status(200).send('OK: Unknown status received, acknowledged.');}
            
            if (newPaymentStatus === 'PAID' || newPaymentStatus === 'FAILED') {
                await dbPool.query( 'UPDATE pix_transactions SET payment_status = $1, depix_txid = $2, webhook_received_at = NOW(), updated_at = NOW() WHERE transaction_id = $3', [newPaymentStatus, blockchainTxID, ourTransactionId]);
                console.log(`Transaction ${ourTransactionId} updated to ${newPaymentStatus} with Liquid TxID ${blockchainTxID || 'N/A'}`);

                const botInstance = require('../app').getBotInstance(); 
                
                if (botInstance && recipientTelegramUserId) {
                    let userMessage = '';
                    if (newPaymentStatus === 'PAID') {
                        userMessage = `✅ Pagamento Pix de R\\$ ${escapeMarkdownV2(requestedAmountBRL)} confirmado\\!\n` +
                                      `Seus DePix foram enviados\\.\n`;
                        if (blockchainTxID) { userMessage += `ID da Transação Liquid: \`${escapeMarkdownV2(blockchainTxID)}\``; }
                        else { userMessage += `ID da Transação Liquid não fornecido no momento\\.`; }
                    } else { 
                        userMessage = `❌ Falha no pagamento Pix de R\\$ ${escapeMarkdownV2(requestedAmountBRL)}\\.\n` +
                                      `Status da API DePix: ${escapeMarkdownV2(status)}\\. Se o valor foi debitado, entre em contato com o suporte\\.`;
                    }
                    try {
                        console.log(`Attempting to send notification to ${recipientTelegramUserId}: "${userMessage.substring(0, 150)}..."`);
                        await botInstance.telegram.sendMessage(recipientTelegramUserId, userMessage, { parse_mode: 'MarkdownV2' });
                        console.log(`Notification SENT to user ${recipientTelegramUserId} for transaction ${ourTransactionId}`);

                        // ***** NOVA FUNCIONALIDADE: Mensagem de Feedback (se o pagamento foi um sucesso) *****
                        if (newPaymentStatus === 'PAID') {
                            const feedbackMessage = "Gostou da experiência? Conte para nós em nossa comunidade! Seu feedback é muito importante para o desenvolvimento do Atlas Bridge.";
                            const feedbackLink = "https://t.me/c/2573281169/3";
                            
                            setTimeout(async () => {
                                try {
                                    await botInstance.telegram.sendMessage(
                                        recipientTelegramUserId,
                                        feedbackMessage,
                                        Markup.inlineKeyboard([
                                            [Markup.button.url('Deixar Feedback na Comunidade', feedbackLink)]
                                        ])
                                    );
                                    console.log(`Feedback request sent to user ${recipientTelegramUserId}.`);
                                } catch (feedbackError) {
                                    console.error(`FAILED to send feedback request to user ${recipientTelegramUserId}. Error: ${feedbackError.message}`);
                                }
                            }, 2000); // Delay de 2 segundos
                        }

                    } catch (notifyError) {
                        console.error(`FAILED to send Telegram notification to user ${recipientTelegramUserId}. Error: ${notifyError.message}`);
                        if (notifyError.response && notifyError.on) {
                             console.error('[Webhook Notify TelegramError details]:', JSON.stringify({ 
                                response: notifyError.response, 
                                on: notifyError.on,
                                attempted_message_payload: { text: userMessage, parse_mode: 'MarkdownV2' } 
                            }, null, 2));
                        } else {
                            console.error(notifyError.stack);
                        }
                    }
                } else {
                    console.warn(`Notification NOT sent for transaction ${ourTransactionId}: botInstance or recipientTelegramUserId missing.`);
                }
            } else {
                 console.log(`No status change from PENDING for transaction ${ourTransactionId}. Current webhook status: ${status}`);
            }
            res.status(200).send('OK: Webhook processed.');
        } catch (dbError) {
            console.error('Error processing webhook (DB interaction or other logic):', dbError);
            res.status(500).send('Internal Server Error while processing webhook.');
        }
    });
    return router;
};
module.exports = { createWebhookRoutes };
