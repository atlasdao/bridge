const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { Markup } = require('telegraf');
const config = require('../core/config');
const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const securityService = require('../services/securityService');
const LogSanitizer = require('../utils/logSanitizer');

const secureLogger = LogSanitizer.createSecureLogger();

const safeCompare = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (e) { logger.error("Error in safeCompare:", e); return false; }
};

const processWebhook = async (webhookData, dbPool, bot, expectationQueue, expirationQueue) => {
    // Log sanitizado dos dados recebidos
    secureLogger.info(`[Process] Webhook data received:`, webhookData);
    
    // DePix envia o CPF/CNPJ como payerTaxNumber
    const { blockchainTxID, qrId, status, payerName, payerTaxNumber } = webhookData;
    const payerCpfCnpj = payerTaxNumber; // Mapear para o nome esperado
    
    // Log sanitizado dos dados do pagador
    if (payerName || payerCpfCnpj) {
        secureLogger.info(`[Process] Payer info received`, {
            payerName: payerName || 'N/A',
            payerCpfCnpj: payerCpfCnpj || 'N/A'
        });
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
        
        // Log para debug - verificar campos recebidos
        logger.info(`[Process] Verification webhook - Status: ${status}, Has payerName: ${!!payerName}, Has payerCpfCnpj: ${!!payerCpfCnpj}`);
        
        // Verificar se pagamento foi confirmado e tem os dados necessários
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
                                         `⭐ Nível: 1\n` +
                                         `💰 Limite Diário: R\\$ 50,00\n\n` +
                                         `📈 Você pode aumentar seu limite diário conforme sobe de nível\\.\n` +
                                         `No Nível 10, o limite é de R\\$ 6\\.020,00 por dia\\!\n\n` +
                                         `Agora você pode usar todas as funcionalidades do Bridge\\!`;

                    await bot.telegram.sendMessage(result.userId, successMessage, { parse_mode: 'MarkdownV2' });
                    
                    // Enviar menu principal imediatamente
                    const mainMenuKeyboard = Markup.inlineKeyboard([
                        [Markup.button.callback('💸 Comprar Depix Liquid', 'receive_pix_start')],
                        [Markup.button.callback('📊 Meu Status', 'user_status')],
                        [Markup.button.callback('💼 Minha Carteira', 'my_wallet')],
                        [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
                        [Markup.button.url('💬 Comunidade Atlas', 'https://t.me/+zVuRYh5nsdE2MTYx')]
                    ]);
                    
                    const menuMessage = `🎯 **Menu Principal**\n\n` +
                                      `O que deseja fazer?`;
                    
                    await bot.telegram.sendMessage(result.userId, menuMessage, {
                        parse_mode: 'MarkdownV2',
                        reply_markup: mainMenuKeyboard.reply_markup
                    });
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
        userMessage = `✅ **Transação Concluída\\!**\n\n` +
                     `💰 Valor: R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\n`;
        if (blockchainTxID) userMessage += `🔗 Liquid TX: \`${escapeMarkdownV2(blockchainTxID)}\`\n\n`;
        userMessage += `Obrigado por usar o Atlas Bridge\\!`;
    } else if (newPaymentStatus === 'REFUNDED') {
        userMessage = `⚠️ **Pagamento será reembolsado**\n\n` +
                    `O pagamento de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))} será reembolsado\\.\n\n` +
                    `**Motivo:** ${escapeMarkdownV2(refundReason || 'CPF/CNPJ diferente do cadastrado')}\n\n` +
                    `⚠️ Você deve pagar sempre com o mesmo CPF/CNPJ cadastrado: **${escapeMarkdownV2(userInfo.payer_cpf_cnpj || 'N/A')}**\n\n` +
                    `O valor retornará à sua conta em até 24 horas\\.`;
    } else {
        userMessage = `❌ Falha no pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\\.\nStatus da API DePix: ${escapeMarkdownV2(status)}\\. Se o valor foi debitado, entre em contato com o suporte\\.`;
    }

    try {
        // Se o pagamento foi confirmado, enviar com o menu principal
        if (newPaymentStatus === 'PAID') {
            const mainMenuKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💸 Comprar Depix Liquid', 'receive_pix_start')],
                [Markup.button.callback('📊 Meu Status', 'user_status')],
                [Markup.button.callback('💼 Minha Carteira', 'my_wallet')],
                [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
                [Markup.button.url('💬 Comunidade Atlas', 'https://t.me/+zVuRYh5nsdE2MTYx')]
            ]);

            await bot.telegram.sendMessage(recipientTelegramUserId, userMessage, {
                parse_mode: 'MarkdownV2',
                reply_markup: mainMenuKeyboard.reply_markup
            });
        } else {
            // Para outros status, enviar sem menu
            await bot.telegram.sendMessage(recipientTelegramUserId, userMessage, { parse_mode: 'MarkdownV2' });
        }

        logger.info(`[Process] Notification SENT to user ${recipientTelegramUserId} for transaction ${ourTransactionId}`);

        if (newPaymentStatus === 'PAID') {
            // Verificar progresso para próximo nível e enviar mensagem motivacional
            const userLevel = await dbPool.query(
                'SELECT reputation_level FROM users WHERE telegram_id = $1',
                [recipientTelegramUserId]
            );

            if (userLevel.rows.length > 0 && userLevel.rows[0].reputation_level < 10) {
                const currentLevel = userLevel.rows[0].reputation_level;
                const nextLevelData = await dbPool.query(
                    'SELECT * FROM reputation_levels_config WHERE level = $1',
                    [currentLevel + 1]
                );

                if (nextLevelData.rows.length > 0) {
                    const nextLevel = nextLevelData.rows[0];

                    // Buscar estatísticas atualizadas do usuário
                    const userStatsQuery = await dbPool.query(
                        `SELECT
                            COUNT(*) as transaction_count,
                            COALESCE(SUM(requested_brl_amount), 0) as total_volume
                         FROM pix_transactions
                         WHERE user_id = $1 AND payment_status IN ('PAID', 'CONFIRMED')`,
                        [recipientTelegramUserId]
                    );

                    const userStats = userStatsQuery.rows[0];
                    const currentTxCount = parseInt(userStats.transaction_count);
                    const currentVolume = parseFloat(userStats.total_volume);

                    // Calcular progresso percentual
                    const txProgress = (currentTxCount / nextLevel.min_transactions_for_upgrade) * 100;
                    const volumeProgress = (currentVolume / nextLevel.min_volume_for_upgrade) * 100;

                    // Se está próximo de subir de nível (>70% em qualquer critério)
                    if (txProgress >= 70 || volumeProgress >= 70) {
                        const txNeeded = Math.max(0, nextLevel.min_transactions_for_upgrade - currentTxCount);
                        const volumeNeeded = Math.max(0, nextLevel.min_volume_for_upgrade - currentVolume);

                        let levelUpMessage = '';

                        // Determinar qual está mais próximo
                        if (txProgress >= volumeProgress && txNeeded > 0) {
                            levelUpMessage = `🚀 **Falta apenas ${txNeeded} transação${txNeeded > 1 ? '\\(ões\\)' : ''} para o Nível ${currentLevel + 1}\\!**\n` +
                                           `💰 Novo limite: R\\$ ${escapeMarkdownV2(Number(nextLevel.daily_limit_brl).toFixed(2))}/dia`;
                        } else if (volumeNeeded > 0) {
                            levelUpMessage = `🚀 **Falta apenas R\\$ ${escapeMarkdownV2(volumeNeeded.toFixed(2))} em volume para o Nível ${currentLevel + 1}\\!**\n` +
                                           `💰 Novo limite: R\\$ ${escapeMarkdownV2(Number(nextLevel.daily_limit_brl).toFixed(2))}/dia`;
                        }

                        if (levelUpMessage) {
                            // Enviar mensagem motivacional separada após 1 segundo
                            setTimeout(async () => {
                                try {
                                    await bot.telegram.sendMessage(recipientTelegramUserId, levelUpMessage, { parse_mode: 'MarkdownV2' });
                                    logger.info(`[Process] Level up motivation sent to user ${recipientTelegramUserId}.`);
                                } catch (levelError) {
                                    logger.error(`[Process] Failed to send level up message: ${levelError.message}`);
                                }
                            }, 1000);
                        }
                    }
                }
            }

            // Enviar mensagem de feedback após alguns segundos
            const feedbackMessage = "Ajude a Atlas a crescer e manter um serviço competitivo! Avalie nosso serviço em https://trustscore.space/reviews.html - sua opinião é muito importante para nós.";

            setTimeout(async () => {
                try {
                    await bot.telegram.sendMessage(recipientTelegramUserId, feedbackMessage);
                    logger.info(`[Process] Feedback request sent to user ${recipientTelegramUserId}.`);
                } catch (feedbackError) {
                    logger.error(`[Process] FAILED to send feedback request to user ${recipientTelegramUserId}. Error: ${feedbackError.message}`);
                }
            }, 3000);
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
            if (!qrId) {
                logger.warn(`[Router-${config.app.nodeEnv}] Missing qrId in webhook data.`);
                return res.status(400).send('Bad Request: Missing qrId.');
            }

            if (config.app.nodeEnv === 'production') {
                // Verificar em ambas as tabelas: pix_transactions e verification_transactions
                const { rows: pixRows } = await dbPool.query('SELECT 1 FROM pix_transactions WHERE depix_api_entry_id = $1', [qrId]);
                const { rows: verificationRows } = await dbPool.query('SELECT 1 FROM verification_transactions WHERE depix_api_entry_id = $1', [qrId]);
                
                if (pixRows.length > 0 || verificationRows.length > 0) {
                    logger.info(`[Router-Prod] Webhook for qrId '${qrId}' found in PROD DB (${pixRows.length > 0 ? 'pix_transactions' : 'verification_transactions'}). Processing in background.`);
                    
                    // Responder imediatamente para evitar timeout
                    res.status(200).send('OK');
                    
                    // Processar em background
                    setImmediate(async () => {
                        try {
                            await processWebhook(webhookData, dbPool, bot, expectationQueue, expirationQueue);
                        } catch (bgError) {
                            logger.error('[Router-Prod] Background processing error:', bgError);
                        }
                    });
                    return;
                }

                if (!devDbPool) {
                    logger.warn(`[Router-Prod] Webhook for unknown qrId '${qrId}' received, but DEV DB is not configured for forwarding. Discarding.`);
                    return res.status(404).send('Transaction not found in production.');
                }

                const { rows: devPixRows } = await devDbPool.query('SELECT 1 FROM pix_transactions WHERE depix_api_entry_id = $1', [qrId]);
                const { rows: devVerificationRows } = await devDbPool.query('SELECT 1 FROM verification_transactions WHERE depix_api_entry_id = $1', [qrId]);
                
                if (devPixRows.length > 0 || devVerificationRows.length > 0) {
                    logger.warn(`[Router-Prod] Webhook for qrId '${qrId}' NOT in PROD, found in DEV. Forwarding to dev in background.`);
                    
                    // Responder imediatamente
                    res.status(200).send('OK');
                    
                    // Fazer forward em background
                    setImmediate(async () => {
                        try {
                            await axios.post(`${config.developmentServerUrl}/webhooks/depix_payment`, webhookData, { 
                                headers: { 'Authorization': req.headers.authorization },
                                timeout: 10000 // timeout de 10 segundos para o forward
                            });
                            logger.info(`[Router-Prod] Webhook for qrId '${qrId}' forwarded successfully.`);
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
                        }
                    });
                    return;
                }

                logger.warn(`[Router-Prod] Webhook for qrId '${qrId}' not found in PROD or DEV databases. Discarding.`);
                return res.status(404).send('Transaction not found in any environment.');
            } else {
                logger.info(`[Router-Dev] Webhook received in DEV environment. Processing in background.`);
                
                // Responder imediatamente
                res.status(200).send('OK');
                
                // Processar em background
                setImmediate(async () => {
                    try {
                        await processWebhook(webhookData, dbPool, bot, expectationQueue, expirationQueue);
                    } catch (bgError) {
                        logger.error('[Router-Dev] Background processing error:', bgError);
                    }
                });
                return;
            }
        } catch (error) {
            logger.error('[Router] FATAL ERROR in webhook router logic:', error);
            if (!res.headersSent) res.status(500).send('Internal Server Error');
        }
    });
    return router;
};
module.exports = { createWebhookRoutes };