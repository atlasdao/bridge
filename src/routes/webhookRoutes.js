const express = require('express');
const config = require('../core/config');
const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const safeCompare = require('safe-compare');
const axios = require('axios');
const { Markup } = require('telegraf');
const securityService = require('../services/securityService');

/**
 * Process webhook with proper transaction isolation and idempotency
 * @param {Object} webhookData - The webhook payload
 * @param {Object} dbPool - Database connection pool
 * @param {Object} bot - Telegram bot instance
 * @param {Object} expectationQueue - Queue for expectations
 * @param {Object} expirationQueue - Queue for expirations
 */
const processWebhook = async (webhookData, dbPool, bot, expectationQueue, expirationQueue) => {
    const { qrId, status } = webhookData;
    const blockchainTxID = webhookData.blockchainTxID || null;
    const payerCpfCnpj = webhookData.payer?.cpfCnpj || null;
    const payerName = webhookData.payer?.name || null;

    if (!qrId) {
        logger.error('[Process] Missing qrId in webhook data.');
        return { success: false, message: 'Missing qrId.' };
    }

    logger.info(`[Process] Processing webhook for qrId '${qrId}' with status '${status}'.`);

    // Check for verification transaction first
    const verificationCheck = await dbPool.query(
        'SELECT verification_id, telegram_user_id, verification_status FROM verification_transactions WHERE depix_api_entry_id = $1',
        [qrId]
    );

    if (verificationCheck.rows.length > 0) {
        return processVerificationWebhook(verificationCheck.rows[0], webhookData, dbPool, bot);
    }

    // Get database client for transaction
    const client = await dbPool.connect();

    try {
        // Begin transaction with SERIALIZABLE isolation level for maximum safety
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

        // Check for existing transaction and implement idempotency
        const { rows } = await client.query(
            `SELECT
                transaction_id,
                user_id,
                requested_brl_amount,
                qr_code_message_id,
                reminder_message_id,
                payment_status,
                webhook_processed_count
            FROM pix_transactions
            WHERE depix_api_entry_id = $1
            FOR UPDATE`, // Lock the row for this transaction
            [qrId]
        );

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            logger.warn(`[Process] No transaction found for qrId '${qrId}'.`);
            return { success: false, message: 'Transaction not found.' };
        }

        const transaction = rows[0];
        const {
            transaction_id: ourTransactionId,
            user_id: recipientTelegramUserId,
            requested_brl_amount: requestedAmountBRL,
            qr_code_message_id: qrMessageId,
            reminder_message_id: reminderMessageId,
            payment_status: currentStatus,
            webhook_processed_count: processedCount
        } = transaction;

        // Idempotency check - if already processed with same status, skip
        if (currentStatus !== 'PENDING') {
            // Check if this is a duplicate webhook
            if ((currentStatus === 'CONFIRMED' && status === 'depix_sent') ||
                (currentStatus === 'FAILED' && ['canceled', 'error', 'refunded', 'expired'].includes(status))) {
                await client.query('ROLLBACK');
                logger.info(`[Process] Transaction '${ourTransactionId}' already processed with status '${currentStatus}'. Ignoring duplicate webhook.`);
                return { success: true, message: 'Transaction already processed (idempotent).' };
            }

            // Different status - this might be a status update
            if (processedCount > 5) {
                await client.query('ROLLBACK');
                logger.warn(`[Process] Transaction '${ourTransactionId}' has been processed ${processedCount} times. Blocking further processing.`);
                return { success: false, message: 'Too many webhook attempts.' };
            }
        }

        // Get user information for validation - ALWAYS validate CPF/CNPJ regardless of verification status
        const userCheck = await client.query(
            'SELECT payer_cpf_cnpj, is_verified FROM users WHERE telegram_user_id = $1',
            [recipientTelegramUserId]
        );

        const userInfo = userCheck.rows[0];
        let cpfCnpjValid = true;
        let refundReason = null;

        // CRITICAL FIX: Always validate CPF/CNPJ if both are present, regardless of verification status
        if (userInfo && userInfo.payer_cpf_cnpj && payerCpfCnpj) {
            const normalizedExpected = userInfo.payer_cpf_cnpj.replace(/[^0-9]/g, '');
            const normalizedActual = payerCpfCnpj.replace(/[^0-9]/g, '');

            if (normalizedExpected !== normalizedActual) {
                cpfCnpjValid = false;
                refundReason = `CPF/CNPJ diferente do cadastrado. Esperado: ${userInfo.payer_cpf_cnpj}`;
                logger.warn(`[Process] CPF/CNPJ mismatch for user ${recipientTelegramUserId}. Expected: ${normalizedExpected}, Got: ${normalizedActual}`);
            }
        }

        // Determine new payment status
        let newPaymentStatus;
        if (status === 'depix_sent') {
            if (cpfCnpjValid) {
                newPaymentStatus = 'CONFIRMED';
            } else {
                newPaymentStatus = 'REFUNDED';
                refundReason = refundReason || 'Validação de CPF/CNPJ falhou';
            }
        } else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) {
            newPaymentStatus = 'FAILED';
        } else {
            await client.query('ROLLBACK');
            logger.warn(`[Process] Webhook for qrId ${qrId} has a non-terminal status: '${status}'.`);
            return { success: true, message: 'Non-terminal status received.' };
        }

        // Update transaction atomically
        await client.query(
            `UPDATE pix_transactions
            SET payment_status = $1,
                depix_txid = $2,
                actual_payer_cpf_cnpj = $3,
                actual_payer_name = $4,
                cpf_cnpj_match = $5,
                refund_status = $6,
                refund_reason = $7,
                webhook_received_at = NOW(),
                webhook_processed_count = webhook_processed_count + 1,
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

        // If payment confirmed, update user stats atomically within the same transaction
        if (newPaymentStatus === 'CONFIRMED') {
            // Update daily usage
            await client.query(
                `UPDATE users
                SET daily_used_brl = daily_used_brl + $1,
                    updated_at = NOW()
                WHERE telegram_user_id = $2`,
                [requestedAmountBRL, recipientTelegramUserId]
            );

            // Recalculate user stats
            await client.query(
                'SELECT recalculate_user_stats($1)',
                [recipientTelegramUserId]
            );

            // Check for reputation upgrade
            const upgradeResult = await client.query(
                'SELECT * FROM check_reputation_upgrade($1)',
                [recipientTelegramUserId]
            );

            // Log successful processing
            await client.query(
                `INSERT INTO transaction_processing_log (transaction_id, processing_stage, status)
                VALUES ($1, $2, $3)`,
                [ourTransactionId, 'webhook_processed', newPaymentStatus]
            );
        }

        // Commit the transaction - all operations succeed or all fail
        await client.query('COMMIT');

        logger.info(`[Process] Transaction ${ourTransactionId} updated from PENDING to ${newPaymentStatus}`);

        // Send notifications (outside of database transaction)
        await sendNotifications(
            bot,
            recipientTelegramUserId,
            newPaymentStatus,
            requestedAmountBRL,
            blockchainTxID,
            status,
            refundReason,
            userInfo,
            qrMessageId,
            reminderMessageId
        );

        return { success: true, message: 'Webhook processed successfully.' };

    } catch (error) {
        // Rollback transaction on any error
        await client.query('ROLLBACK');

        // Log the error
        await client.query(
            `INSERT INTO transaction_processing_log (transaction_id, processing_stage, status, error_message)
            VALUES ($1, $2, $3, $4)`,
            [qrId, 'webhook_error', 'FAILED', error.message]
        );

        logger.error(`[Process] Error processing webhook for qrId ${qrId}:`, error);
        throw error;

    } finally {
        // Always release the client back to the pool
        client.release();
    }
};

/**
 * Process verification webhook
 */
const processVerificationWebhook = async (verification, webhookData, dbPool, bot) => {
    const { verification_id, telegram_user_id, verification_status } = verification;
    const { status, payer } = webhookData;

    if (verification_status !== 'PENDING') {
        logger.info(`[Process] Verification ${verification_id} already processed.`);
        return { success: true, message: 'Verification already processed.' };
    }

    const client = await dbPool.connect();

    try {
        await client.query('BEGIN');

        if (status === 'depix_sent' && payer?.cpfCnpj) {
            // Update user as verified
            await client.query(
                `UPDATE users
                SET is_verified = true,
                    payer_cpf_cnpj = $1,
                    payer_name = $2,
                    verification_date = NOW(),
                    updated_at = NOW()
                WHERE telegram_user_id = $3`,
                [payer.cpfCnpj, payer.name || null, telegram_user_id]
            );

            // Update verification transaction
            await client.query(
                `UPDATE verification_transactions
                SET verification_status = 'COMPLETED',
                    payer_cpf_cnpj = $1,
                    payer_name = $2,
                    updated_at = NOW()
                WHERE verification_id = $3`,
                [payer.cpfCnpj, payer.name || null, verification_id]
            );

            await client.query('COMMIT');

            // Send success notification
            if (bot) {
                try {
                    const successMessage = `✅ **Verificação Concluída\\!**\n\n` +
                        `Seu CPF/CNPJ foi validado com sucesso\\.\n` +
                        `Agora você pode fazer transações com seu limite diário\\!`;

                    await bot.telegram.sendMessage(telegram_user_id, successMessage, {
                        parse_mode: 'MarkdownV2'
                    });
                } catch (e) {
                    logger.error(`[Process] Failed to send verification success message: ${e.message}`);
                }
            }

        } else if (['canceled', 'error', 'refunded', 'expired'].includes(status)) {
            // Mark verification as failed
            await client.query(
                `UPDATE verification_transactions
                SET verification_status = 'FAILED',
                    updated_at = NOW()
                WHERE verification_id = $1`,
                [verification_id]
            );

            await client.query('COMMIT');

            // Send failure notification
            if (bot) {
                try {
                    await bot.telegram.sendMessage(
                        telegram_user_id,
                        '❌ Verificação falhou. Por favor, tente novamente.',
                        { parse_mode: 'MarkdownV2' }
                    );
                } catch (e) {
                    logger.error(`[Process] Failed to send verification failure message: ${e.message}`);
                }
            }
        }

        return { success: true, message: 'Verification processed.' };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`[Process] Error processing verification webhook:`, error);
        throw error;
    } finally {
        client.release();
    }
};

/**
 * Send notifications to user (separated from database transaction)
 */
const sendNotifications = async (
    bot,
    recipientTelegramUserId,
    newPaymentStatus,
    requestedAmountBRL,
    blockchainTxID,
    status,
    refundReason,
    userInfo,
    qrMessageId,
    reminderMessageId
) => {
    if (!bot || !recipientTelegramUserId) {
        logger.error(`[Process] Cannot send notification: bot or userId missing.`);
        return;
    }

    // Delete old messages
    if (qrMessageId) {
        try {
            await bot.telegram.deleteMessage(recipientTelegramUserId, qrMessageId);
            logger.info(`[Process] Deleted QR message ${qrMessageId}`);
        } catch (e) {
            logger.error(`[Process] Failed to delete QR message: ${e.message}`);
        }
    }

    if (reminderMessageId) {
        try {
            await bot.telegram.deleteMessage(recipientTelegramUserId, reminderMessageId);
            logger.info(`[Process] Deleted reminder message ${reminderMessageId}`);
        } catch (e) {
            logger.error(`[Process] Failed to delete reminder message: ${e.message}`);
        }
    }

    // Prepare user message
    let userMessage;
    if (newPaymentStatus === 'CONFIRMED') {
        userMessage = `✅ **Transação Concluída\\!**\n\n` +
            `💰 Valor: R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\n`;
        if (blockchainTxID) {
            userMessage += `🔗 Liquid TX: \`${escapeMarkdownV2(blockchainTxID)}\`\n\n`;
        }
        userMessage += `Obrigado por usar o Atlas Bridge\\!`;

        // Send with menu
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

    } else if (newPaymentStatus === 'REFUNDED') {
        userMessage = `⚠️ **Pagamento será reembolsado**\n\n` +
            `O pagamento de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))} será reembolsado\\.\n\n` +
            `**Motivo:** ${escapeMarkdownV2(refundReason || 'CPF/CNPJ diferente do cadastrado')}\n\n` +
            `⚠️ Você deve pagar sempre com o mesmo CPF/CNPJ cadastrado: **${escapeMarkdownV2(userInfo?.payer_cpf_cnpj || 'N/A')}**\n\n` +
            `O valor retornará à sua conta em até 24 horas\\.`;

        await bot.telegram.sendMessage(recipientTelegramUserId, userMessage, {
            parse_mode: 'MarkdownV2'
        });

    } else {
        userMessage = `❌ Falha no pagamento Pix de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\\.\n` +
            `Status: ${escapeMarkdownV2(status)}\\.\n` +
            `Se o valor foi debitado, entre em contato com o suporte\\.`;

        await bot.telegram.sendMessage(recipientTelegramUserId, userMessage, {
            parse_mode: 'MarkdownV2'
        });
    }

    logger.info(`[Process] Notification sent to user ${recipientTelegramUserId}`);
};

/**
 * Create webhook routes with proper error handling
 */
const createWebhookRoutes = (bot, dbPool, devDbPool, expectationQueue, expirationQueue) => {
    const router = express.Router();

    router.post('/depix_payment', async (req, res) => {
        try {
            logger.info(`--- Webhook Request Received on [${config.app.nodeEnv}] from IP [${req.ip}] ---`);

            // Validate authorization
            if (!req.headers.authorization ||
                !req.headers.authorization.startsWith('Basic ') ||
                !safeCompare(req.headers.authorization.substring(6), config.depix.webhookSecret)) {
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

            // Respond immediately to prevent timeout
            res.status(200).send('OK');

            // Process in background
            setImmediate(async () => {
                try {
                    // Check if this webhook belongs to this environment
                    if (config.app.nodeEnv === 'production') {
                        const shouldProcess = await checkWebhookOwnership(qrId, dbPool, devDbPool);

                        if (shouldProcess === 'production') {
                            await processWebhook(webhookData, dbPool, bot, expectationQueue, expirationQueue);
                        } else if (shouldProcess === 'development' && devDbPool) {
                            // Forward to development
                            await forwardWebhook(webhookData, req.headers.authorization);
                        }
                    } else {
                        // Development environment - just process
                        await processWebhook(webhookData, dbPool, bot, expectationQueue, expirationQueue);
                    }
                } catch (bgError) {
                    logger.error('[Router] Background processing error:', bgError);
                }
            });

        } catch (error) {
            logger.error(`[Router] Error handling webhook:`, error);
            res.status(500).send('Internal Server Error');
        }
    });

    router.get('/health', (req, res) => {
        res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    return router;
};

/**
 * Check which environment owns this webhook
 */
const checkWebhookOwnership = async (qrId, dbPool, devDbPool) => {
    // Check production database
    const { rows: pixRows } = await dbPool.query(
        'SELECT 1 FROM pix_transactions WHERE depix_api_entry_id = $1',
        [qrId]
    );

    const { rows: verificationRows } = await dbPool.query(
        'SELECT 1 FROM verification_transactions WHERE depix_api_entry_id = $1',
        [qrId]
    );

    if (pixRows.length > 0 || verificationRows.length > 0) {
        return 'production';
    }

    // Check development database if configured
    if (devDbPool) {
        const { rows: devPixRows } = await devDbPool.query(
            'SELECT 1 FROM pix_transactions WHERE depix_api_entry_id = $1',
            [qrId]
        );

        const { rows: devVerificationRows } = await devDbPool.query(
            'SELECT 1 FROM verification_transactions WHERE depix_api_entry_id = $1',
            [qrId]
        );

        if (devPixRows.length > 0 || devVerificationRows.length > 0) {
            return 'development';
        }
    }

    return null;
};

/**
 * Forward webhook to development server
 */
const forwardWebhook = async (webhookData, authorization) => {
    try {
        await axios.post(
            `${config.developmentServerUrl}/webhooks/depix_payment`,
            webhookData,
            {
                headers: { 'Authorization': authorization },
                timeout: 10000
            }
        );
        logger.info(`[Router] Webhook forwarded successfully.`);
    } catch (error) {
        logger.error(`[Router] Failed to forward webhook:`, error.message);
    }
};

module.exports = { processWebhook, createWebhookRoutes };