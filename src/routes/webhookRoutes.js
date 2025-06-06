const express = require('express');
const crypto = require('crypto');
const config = require('../core/config');
const { QUEUE_NAME } = require('../queues/expectationMessageQueue');
// Importar a função de escape do módulo handlers
const { escapeMarkdownV2 } = require('../bot/handlers');

const safeCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    try {
        const bufA = Buffer.from(a);
        const bufB = Buffer.from(b);
        if (bufA.length !== bufB.length) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) { console.error("Error in safeCompare:", e); return false; }
};

const createWebhookRoutes = (dbPool, expectationMessageQueue) => {
    const router = express.Router();

    router.post('/depix_payment', async (req, res) => {
        console.log('Received DePix Webhook POST request.');
        const relevantHeaders = { /* ... */ }; // como antes
        console.log('Webhook Headers (Relevant):', JSON.stringify(relevantHeaders, null, 2));
        console.log('Webhook Body:', JSON.stringify(req.body, null, 2));

        const authHeader = req.headers.authorization;
        let authorized = false;

        if (authHeader && authHeader.startsWith('Basic ')) {
            const providedSecret = authHeader.substring(6); 
            if (providedSecret && config.depix.webhookSecret && safeCompare(providedSecret, config.depix.webhookSecret)) {
                authorized = true;
            } else { /* ... logs de erro ... */ }
        } else { /* ... logs de erro ... */ }

        if (!authorized) {
            console.warn('WEBHOOK AUTHORIZATION FAILED.');
            return res.status(401).send('Unauthorized: Invalid or missing secret.');
        }
        console.log('Webhook authorized successfully.');

        const webhookData = req.body;
        const { blockchainTxID, qrId, status, valueInCents } = webhookData;

        if (!qrId || !status) { /* ... tratamento de erro ... */ }
        
        const jobToRemoveId = `expectation-${qrId}`;
        try {
            const job = await expectationMessageQueue.getJob(jobToRemoveId);
            if (job) {
                await job.remove();
                console.log(`Expectation message job ${jobToRemoveId} removed for qrId ${qrId}.`);
            } else { /* ... log ... */ }
        } catch (queueError) { /* ... log ... */ }

        console.log(`Processing webhook for qrId: ${qrId}, status: ${status}, valueInCents: ${valueInCents}, blockchainTxID: ${blockchainTxID || 'N/A'}`);

        try {
            const { rows } = await dbPool.query( /* ... query ... */ );
            if (rows.length === 0) { /* ... tratamento ... */ }

            const transaction = rows[0];
            const ourTransactionId = transaction.transaction_id;
            const recipientTelegramUserId = transaction.user_id;
            const requestedAmountBRL = Number(transaction.requested_brl_amount).toFixed(2); 

            let newPaymentStatus;
            // ... lógica de newPaymentStatus ...
            if (status === 'depix_sent') newPaymentStatus = 'PAID';
            else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) newPaymentStatus = 'FAILED';
            else if (['under_review', 'pending'].includes(status)) { /* ... tratamento ... */ return res.status(200).send('OK');}
            else { /* ... tratamento ... */ return res.status(200).send('OK'); }
            
            if (newPaymentStatus === 'PAID' || newPaymentStatus === 'FAILED') {
                await dbPool.query( /* ... update query ... */ );
                console.log(`Transaction ${ourTransactionId} updated to ${newPaymentStatus} ...`);

                const botInstance = require('../app').getBotInstance(); 
                // Usar escapeMarkdownV2 importado
                if (botInstance && recipientTelegramUserId) {
                    let userMessage = '';
                    if (newPaymentStatus === 'PAID') {
                        userMessage = `✅ Pagamento Pix de R\\$ ${escapeMarkdownV2(requestedAmountBRL)} confirmado\\!\n` +
                                      `Seus DePix foram enviados\\.\n`;
                        if (blockchainTxID) {
                            userMessage += `ID da Transação Liquid: \`${escapeMarkdownV2(blockchainTxID)}\``;
                        } else { userMessage += `ID da Transação Liquid não fornecido no momento\\.`; }
                    } else { 
                        userMessage = `❌ Falha no pagamento Pix de R\\$ ${escapeMarkdownV2(requestedAmountBRL)}\\.\n` +
                                      `Status da API DePix: ${escapeMarkdownV2(status)}\\. Se o valor foi debitado, entre em contato com o suporte\\.`;
                    }
                    try {
                        await botInstance.telegram.sendMessage(recipientTelegramUserId, userMessage, { parse_mode: 'MarkdownV2' });
                        console.log(`Notification sent to user ${recipientTelegramUserId} ...`);
                    } catch (notifyError) { /* ... log ... */ }
                }
            } else { /* ... log ... */ }
            res.status(200).send('OK: Webhook processed.');
        } catch (dbError) { /* ... tratamento de erro ... */ }
    });
    return router;
};
module.exports = { createWebhookRoutes };
