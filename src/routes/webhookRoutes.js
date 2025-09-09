const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { Markup } = require('telegraf');
const config = require('../core/config');
const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const securityService = require('../services/securityService');

const safeCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (e) { logger.error("Error in safeCompare:", e); return false; }
};

const processWebhook = async (webhookData, dbPool, bot, expectationQueue, expirationQueue) => {
    const { blockchainTxID, qrId, status, payerName, payerCpfCnpj } = webhookData;
    
    // Log dos dados do pagador se disponíveis
    if (payerName || payerCpfCnpj) {
        logger.info(`[Process] Payer info received - Name: ${payerName || 'N/A'}, CPF/CNPJ: ${payerCpfCnpj || 'N/A'}`);
    }

    try {
        const reminderJobId = `expectation-${qrId}`;
        const expirationJobId = `expiration-${qrId}`;
        const reminderJob = await expectationQueue.getJob(reminderJobId);
        if (reminderJob) { await reminderJob.remove(); logger.info(`[Process] Reminder job ${reminderJobId} removed.`); }
        const expirationJob = await expirationQueue.getJob(expirationJobId);
        if (expirationJob) { await expirationJob.remove(); logger.info(`[Process] Expiration job ${expirationJobId} removed.`); }
    } catch (queueError) { logger.error(`[Process] Error removing jobs for qrId ${qrId}:`, queueError); }

    // Primeiro verificar se é uma transação de verificação
    const verificationCheck = await dbPool.query(
        'SELECT verification_id, telegram_user_id, verification_status FROM verification_transactions WHERE depix_api_entry_id = $1',
        [qrId]
    );
    
    if (verificationCheck.rows.length > 0) {
        // É uma transação de verificação
        const verification = verificationCheck.rows[0];
        
        if (verification.verification_status !== 'PENDING') {
            logger.warn(`[Process] Verification ${verification.verification_id} already processed.`);
            return { success: true, message: 'Verification already processed.' };
        }
        
        if (status === 'depix_sent' && payerName && payerCpfCnpj) {
            // Processar verificação bem-sucedida
            const result = await securityService.processVerificationPayment(
                dbPool,
                qrId,
                payerName,
                payerCpfCnpj
            );
            
            if (result.success) {
                logger.info(`[Process] User ${result.userId} verified successfully with CPF/CNPJ: ${payerCpfCnpj}`);
                
                // Enviar mensagem de sucesso ao usuário
                try {
                    const successMessage = `✅ **Conta Validada com Sucesso\\!**\n\n` +
                                         `👤 Nome: ${escapeMarkdownV2(payerName)}\n` +
                                         `📝 CPF/CNPJ: ${escapeMarkdownV2(payerCpfCnpj)}\n` +
                                         `⭐ Nível: 1\n` +
                                         `💰 Limite Diário: R\\$ 50,00\n\n` +
                                         `🎁 Você receberá 0,01 DEPIX de recompensa em breve\\!\n\n` +
                                         `Agora você pode usar todas as funcionalidades do Bridge\\!`;
                    
                    await bot.telegram.sendMessage(result.userId, successMessage, { parse_mode: 'MarkdownV2' });
                } catch (e) {
                    logger.error(`[Process] Failed to send verification success message: ${e.message}`);
                }
            }
            
            return { success: true, message: 'Verification processed.' };
        } else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) {
            // Marcar verificação como falhada
            await dbPool.query(
                'UPDATE verification_transactions SET verification_status = $1, updated_at = NOW() WHERE depix_api_entry_id = $2',
                ['FAILED', qrId]
            );
            
            // Notificar usuário
            try {
                await bot.telegram.sendMessage(
                    verification.telegram_user_id,
                    '❌ Validação falhou. Por favor, tente novamente.',
                    { parse_mode: 'MarkdownV2' }
                );
            } catch (e) {
                logger.error(`[Process] Failed to send verification failure message: ${e.message}`);
            }
            
            return { success: true, message: 'Verification failed.' };
        }
        
        return { success: true, message: 'Verification status not terminal.' };
    }
    
    // Não é verificação, processar transação normal
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

    // Buscar informações do usuário para validação
    const userCheck = await dbPool.query(
        'SELECT payer_cpf_cnpj, is_verified FROM users WHERE telegram_user_id = $1',
        [recipientTelegramUserId]
    );
    
    const userInfo = userCheck.rows[0];
    let cpfCnpjValid = true;
    let refundReason = null;
    
    // Validar CPF/CNPJ se o usuário estiver verificado
    if (userInfo && userInfo.is_verified && userInfo.payer_cpf_cnpj && payerCpfCnpj) {
        if (userInfo.payer_cpf_cnpj !== payerCpfCnpj) {
            cpfCnpjValid = false;
            refundReason = 'CPF/CNPJ diferente do cadastrado';
            logger.warn(`[Process] CPF/CNPJ mismatch for user ${recipientTelegramUserId}. Expected: ${userInfo.payer_cpf_cnpj}, Got: ${payerCpfCnpj}`);
        }
    }
    
    let newPaymentStatus;
    if (status === 'depix_sent') {
        if (cpfCnpjValid) {
            newPaymentStatus = 'PAID';
            
            // Atualizar uso diário se o pagamento foi bem-sucedido
            await securityService.updateDailyUsage(dbPool, recipientTelegramUserId, requestedAmountBRL);
            
            // Verificar se pode subir de nível
            const upgradeCheck = await securityService.checkAndUpgradeReputation(dbPool, recipientTelegramUserId);
            if (upgradeCheck.upgraded) {
                // Notificar sobre o upgrade
                try {
                    const upgradeMessage = `🎉 **Parabéns\\!**\n\n` +
                                         `Você subiu para o **Nível ${upgradeCheck.newLevel}**\\!\n` +
                                         `Novo limite diário: **R\\$ ${upgradeCheck.newLimit}**`;
                    await bot.telegram.sendMessage(recipientTelegramUserId, upgradeMessage, { parse_mode: 'MarkdownV2' });
                } catch (e) {
                    logger.error(`[Process] Failed to send level upgrade message: ${e.message}`);
                }
            } else if (upgradeCheck.message && upgradeCheck.message.includes('horas')) {
                // Notificar sobre progresso para próximo nível
                try {
                    const progressMessage = `📈 **Progresso de Nível**\n\n` +
                                          `${escapeMarkdownV2(upgradeCheck.message)}`;
                    await bot.telegram.sendMessage(recipientTelegramUserId, progressMessage, { parse_mode: 'MarkdownV2' });
                } catch (e) {
                    logger.error(`[Process] Failed to send level progress message: ${e.message}`);
                }
            }
        } else {
            newPaymentStatus = 'REFUNDED';
            refundReason = refundReason || 'Validação de CPF/CNPJ falhou';
        }
    } else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) {
        newPaymentStatus = 'FAILED';
    } else {
        logger.warn(`[Process] Webhook for qrId ${qrId} has a non-terminal status: '${status}'.`);
        return { success: true, message: 'Non-terminal status received.' };
    }

    // Atualizar transação com informações do pagador
    await dbPool.query(
        `UPDATE pix_transactions 
        SET payment_status = $1, 
            depix_txid = $2, 
            actual_payer_cpf_cnpj = $3,
            actual_payer_name = $4,
            cpf_cnpj_match = $5,
            refund_status = $6,
            refund_reason = $7,
            webhook_received_at = NOW(), 
            updated_at = NOW() 
        WHERE transaction_id = $8`,
        [
            newPaymentStatus, 
            blockchainTxID, 
            payerCpfCnpj || null,
            payerName || null,
            cpfCnpjValid,
            newPaymentStatus === 'REFUNDED' ? 'PENDING' : null,
            refundReason,
            ourTransactionId
        ]
    );
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
    } else if (newPaymentStatus === 'REFUNDED') {
        userMessage = `⚠️ **Pagamento Reembolsado**\n\n` +
                    `O pagamento de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))} foi reembolsado\\.\n\n` +
                    `**Motivo:** ${escapeMarkdownV2(refundReason || 'CPF/CNPJ diferente do cadastrado')}\n\n` +
                    `⚠️ Você deve pagar sempre com o mesmo CPF/CNPJ cadastrado: **${escapeMarkdownV2(userInfo.payer_cpf_cnpj || 'N/A')}**\n\n` +
                    `Para receber de múltiplos CPF/CNPJ, entre em contato com o suporte para habilitar o modo comércio\\.`;
    } else {
        userMessage = `❌ Falha no pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\\.\nStatus da API DePix: ${escapeMarkdownV2(status)}\\. Se o valor foi debitado, entre em contato com o suporte\\.`;
    }

    try {
        await bot.telegram.sendMessage(recipientTelegramUserId, userMessage, { parse_mode: 'MarkdownV2' });
        logger.info(`[Process] Notification SENT to user ${recipientTelegramUserId} for transaction ${ourTransactionId}`);

        if (newPaymentStatus === 'PAID') {
            // Enviar menu principal após pagamento bem-sucedido
            setTimeout(async () => {
                try {
                    const mainMenuKeyboard = Markup.inlineKeyboard([
                        [Markup.button.callback('💸 Converter PIX em DePix', 'receive_pix_start')],
                        [Markup.button.callback('📊 Meu Status', 'user_status')],
                        [Markup.button.callback('💼 Minha Carteira', 'my_wallet')],
                        [Markup.button.callback('📈 Histórico', 'transaction_history')],
                        [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
                        [Markup.button.url('💬 Comunidade Atlas', 'https://t.me/+zVuRYh5nsdE2MTYx')]
                    ]);
                    
                    const menuMessage = `🎯 **Transação Concluída\\!**\n\n` +
                                      `O que deseja fazer agora?`;
                    
                    await bot.telegram.sendMessage(recipientTelegramUserId, menuMessage, {
                        parse_mode: 'MarkdownV2',
                        reply_markup: mainMenuKeyboard.reply_markup
                    });
                    logger.info(`[Process] Main menu sent to user ${recipientTelegramUserId}.`);
                } catch (menuError) {
                    logger.error(`[Process] Failed to send main menu: ${menuError.message}`);
                }
            }, 1500);
            
            const feedbackMessage = "Novidade: Se chegarmos a 150 pessoas em nossa comunidade do Telegram até ao final desse mês, traremos no Bot uma das funções mais pedidas por vocês. Entre e compartilhe";
            const feedbackLink = "https://t.me/+0PuiQpwJiEc1NTA5";
            
            setTimeout(async () => {
                try {
                    await bot.telegram.sendMessage(recipientTelegramUserId, feedbackMessage, Markup.inlineKeyboard([
                        [Markup.button.url('Entrar na Comunidade', feedbackLink)]
                    ]));
                    logger.info(`[Process] Donation request sent to user ${recipientTelegramUserId}.`);
                } catch (feedbackError) {
                    logger.error(`[Process] FAILED to send donation request to user ${recipientTelegramUserId}. Error: ${feedbackError.message}`);
                }
            }, 4000);
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