/**
 * Bounty Service
 *
 * Handles all bounty-related business logic:
 * - Creating and managing bounties
 * - Processing votes/payments (PIX and Liquid)
 * - Admin moderation (approve/reject/remove)
 * - Developer claims
 * - Webhook processing
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const logger = require('../core/logger');
const config = require('../core/config');
const atlasApiService = require('./atlasApiService');

const execFileAsync = promisify(execFile);
const LWK_SCRIPT_PATH = path.join(__dirname, '../../scripts/lwk_address.py');

// Asset IDs on Liquid Network
const ASSET_IDS = {
    LBTC: '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d',
    DEPIX: '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189',
    USDT: 'ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2'
};

class BountyService {
    constructor(dbPool, bot = null) {
        this.dbPool = dbPool;
        this.bot = bot;
    }

    /**
     * Set bot instance (for sending notifications)
     */
    setBot(bot) {
        this.bot = bot;
    }

    // ==========================================
    // BOUNTY CRUD OPERATIONS
    // ==========================================

    /**
     * Create a new bounty (pending review)
     * @param {Object} params - Bounty parameters
     * @param {string} params.title - Bounty title
     * @param {string} params.description - Bounty description
     * @param {number} params.createdByTelegramId - Creator's Telegram ID
     * @param {string} params.createdByUsername - Creator's username
     */
    async createBounty({ title, description, createdByTelegramId, createdByUsername }) {
        const client = await this.dbPool.connect();
        try {
            await client.query('BEGIN');

            const result = await client.query(`
                INSERT INTO bounty_features (
                    title, short_description, detailed_description,
                    creator_telegram_id, creator_username,
                    status, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, 'pending_review', NOW(), NOW())
                RETURNING *
            `, [title, description, description, createdByTelegramId, createdByUsername]);

            await client.query('COMMIT');

            const bounty = result.rows[0];
            logger.info(`[Bounty] Created bounty #${bounty.id} by @${createdByUsername}`);

            // Notify admins
            await this.notifyAdmins('new_bounty', bounty);

            return bounty;
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error(`[Bounty] Error creating bounty: ${error.message}`);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get bounty by ID
     */
    async getBountyById(bountyId) {
        const result = await this.dbPool.query(
            'SELECT * FROM bounty_features WHERE id = $1',
            [bountyId]
        );
        return result.rows[0] || null;
    }

    /**
     * List bounties by status
     */
    async listBounties(status = 'approved', limit = 20, offset = 0) {
        const result = await this.dbPool.query(`
            SELECT * FROM bounty_features
            WHERE status = $1
            ORDER BY ranking ASC, total_brl DESC, created_at ASC
            LIMIT $2 OFFSET $3
        `, [status, limit, offset]);
        return result.rows;
    }

    /**
     * Count bounties by status
     */
    async countBounties(status) {
        const result = await this.dbPool.query(
            'SELECT COUNT(*) as count FROM bounty_features WHERE status = $1',
            [status]
        );
        return parseInt(result.rows[0].count);
    }

    /**
     * Get all bounty stats
     */
    async getBountyStats() {
        const result = await this.dbPool.query(`
            SELECT
                status,
                COUNT(*) as count,
                COALESCE(SUM(total_brl), 0) as total_brl,
                COALESCE(SUM(vote_count), 0) as vote_count
            FROM bounty_features
            GROUP BY status
        `);

        const stats = {
            pending_review: { count: 0, total_brl: 0, vote_count: 0 },
            approved: { count: 0, total_brl: 0, vote_count: 0 },
            taken: { count: 0, total_brl: 0, vote_count: 0 },
            in_development: { count: 0, total_brl: 0, vote_count: 0 },
            completed: { count: 0, total_brl: 0, vote_count: 0 },
            paid: { count: 0, total_brl: 0, vote_count: 0 },
            rejected: { count: 0, total_brl: 0, vote_count: 0 }
        };

        for (const row of result.rows) {
            stats[row.status] = {
                count: parseInt(row.count),
                total_brl: parseFloat(row.total_brl),
                vote_count: parseInt(row.vote_count)
            };
        }

        return stats;
    }

    // ==========================================
    // ADMIN MODERATION
    // ==========================================

    /**
     * Approve a pending bounty
     */
    async approveBounty(bountyId, adminId) {
        const result = await this.dbPool.query(`
            UPDATE bounty_features
            SET status = 'approved',
                reviewed_by_admin_id = $2,
                reviewed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1 AND status = 'pending_review'
            RETURNING *
        `, [bountyId, adminId]);

        if (result.rows.length === 0) {
            throw new Error('Bounty não encontrado ou já foi revisado');
        }

        const bounty = result.rows[0];
        logger.info(`[Bounty] Bounty #${bountyId} approved by admin ${adminId}`);

        // Recalculate rankings
        await this.dbPool.query('SELECT recalculate_bounty_rankings()');

        // Notify creator
        await this.notifyUser(bounty.creator_telegram_id, 'bounty_approved', bounty);

        return bounty;
    }

    /**
     * Reject a pending bounty
     */
    async rejectBounty(bountyId, adminId, reason = null) {
        const result = await this.dbPool.query(`
            UPDATE bounty_features
            SET status = 'rejected',
                reviewed_by_admin_id = $2,
                reviewed_at = NOW(),
                review_notes = $3,
                updated_at = NOW()
            WHERE id = $1 AND status = 'pending_review'
            RETURNING *
        `, [bountyId, adminId, reason]);

        if (result.rows.length === 0) {
            throw new Error('Bounty não encontrado ou já foi revisado');
        }

        const bounty = result.rows[0];
        logger.info(`[Bounty] Bounty #${bountyId} rejected by admin ${adminId}: ${reason}`);

        // Notify creator
        await this.notifyUser(bounty.creator_telegram_id, 'bounty_rejected', bounty);

        return bounty;
    }

    /**
     * Remove an existing bounty (admin action)
     */
    async removeBounty(bountyId, adminId, reason = null) {
        const bounty = await this.getBountyById(bountyId);
        if (!bounty) {
            throw new Error('Bounty não encontrado');
        }

        // Only allow removal of approved bounties (not in development)
        if (!['approved', 'pending_review'].includes(bounty.status)) {
            throw new Error('Não é possível remover bounty neste status');
        }

        await this.dbPool.query(`
            UPDATE bounty_features
            SET status = 'rejected',
                reviewed_by_admin_id = $2,
                review_notes = $3,
                updated_at = NOW()
            WHERE id = $1
        `, [bountyId, adminId, reason || 'Removido por admin']);

        logger.info(`[Bounty] Bounty #${bountyId} removed by admin ${adminId}`);

        // Recalculate rankings
        await this.dbPool.query('SELECT recalculate_bounty_rankings()');

        return true;
    }

    // ==========================================
    // DEVELOPER CLAIMS
    // ==========================================

    /**
     * Developer claims a bounty
     */
    async claimBounty(bountyId, developerTelegramId, developerUsername) {
        const result = await this.dbPool.query(`
            UPDATE bounty_features
            SET developer_telegram_id = $2,
                developer_username = $3,
                developer_claimed_at = NOW(),
                status = 'taken',
                updated_at = NOW()
            WHERE id = $1 AND status = 'approved'
            RETURNING *
        `, [bountyId, developerTelegramId, developerUsername]);

        if (result.rows.length === 0) {
            throw new Error('Bounty não disponível para claim');
        }

        const bounty = result.rows[0];
        logger.info(`[Bounty] Bounty #${bountyId} claimed by @${developerUsername}`);

        // Notify admins
        await this.notifyAdmins('developer_claim', bounty);

        return bounty;
    }

    /**
     * Admin approves developer claim
     */
    async approveDevClaim(bountyId, adminId) {
        const result = await this.dbPool.query(`
            UPDATE bounty_features
            SET developer_approved_at = NOW(),
                status = 'in_development',
                updated_at = NOW()
            WHERE id = $1 AND status = 'taken'
            RETURNING *
        `, [bountyId]);

        if (result.rows.length === 0) {
            throw new Error('Bounty não encontrado ou não está em status "taken"');
        }

        const bounty = result.rows[0];
        logger.info(`[Bounty] Developer claim approved for bounty #${bountyId} by admin ${adminId}`);

        // Notify developer
        await this.notifyUser(bounty.developer_telegram_id, 'dev_claim_approved', bounty);

        return bounty;
    }

    /**
     * Admin rejects developer claim (bounty goes back to approved)
     */
    async rejectDevClaim(bountyId, adminId) {
        const result = await this.dbPool.query(`
            UPDATE bounty_features
            SET developer_telegram_id = NULL,
                developer_username = NULL,
                developer_claimed_at = NULL,
                status = 'approved',
                updated_at = NOW()
            WHERE id = $1 AND status = 'taken'
            RETURNING *
        `, [bountyId]);

        if (result.rows.length === 0) {
            throw new Error('Bounty não encontrado ou não está em status "taken"');
        }

        const bounty = result.rows[0];
        logger.info(`[Bounty] Developer claim rejected for bounty #${bountyId} by admin ${adminId}`);

        return bounty;
    }

    /**
     * Mark bounty as completed (dev finished work)
     */
    async markAsCompleted(bountyId) {
        const result = await this.dbPool.query(`
            UPDATE bounty_features
            SET status = 'completed',
                updated_at = NOW()
            WHERE id = $1 AND status = 'in_development'
            RETURNING *
        `, [bountyId]);

        if (result.rows.length === 0) {
            throw new Error('Bounty não está em desenvolvimento');
        }

        const bounty = result.rows[0];
        logger.info(`[Bounty] Bounty #${bountyId} marked as completed`);

        // Notify admins
        await this.notifyAdmins('bounty_completed', bounty);

        return bounty;
    }

    /**
     * Mark bounty as paid (final status)
     */
    async markAsPaid(bountyId, adminId) {
        const result = await this.dbPool.query(`
            UPDATE bounty_features
            SET status = 'paid',
                updated_at = NOW()
            WHERE id = $1 AND status = 'completed'
            RETURNING *
        `, [bountyId]);

        if (result.rows.length === 0) {
            throw new Error('Bounty não está em status "completed"');
        }

        const bounty = result.rows[0];
        logger.info(`[Bounty] Bounty #${bountyId} marked as paid by admin ${adminId}`);

        // Notify developer
        if (bounty.developer_telegram_id) {
            await this.notifyUser(bounty.developer_telegram_id, 'bounty_paid', bounty);
        }

        return bounty;
    }

    // ==========================================
    // PAYMENT HANDLING
    // ==========================================

    /**
     * Derive a new Liquid address for a payment
     */
    async deriveNewAddress() {
        try {
            // Get next bounty address index (starts at 10000)
            const indexResult = await this.dbPool.query('SELECT get_next_bounty_address_index()');
            const index = indexResult.rows[0].get_next_bounty_address_index;

            // Call LWK Python script to derive address
            const { stdout } = await execFileAsync('python3', [LWK_SCRIPT_PATH, 'derive', index.toString()], {
                env: { ...process.env, HOME: '/home/cmo' }
            });

            const response = JSON.parse(stdout.trim());

            if (!response.success) {
                throw new Error(response.error || 'Erro ao derivar endereço');
            }

            logger.info(`[Bounty] Derived address index ${index}: ${response.address.substring(0, 30)}...`);

            return {
                address: response.address,
                index: index
            };
        } catch (error) {
            logger.error(`[Bounty] Error deriving address: ${error.message}`);
            throw error;
        }
    }

    /**
     * Create PIX payment for bounty vote
     */
    async createPixPayment(bountyId, telegramUserId, telegramUsername, amountBrl) {
        const bounty = await this.getBountyById(bountyId);
        if (!bounty || bounty.status !== 'approved') {
            throw new Error('Bounty não disponível para votação');
        }

        // Derive unique address for this payment
        const { address, index } = await this.deriveNewAddress();

        // Generate merchant order ID
        const merchantOrderId = `bounty_${bountyId}_${Date.now()}`;

        // Create payment via Atlas API
        const pixData = await atlasApiService.createPixPayment({
            amount: amountBrl,
            description: `Voto: ${bounty.title.substring(0, 50)}`,
            depixAddress: address,
            merchantOrderId: merchantOrderId
        });

        // Save payment record
        const result = await this.dbPool.query(`
            INSERT INTO bounty_payments (
                bounty_id, telegram_user_id, telegram_username,
                payment_method, amount, amount_brl,
                liquid_address, address_index,
                atlas_transaction_id, atlas_merchant_order_id,
                qr_code_payload, qr_code_image, expires_at,
                status, created_at, updated_at
            ) VALUES ($1, $2, $3, 'PIX', $4, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NOW(), NOW())
            RETURNING *
        `, [
            bountyId, telegramUserId, telegramUsername,
            amountBrl,
            address, index,
            pixData.id, merchantOrderId,
            pixData.qrCode, pixData.qrCodeImage, pixData.expiresAt
        ]);

        logger.info(`[Bounty] PIX payment created: ${pixData.id} for bounty #${bountyId}`);

        return {
            payment: result.rows[0],
            pixData: pixData
        };
    }

    /**
     * Create Liquid payment request (user will send directly)
     */
    async createLiquidPayment(bountyId, telegramUserId, telegramUsername, assetType) {
        const bounty = await this.getBountyById(bountyId);
        if (!bounty || bounty.status !== 'approved') {
            throw new Error('Bounty não disponível para votação');
        }

        // Validate asset type
        const validAssets = ['LIQUID_DEPIX', 'LIQUID_LBTC', 'LIQUID_USDT'];
        if (!validAssets.includes(assetType)) {
            throw new Error('Tipo de ativo inválido');
        }

        // Derive unique address for this payment
        const { address, index } = await this.deriveNewAddress();

        // Save payment record (pending, waiting for Liquid tx)
        const result = await this.dbPool.query(`
            INSERT INTO bounty_payments (
                bounty_id, telegram_user_id, telegram_username,
                payment_method, amount, amount_brl,
                liquid_address, address_index,
                status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, 0, 0, $5, $6, 'pending', NOW(), NOW())
            RETURNING *
        `, [bountyId, telegramUserId, telegramUsername, assetType, address, index]);

        logger.info(`[Bounty] Liquid payment request created for bounty #${bountyId}, asset: ${assetType}`);

        // Get asset ID for display
        const assetId = assetType === 'LIQUID_LBTC' ? ASSET_IDS.LBTC :
            assetType === 'LIQUID_USDT' ? ASSET_IDS.USDT :
                ASSET_IDS.DEPIX;

        return {
            payment: result.rows[0],
            address: address,
            assetType: assetType,
            assetId: assetId
        };
    }

    /**
     * Process Atlas webhook for PIX payment
     */
    async processAtlasWebhook(webhookData) {
        const { id, status, merchantOrderId, amount, event } = webhookData;

        logger.info(`[Bounty] Processing Atlas webhook: event=${event}, status=${status}, id=${id}`);

        // Find payment by Atlas transaction ID
        const paymentResult = await this.dbPool.query(
            'SELECT * FROM bounty_payments WHERE atlas_transaction_id = $1',
            [id]
        );

        if (paymentResult.rows.length === 0) {
            logger.warn(`[Bounty] No payment found for Atlas transaction ${id}`);
            return { success: false, message: 'Payment not found' };
        }

        const payment = paymentResult.rows[0];

        // Already processed?
        if (payment.status !== 'pending') {
            logger.info(`[Bounty] Payment ${id} already processed with status ${payment.status}`);
            return { success: true, message: 'Already processed' };
        }

        // Determine new status based on event or status
        // Atlas API uses 'COMPLETED' for successful payments, not 'PAID'
        let newStatus;
        const successStatuses = ['PAID', 'COMPLETED'];
        const successEvents = ['transaction.paid', 'transaction.completed'];
        const expiredStatuses = ['EXPIRED'];
        const expiredEvents = ['transaction.expired'];
        const failedStatuses = ['FAILED', 'CANCELLED', 'REFUNDED'];
        const failedEvents = ['transaction.failed', 'transaction.cancelled', 'transaction.refunded'];

        if (successEvents.includes(event) || successStatuses.includes(status)) {
            newStatus = 'confirmed';
        } else if (expiredEvents.includes(event) || expiredStatuses.includes(status)) {
            newStatus = 'expired';
        } else if (failedEvents.includes(event) || failedStatuses.includes(status)) {
            newStatus = 'failed';
        } else {
            logger.info(`[Bounty] Non-terminal event: event=${event}, status=${status}`);
            return { success: true, message: 'Non-terminal event' };
        }

        // For PIX payments, deduct Eulen fee (R$ 0.99)
        const EULEN_FEE = 0.99;
        const netAmount = payment.payment_method === 'PIX'
            ? Math.max(0, parseFloat(payment.amount_brl) - EULEN_FEE)
            : parseFloat(payment.amount_brl);

        // Update payment status and net amount
        await this.dbPool.query(`
            UPDATE bounty_payments
            SET status = $2,
                amount_brl = $3,
                confirmed_at = CASE WHEN $2 = 'confirmed' THEN NOW() ELSE NULL END,
                webhook_received_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
        `, [payment.id, newStatus, netAmount]);

        logger.info(`[Bounty] Payment ${id} updated to ${newStatus}${payment.payment_method === 'PIX' ? ` (net: R$ ${netAmount.toFixed(2)} after Eulen fee)` : ''}`);

        // If confirmed, notify voter
        if (newStatus === 'confirmed') {
            const bounty = await this.getBountyById(payment.bounty_id);
            await this.notifyUser(payment.telegram_user_id, 'vote_confirmed', {
                bounty,
                amount: netAmount,
                assetType: 'PIX'
            });

            // Notify admins for large votes
            if (netAmount >= 100) {
                await this.notifyAdmins('large_vote', {
                    bounty,
                    payment: { ...payment, amount_brl: netAmount },
                    amount: netAmount
                });
            }
        }

        return { success: true, message: `Payment ${newStatus}` };
    }

    /**
     * Process detected Liquid payment (from scanner)
     */
    async processLiquidPayment(address, txid, vout, amount, assetType, blockHeight) {
        // Find pending payment by address
        const paymentResult = await this.dbPool.query(
            'SELECT * FROM bounty_payments WHERE liquid_address = $1 AND status = $2',
            [address, 'pending']
        );

        if (paymentResult.rows.length === 0) {
            logger.info(`[Bounty] No pending payment for address ${address}`);
            return null;
        }

        const payment = paymentResult.rows[0];

        // Check if already processed (same txid)
        if (payment.liquid_txid === txid) {
            logger.info(`[Bounty] Payment already processed: ${txid}`);
            return null;
        }

        // Convert amount to BRL
        const amountBrl = await atlasApiService.convertToBrl(assetType, amount);

        // Update payment
        await this.dbPool.query(`
            UPDATE bounty_payments
            SET amount = $2,
                amount_brl = $3,
                liquid_txid = $4,
                liquid_vout = $5,
                block_height = $6,
                status = 'confirmed',
                confirmed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
        `, [payment.id, amount, amountBrl, txid, vout, blockHeight]);

        logger.info(`[Bounty] Liquid payment confirmed: ${txid} for ${amount} ${assetType} (R$ ${amountBrl.toFixed(2)})`);

        // Notify voter
        const bounty = await this.getBountyById(payment.bounty_id);
        await this.notifyUser(payment.telegram_user_id, 'vote_confirmed', {
            bounty,
            amount: amountBrl
        });

        return payment;
    }

    /**
     * Confirm Liquid payment by payment ID (used by scanner)
     * @param {number} paymentId - Payment ID from database
     * @param {number} amount - Amount received (in asset units)
     * @param {string} txid - Liquid transaction ID
     */
    async confirmLiquidPaymentById(paymentId, amount, txid) {
        // Get payment details (status is lowercase in DB)
        const paymentResult = await this.dbPool.query(
            'SELECT * FROM bounty_payments WHERE id = $1 AND status = $2',
            [paymentId, 'pending']
        );

        if (paymentResult.rows.length === 0) {
            logger.info(`[Bounty] Payment ${paymentId} not found or not pending`);
            return null;
        }

        const payment = paymentResult.rows[0];

        // Check if already processed (same txid)
        if (payment.liquid_txid === txid) {
            logger.info(`[Bounty] Payment already processed: ${txid}`);
            return null;
        }

        // Convert amount to BRL based on payment method
        const assetType = payment.payment_method;
        const amountBrl = await atlasApiService.convertToBrl(assetType.replace('LIQUID_', ''), amount);

        // Update payment (status is lowercase)
        await this.dbPool.query(`
            UPDATE bounty_payments
            SET amount = $2,
                amount_brl = $3,
                liquid_txid = $4,
                status = 'confirmed',
                confirmed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
        `, [payment.id, amount, amountBrl, txid]);

        logger.info(`[Bounty] Liquid payment confirmed: ${txid} for ${amount} ${assetType} (R$ ${amountBrl.toFixed(2)})`);

        // Notify voter with crypto amount for L-BTC/L-USDT
        const bounty = await this.getBountyById(payment.bounty_id);
        if (bounty) {
            await this.notifyUser(payment.telegram_user_id, 'vote_confirmed', {
                bounty,
                amount: amountBrl,
                cryptoAmount: amount,
                assetType: assetType.replace('LIQUID_', '')
            });
        }

        return payment;
    }

    /**
     * Get pending Liquid payments for scanning
     */
    async getPendingLiquidPayments() {
        const result = await this.dbPool.query(`
            SELECT * FROM bounty_payments
            WHERE payment_method LIKE 'LIQUID_%'
              AND status = 'pending'
              AND created_at > NOW() - INTERVAL '24 hours'
        `);
        return result.rows;
    }

    /**
     * Get user's payments/votes
     */
    async getUserPayments(telegramUserId, limit = 10) {
        const result = await this.dbPool.query(`
            SELECT bp.*, bf.title as bounty_title
            FROM bounty_payments bp
            JOIN bounty_features bf ON bp.bounty_id = bf.id
            WHERE bp.telegram_user_id = $1
            ORDER BY bp.created_at DESC
            LIMIT $2
        `, [telegramUserId, limit]);
        return result.rows;
    }

    // ==========================================
    // NOTIFICATIONS
    // ==========================================

    /**
     * Notify all admins
     */
    async notifyAdmins(eventType, data) {
        if (!this.bot) {
            logger.warn('[Bounty] Bot not set, skipping admin notification');
            return;
        }

        const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map(id => parseInt(id.trim())) || [];

        let message;
        const escapeUsername = (u) => u ? this.escapeMarkdown(String(u)) : 'N/A';

        switch (eventType) {
            case 'new_bounty':
                message = `🆕 *Nova sugestão de projeto\\!*\n\n` +
                    `📝 *Título:* ${this.escapeMarkdown(data.title)}\n` +
                    `📄 ${this.escapeMarkdown(data.short_description?.substring(0, 200) || '')}\n\n` +
                    `👤 Por: @${escapeUsername(data.creator_username || data.creator_telegram_id)}\n\n` +
                    `Use /admin ➜ Projetos para revisar\\.`;
                break;

            case 'developer_claim':
                message = `👷 *Desenvolvedor quer assumir projeto\\!*\n\n` +
                    `📝 *Projeto:* ${this.escapeMarkdown(data.title)}\n` +
                    `💰 Valor: R\\$ ${parseFloat(data.total_brl || 0).toFixed(2).replace('.', '\\.')}\n` +
                    `👤 Dev: @${escapeUsername(data.developer_username || data.developer_telegram_id)}\n\n` +
                    `Use /admin ➜ Projetos para aprovar\\.`;
                break;

            case 'large_vote':
                message = `💰 *Contribuição alta recebida\\!*\n\n` +
                    `📝 *Projeto:* ${this.escapeMarkdown(data.bounty?.title || 'N/A')}\n` +
                    `💵 Valor: R\\$ ${parseFloat(data.amount || 0).toFixed(2).replace('.', '\\.')}\n` +
                    `👤 Por: @${escapeUsername(data.payment?.telegram_username || data.payment?.telegram_user_id)}`;
                break;

            case 'bounty_completed':
                message = `✅ *Projeto marcado como concluído\\!*\n\n` +
                    `📝 *Projeto:* ${this.escapeMarkdown(data.title)}\n` +
                    `💰 Valor: R\\$ ${parseFloat(data.total_brl || 0).toFixed(2).replace('.', '\\.')}\n` +
                    `👤 Dev: @${escapeUsername(data.developer_username)}\n\n` +
                    `Use /admin ➜ Projetos para pagar\\.`;
                break;

            default:
                return;
        }

        for (const adminId of adminIds) {
            try {
                await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'MarkdownV2' });
            } catch (error) {
                logger.error(`[Bounty] Failed to notify admin ${adminId}: ${error.message}`);
            }
        }
    }

    /**
     * Notify a specific user
     */
    async notifyUser(telegramUserId, eventType, data) {
        if (!this.bot || !telegramUserId) return;

        let message;
        switch (eventType) {
            case 'bounty_approved':
                message = `✅ *Sua sugestão foi aprovada\\!*\n\n` +
                    `📝 *${this.escapeMarkdown(data.title)}*\n\n` +
                    `Seu projeto agora está disponível para receber contribuições da comunidade\\!`;
                break;

            case 'bounty_rejected':
                message = `❌ *Sua sugestão não foi aprovada*\n\n` +
                    `📝 *${this.escapeMarkdown(data.title)}*\n\n` +
                    `${data.review_notes ? `Motivo: ${this.escapeMarkdown(data.review_notes)}` : 'Entre em contato com o suporte para mais informações\\.'}`;
                break;

            case 'vote_confirmed':
                // Format value based on asset type
                let valorDisplay;
                if (data.assetType === 'LBTC') {
                    valorDisplay = `${data.cryptoAmount} BTC \\(~R\\$ ${parseFloat(data.amount || 0).toFixed(2).replace('.', '\\.')}\\)`;
                } else if (data.assetType === 'USDT') {
                    valorDisplay = `${parseFloat(data.cryptoAmount || 0).toFixed(2)} USDT \\(~R\\$ ${parseFloat(data.amount || 0).toFixed(2).replace('.', '\\.')}\\)`;
                } else {
                    // DePix or PIX - just show BRL
                    valorDisplay = `R\\$ ${parseFloat(data.amount || 0).toFixed(2).replace('.', '\\.')}`;
                }

                message = `✅ *Contribuição confirmada\\!*\n\n` +
                    `📝 *Projeto:* ${this.escapeMarkdown(data.bounty?.title || 'N/A')}\n` +
                    `💰 Valor: ${valorDisplay}\n\n` +
                    `Obrigado por apoiar este projeto\\!`;
                break;

            case 'dev_claim_approved':
                message = `✅ *Você foi aprovado para desenvolver\\!*\n\n` +
                    `📝 *Projeto:* ${this.escapeMarkdown(data.title)}\n` +
                    `💰 Valor: R\\$ ${parseFloat(data.total_brl || 0).toFixed(2).replace('.', '\\.')}\n\n` +
                    `Boa sorte com o desenvolvimento\\!`;
                break;

            case 'bounty_paid':
                message = `💰 *Pagamento do projeto realizado\\!*\n\n` +
                    `📝 *Projeto:* ${this.escapeMarkdown(data.title)}\n` +
                    `💵 Valor: R\\$ ${parseFloat(data.total_brl || 0).toFixed(2).replace('.', '\\.')}\n\n` +
                    `Obrigado pela contribuição\\!`;
                break;

            default:
                return;
        }

        try {
            await this.bot.telegram.sendMessage(telegramUserId, message, { parse_mode: 'MarkdownV2' });
        } catch (error) {
            logger.error(`[Bounty] Failed to notify user ${telegramUserId}: ${error.message}`);
        }
    }

    /**
     * Escape text for MarkdownV2
     */
    escapeMarkdown(text) {
        if (!text || typeof text !== 'string') return '';
        return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    }
}

module.exports = BountyService;
