const express = require('express');
const config = require('../core/config');
const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const safeCompare = require('safe-compare');
const { Markup } = require('telegraf');
const securityService = require('../services/securityService');
const uxService = require('../services/userExperienceService');
const BountyService = require('../services/bountyService');

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
    const payerCpfCnpj = webhookData.payerTaxNumber || null;
    const payerName = webhookData.payerName || null;
    const euid = webhookData.euid || null;

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
                webhook_processed_count,
                contribution_fee_percent,
                contribution_amount_brl
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
            webhook_processed_count: processedCount,
            contribution_fee_percent: contributionFeePercent,
            contribution_amount_brl: contributionAmountBrl
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

        // Get user information for validation - usando EUID (não mais CPF)
        const userCheck = await client.query(
            'SELECT payer_cpf_cnpj, is_verified, euid FROM users WHERE telegram_user_id = $1',
            [recipientTelegramUserId]
        );

        const userInfo = userCheck.rows[0];
        let euidValid = true;
        let refundReason = null;

        // Validação por EUID (não mais por CPF - Eulen alterou regras de privacidade)
        if (userInfo && userInfo.euid && euid) {
            // Usuário tem EUID salvo - validar se bate com o webhook
            if (userInfo.euid !== euid) {
                euidValid = false;
                refundReason = `Conta diferente da cadastrada`;
                logger.warn(`[Process] EUID mismatch for user ${recipientTelegramUserId}. Expected: ${userInfo.euid}, Got: ${euid}`);
            }
        } else if (!userInfo || !userInfo.euid) {
            // Usuário NÃO tem EUID salvo - aceitar pagamento (primeira transação)
            // EUID será salvo após confirmação
            logger.info(`[Process] User ${recipientTelegramUserId} has no EUID saved - accepting payment without validation`);
        }

        // Determine new payment status
        let newPaymentStatus;
        if (status === 'depix_sent') {
            if (euidValid) {
                newPaymentStatus = 'CONFIRMED';
            } else {
                newPaymentStatus = 'REFUNDED';
                refundReason = refundReason || 'Conta diferente da cadastrada';
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
                euidValid,
                newPaymentStatus === 'REFUNDED' ? 'PENDING' : null,
                refundReason,
                ourTransactionId
            ]
        );

        // If payment confirmed, check for reputation upgrade and update streak
        // NOTE: User stats (daily_used_brl, total_volume_brl, completed_transactions) are updated
        // by the database trigger process_transaction_status() to avoid double-counting
        if (newPaymentStatus === 'CONFIRMED') {
            // Update daily streak
            const newStreak = await uxService.updateDailyStreak(client, recipientTelegramUserId);

            // Award XP based on transaction amount
            let xpReason = 'transaction_small';
            if (requestedAmountBRL >= 200) {
                xpReason = 'transaction_large';
            } else if (requestedAmountBRL >= 50) {
                xpReason = 'transaction_medium';
            }

            const xpResult = await uxService.awardXP(client, recipientTelegramUserId, requestedAmountBRL, xpReason);

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

            // Store streak and XP info for notifications
            webhookData.newStreak = newStreak;
            webhookData.xpResult = xpResult;

            // Store contribution info for notifications
            webhookData.contributionFeePercent = contributionFeePercent;
            webhookData.contributionAmountBrl = contributionAmountBrl;

            // Salvar EUID se vier no webhook e usuário ainda não tiver
            if (euid) {
                await client.query(
                    `UPDATE users
                    SET euid = $1, updated_at = NOW()
                    WHERE telegram_user_id = $2 AND (euid IS NULL OR euid = '')`,
                    [euid, recipientTelegramUserId]
                );
                logger.info(`[Process] EUID saved for user ${recipientTelegramUserId}: ${euid}`);
            }
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
            reminderMessageId,
            webhookData.newStreak,
            webhookData.xpResult,
            dbPool,
            webhookData.contributionFeePercent,
            webhookData.contributionAmountBrl
        );

        return { success: true, message: 'Webhook processed successfully.' };

    } catch (error) {
        // Rollback transaction on any error
        await client.query('ROLLBACK');

        // Enhanced error logging
        const errorDetails = {
            qrId,
            status,
            error: error.message,
            stack: error.stack,
            payerCpfCnpj,
            payerName,
            timestamp: new Date().toISOString()
        };

        // Log the error
        try {
            await client.query(
                `INSERT INTO transaction_processing_log (transaction_id, processing_stage, status, error_message, payload)
                VALUES ($1, $2, $3, $4, $5)`,
                [qrId, 'webhook_error', 'FAILED', error.message, JSON.stringify(errorDetails)]
            );
        } catch (logError) {
            logger.error(`[Process] Failed to log error to database:`, logError);
        }

        logger.error(`[Process] Error processing webhook for qrId ${qrId}:`, errorDetails);
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
    const { status, payerTaxNumber, payerName: webhookPayerName, euid } = webhookData;

    logger.info(`[ProcessVerification] Processing verification ${verification_id} with status ${status}, payer data: ${JSON.stringify({payerTaxNumber, payerName: webhookPayerName})}`);

    // Allow processing for EXPIRED/FAILED verifications if we receive a successful payment
    // Only reject if already COMPLETED
    if (verification_status === 'COMPLETED') {
        logger.info(`[Process] Verification ${verification_id} already completed successfully.`);
        return { success: true, message: 'Verification already completed.' };
    }

    // For EXPIRED or FAILED status, only process if we have a successful payment
    if ((verification_status === 'EXPIRED' || verification_status === 'FAILED') && status !== 'depix_sent') {
        logger.info(`[Process] Verification ${verification_id} is ${verification_status} and webhook status is ${status}. Skipping.`);
        return { success: true, message: 'Verification expired/failed, waiting for successful payment.' };
    }

    const client = await dbPool.connect();

    try {
        await client.query('BEGIN');

        // Accept depix_sent even without payer data for verification
        if (status === 'depix_sent') {
            // Get payer info if available
            const payerCpf = payerTaxNumber || null;
            const payerName = webhookPayerName || null;

            // Update user as verified and save EUID
            await client.query(
                `UPDATE users
                SET is_verified = true,
                    payer_cpf_cnpj = COALESCE($1, payer_cpf_cnpj),
                    payer_name = COALESCE($2, payer_name),
                    euid = COALESCE($4, euid),
                    verification_payment_date = NOW(),
                    verified_at = NOW(),
                    reputation_level = CASE WHEN reputation_level = 0 THEN 1 ELSE reputation_level END,
                    daily_limit_brl = CASE WHEN reputation_level = 0 THEN 50 ELSE daily_limit_brl END,
                    updated_at = NOW()
                WHERE telegram_user_id = $3`,
                [payerCpf, payerName, telegram_user_id, euid]
            );

            if (euid) {
                logger.info(`[ProcessVerification] EUID saved for user ${telegram_user_id}: ${euid}`);
            }

            // Update verification transaction
            await client.query(
                `UPDATE verification_transactions
                SET verification_status = 'COMPLETED',
                    payer_cpf_cnpj = COALESCE($1, payer_cpf_cnpj),
                    payer_name = COALESCE($2, payer_name),
                    verified_at = NOW(),
                    updated_at = NOW()
                WHERE verification_id = $3`,
                [payerCpf, payerName, verification_id]
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
    reminderMessageId,
    newStreak,
    xpResult,
    dbPool,
    contributionFeePercent,
    contributionAmountBrl
) => {
    if (!bot || !recipientTelegramUserId) {
        logger.error(`[Process] Cannot send notification: bot or userId missing.`);
        return;
    }

    // Constantes da competição
    const COMPETITION_ID = '2024-11-26_2024-12-26';

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
        // Get smart success message based on user achievements
        const successMessage = await uxService.getSuccessMessage(dbPool, recipientTelegramUserId, requestedAmountBRL);

        userMessage = `${escapeMarkdownV2(successMessage)}\n\n` +
            `💰 Valor: R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))}\n`;

        // Add XP and streak info if available
        if (xpResult && xpResult.xpAwarded) {
            userMessage += `⭐ \\+${xpResult.xpAwarded} XP ganhos\\!\n`;
            if (xpResult.leveledUp) {
                userMessage += `🎉 **Você subiu para o nível ${xpResult.newLevel}\\!**\n`;
            }
        }

        if (newStreak && newStreak > 1) {
            userMessage += `🔥 Sequência: ${newStreak} dias\\!\n`;
        }

        if (blockchainTxID) {
            userMessage += `\n🔗 Liquid TX: \`${escapeMarkdownV2(blockchainTxID)}\`\n`;
        }

        userMessage += `\nObrigado por usar o Atlas Bridge\\!`;

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

        // Update contribution ranking if user contributed
        if (contributionAmountBrl && parseFloat(contributionAmountBrl) > 0) {
            try {
                await dbPool.query(`
                    INSERT INTO contribution_ranking
                        (telegram_user_id, competition_id, total_contribution_brl, transaction_count)
                    VALUES ($1, $2, $3, 1)
                    ON CONFLICT (telegram_user_id, competition_id)
                    DO UPDATE SET
                        total_contribution_brl = contribution_ranking.total_contribution_brl + $3,
                        transaction_count = contribution_ranking.transaction_count + 1,
                        updated_at = NOW()
                `, [recipientTelegramUserId, COMPETITION_ID, parseFloat(contributionAmountBrl)]);

                logger.info(`[RANKING] Updated ranking for user ${recipientTelegramUserId}: +R$ ${contributionAmountBrl}`);
            } catch (rankingError) {
                logger.error(`[RANKING] Error updating ranking:`, rankingError);
            }
        }

        // Send contribution suggestion after 5 seconds (subtle)
        setTimeout(async () => {
            try {
                const currentFee = parseFloat(contributionFeePercent) || 0;
                const MAX_FEE = 20.00;

                // Don't suggest if already at max
                if (currentFee >= MAX_FEE) return;

                // Calculate options: +0.25% and +0.50% from current
                const option1 = parseFloat((currentFee + 0.25).toFixed(2));
                const option2 = parseFloat((currentFee + 0.50).toFixed(2));

                const options = [];
                if (option1 <= MAX_FEE) options.push(option1);
                if (option2 <= MAX_FEE) options.push(option2);

                if (options.length === 0) return;

                let suggestionMessage;
                if (currentFee === 0) {
                    suggestionMessage = `💝 *Quer apoiar a Atlas?*\n\n` +
                        `Sua contribuição voluntária ajuda a manter o serviço no ar e desenvolver ferramentas pró\\-liberdade\\.`;
                } else {
                    suggestionMessage = `💝 *Obrigado por apoiar a Atlas\\!*\n\n` +
                        `Quer alterar sua contribuição?`;
                }

                const keyboard = [];
                const optionButtons = options.map(f =>
                    Markup.button.callback(`${f.toFixed(2)}%`, `contribution_set:${f.toFixed(2)}`)
                );
                keyboard.push(optionButtons);
                keyboard.push([Markup.button.callback('Agora não', 'dismiss_contribution_suggestion')]);

                await bot.telegram.sendMessage(recipientTelegramUserId, suggestionMessage, {
                    parse_mode: 'MarkdownV2',
                    ...Markup.inlineKeyboard(keyboard)
                });

            } catch (suggestionError) {
                logger.error(`[CONTRIBUTION] Error sending suggestion:`, suggestionError);
            }
        }, 2000); // Send after 2 seconds

    } else if (newPaymentStatus === 'REFUNDED') {
        userMessage = `⚠️ **Pagamento será reembolsado**\n\n` +
            `O pagamento de R\\$ ${escapeMarkdownV2(Number(requestedAmountBRL).toFixed(2))} será reembolsado\\.\n\n` +
            `**Motivo:** ${escapeMarkdownV2(refundReason || 'Conta diferente da cadastrada')}\n\n` +
            `⚠️ Você deve pagar sempre com a mesma conta bancária da primeira transação\\.\n\n` +
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
const createWebhookRoutes = (bot, dbPool, expectationQueue, expirationQueue) => {
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
            logger.info(`[Router-${config.app.nodeEnv}] Webhook payload: ${JSON.stringify(req.body)}`);

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
                    // Process webhook directly
                    await processWebhook(webhookData, dbPool, bot, expectationQueue, expirationQueue);
                } catch (bgError) {
                    logger.error('[Router] Background processing error:', bgError);
                }
            });

        } catch (error) {
            logger.error(`[Router] Error handling webhook:`, error);
            res.status(500).send('Internal Server Error');
        }
    });

    // ==========================================
    // ATLAS WEBHOOK (for Bounties)
    // ==========================================
    router.post('/atlas', async (req, res) => {
        try {
            logger.info(`--- Atlas Webhook Received on [${config.app.nodeEnv}] from IP [${req.ip}] ---`);
            logger.info(`[Atlas Webhook] Payload: ${JSON.stringify(req.body)}`);

            // Validate webhook secret if present in headers
            const webhookSecret = req.headers['x-webhook-secret'];
            if (webhookSecret && !safeCompare(webhookSecret, config.atlas.webhookSecret)) {
                logger.warn('[Atlas Webhook] Invalid webhook secret');
                return res.status(401).send('Unauthorized');
            }

            const webhookData = req.body;

            // Atlas webhook format includes event type
            if (!webhookData.id) {
                logger.warn('[Atlas Webhook] Missing transaction ID');
                return res.status(400).send('Bad Request: Missing id');
            }

            // Respond immediately
            res.status(200).send('OK');

            // Process in background
            setImmediate(async () => {
                try {
                    const bountyService = new BountyService(dbPool, bot);
                    await bountyService.processAtlasWebhook(webhookData);
                } catch (bgError) {
                    logger.error('[Atlas Webhook] Background processing error:', bgError);
                }
            });

        } catch (error) {
            logger.error('[Atlas Webhook] Error:', error);
            res.status(500).send('Internal Server Error');
        }
    });

    router.get('/health', (req, res) => {
        res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    return router;
};


module.exports = { processWebhook, createWebhookRoutes };