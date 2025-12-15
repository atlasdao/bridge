const cron = require('node-cron');
const logger = require('../core/logger');
const alertService = require('./alertService');
const BountyService = require('./bountyService');

class ScheduledJobs {
    constructor(dbPool, redisConnection, bot = null) {
        this.dbPool = dbPool;
        this.redisConnection = redisConnection;
        this.bot = bot;
        this.jobs = new Map();
        this.isShuttingDown = false;
    }

    setBot(bot) {
        this.bot = bot;
    }

    /**
     * Initialize all scheduled jobs
     */
    async initialize() {
        logger.info('[ScheduledJobs] Initializing scheduled jobs...');

        // Schedule daily limit reset
        this.scheduleDailyLimitReset();

        // Schedule stats recalculation
        this.scheduleStatsRecalculation();

        // Schedule transaction cleanup
        this.scheduleTransactionCleanup();

        // Schedule user state cleanup (for memory leak prevention)
        this.scheduleUserStateCleanup();

        // Schedule verification polling (webhook fallback)
        this.scheduleVerificationPolling();

        // Schedule withdrawal payment monitoring (DePix → PIX)
        this.scheduleWithdrawalMonitoring();

        // Schedule bounty Liquid payment scanner
        this.scheduleBountyLiquidScanner();

        logger.info('[ScheduledJobs] All jobs initialized');
    }

    /**
     * Check if database pool is available
     */
    isDatabaseAvailable() {
        if (this.isShuttingDown) {
            logger.warn('[ScheduledJobs] Skipping job execution - system is shutting down');
            return false;
        }

        if (!this.dbPool || this.dbPool.ended) {
            logger.error('[ScheduledJobs] Database pool is not available or has been closed');
            return false;
        }

        return true;
    }

    /**
     * Check if Redis is available
     */
    isRedisAvailable() {
        if (this.isShuttingDown) {
            return false;
        }

        if (!this.redisConnection || this.redisConnection.status !== 'ready') {
            logger.error('[ScheduledJobs] Redis connection is not available');
            return false;
        }

        return true;
    }

    /**
     * Schedule daily limit reset at midnight Brazil time
     */
    scheduleDailyLimitReset() {
        // Run at 00:00 Brazil time (midnight)
        const resetJob = cron.schedule('0 0 * * *', async () => {
            await this.executeDailyLimitResetWithRetry();
        }, {
            scheduled: true,
            timezone: "America/Sao_Paulo"
        });

        this.jobs.set('daily_limit_reset', resetJob);
        logger.info('[ScheduledJobs] Daily limit reset scheduled for 00:00 Brazil time');
    }

    /**
     * Execute daily limit reset with aggressive retry logic
     * Strategy: 5 cycles of (3 attempts with 30s delay), with 5 min wait between cycles
     * Total max time: ~30 minutes before giving up
     */
    async executeDailyLimitResetWithRetry() {
        const maxCycles = 5;           // 5 retry cycles
        const attemptsPerCycle = 3;    // 3 attempts per cycle
        const attemptDelay = 30000;    // 30 seconds between attempts
        const cycleDelay = 300000;     // 5 minutes between cycles

        let totalAttempts = 0;

        for (let cycle = 1; cycle <= maxCycles; cycle++) {
            logger.info(`[ScheduledJobs] Daily limit reset - Starting cycle ${cycle}/${maxCycles}`);

            for (let attempt = 1; attempt <= attemptsPerCycle; attempt++) {
                totalAttempts++;
                const attemptLabel = `Cycle ${cycle}/${maxCycles}, Attempt ${attempt}/${attemptsPerCycle} (Total: ${totalAttempts})`;

                if (!this.isDatabaseAvailable()) {
                    logger.error(`[ScheduledJobs] ${attemptLabel} - Database unavailable`);

                    if (attempt < attemptsPerCycle) {
                        logger.info(`[ScheduledJobs] Waiting ${attemptDelay/1000}s before next attempt...`);
                        await new Promise(resolve => setTimeout(resolve, attemptDelay));
                        continue;
                    } else if (cycle < maxCycles) {
                        logger.warn(`[ScheduledJobs] Cycle ${cycle} failed. Waiting ${cycleDelay/1000}s before next cycle...`);
                        await new Promise(resolve => setTimeout(resolve, cycleDelay));
                        break; // Move to next cycle
                    } else {
                        // All cycles exhausted
                        logger.error(`[ScheduledJobs] CRITICAL: Daily limit reset failed after ${totalAttempts} attempts across ${maxCycles} cycles`);
                        await alertService.sendJobFailureAlert('daily_limit_reset',
                            new Error('Database unavailable after all retries'), {
                            totalAttempts,
                            cycles: maxCycles,
                            lastError: 'Database pool unavailable'
                        });
                        return;
                    }
                }

                logger.info(`[ScheduledJobs] ${attemptLabel} - Starting daily limit reset...`);

                try {
                    const result = await this.dbPool.query('SELECT reset_daily_limits()');
                    const resetCount = result.rows[0].reset_daily_limits;

                    logger.info(`[ScheduledJobs] ✓ SUCCESS - Daily limits reset for ${resetCount} users (${attemptLabel})`);

                    // Enviar alerta de sucesso (job crítico)
                    await alertService.sendJobSuccessAlert('daily_limit_reset', {
                        usersReset: resetCount,
                        totalAttempts,
                        cycle,
                        succeededOnAttempt: attempt
                    });

                    if (this.isRedisAvailable()) {
                        await this.trackJobExecution('daily_limit_reset', {
                            success: true,
                            usersReset: resetCount,
                            totalAttempts,
                            cycle,
                            attempt,
                            executedAt: new Date().toISOString()
                        });
                    }

                    return; // Success! Exit completely

                } catch (error) {
                    logger.error(`[ScheduledJobs] ${attemptLabel} - Failed:`, error);

                    if (attempt < attemptsPerCycle) {
                        // More attempts in this cycle
                        logger.info(`[ScheduledJobs] Waiting ${attemptDelay/1000}s before next attempt...`);
                        await new Promise(resolve => setTimeout(resolve, attemptDelay));
                    } else if (cycle < maxCycles) {
                        // Move to next cycle
                        logger.warn(`[ScheduledJobs] Cycle ${cycle} failed. Waiting ${cycleDelay/1000}s before next cycle...`);
                        await new Promise(resolve => setTimeout(resolve, cycleDelay));
                    } else {
                        // Final failure - all cycles exhausted
                        logger.error(`[ScheduledJobs] CRITICAL: Daily limit reset FAILED after ${totalAttempts} attempts across ${maxCycles} cycles`);

                        await alertService.sendJobFailureAlert('daily_limit_reset', error, {
                            totalAttempts,
                            cycles: maxCycles,
                            lastError: error.message,
                            criticalFailure: true
                        });

                        if (this.isRedisAvailable()) {
                            await this.trackJobExecution('daily_limit_reset', {
                                success: false,
                                error: error.message,
                                totalAttempts,
                                cycles: maxCycles,
                                executedAt: new Date().toISOString()
                            });
                        }
                    }
                }
            }
        }
    }

    /**
     * Schedule stats recalculation with optimized batch processing
     * FIXED: N+1 query problem
     */
    scheduleStatsRecalculation() {
        // Run every hour at minute 15
        const statsJob = cron.schedule('15 * * * *', async () => {
            if (!this.isDatabaseAvailable()) {
                logger.error('[ScheduledJobs] Skipping stats recalculation - database unavailable');
                return;
            }

            logger.info('[ScheduledJobs] Starting hourly stats recalculation...');

            try {
                // Get all active users in the last 24 hours
                const activeUsersResult = await this.dbPool.query(`
                    SELECT DISTINCT user_id
                    FROM pix_transactions
                    WHERE
                        created_at >= NOW() - INTERVAL '24 hours'
                        AND payment_status IN ('CONFIRMED', 'PAID')
                `);

                if (activeUsersResult.rowCount === 0) {
                    logger.info('[ScheduledJobs] No active users to recalculate');
                    return;
                }

                // Extract user IDs
                const userIds = activeUsersResult.rows.map(row => row.user_id);

                // Direct batch update - Updates all user stats in a single query
                const directUpdateResult = await this.dbPool.query(`
                    WITH user_stats AS (
                        SELECT
                            pt.user_id,
                            COUNT(*) as transaction_count,
                            COALESCE(SUM(pt.requested_brl_amount), 0) as total_volume
                        FROM pix_transactions pt
                        WHERE pt.user_id = ANY($1::BIGINT[])
                            AND pt.payment_status IN ('CONFIRMED', 'PAID')
                        GROUP BY pt.user_id
                    )
                    UPDATE users u
                    SET
                        completed_transactions = COALESCE(us.transaction_count, 0),
                        total_volume_brl = COALESCE(us.total_volume, 0),
                        updated_at = NOW()
                    FROM user_stats us
                    WHERE u.telegram_user_id = us.user_id
                    RETURNING u.telegram_user_id
                `, [userIds]);

                logger.info(`[ScheduledJobs] Recalculated stats for ${directUpdateResult.rowCount} active users`);

                await this.trackJobExecution('stats_recalculation', {
                    success: true,
                    usersProcessed: directUpdateResult.rowCount,
                    executedAt: new Date().toISOString()
                });

                // Check for level upgrades (also optimized)
                await this.checkPendingUpgrades();

            } catch (error) {
                logger.error('[ScheduledJobs] Stats recalculation failed:', error);

                // Enviar alerta de falha
                await alertService.sendJobFailureAlert('stats_recalculation', error);

                await this.trackJobExecution('stats_recalculation', {
                    success: false,
                    error: error.message,
                    executedAt: new Date().toISOString()
                });
            }
        });

        this.jobs.set('stats_recalculation', statsJob);
        logger.info('[ScheduledJobs] Hourly stats recalculation scheduled');
    }

    /**
     * Check for pending level upgrades (optimized version)
     * Now based only on volume, not transaction count
     */
    async checkPendingUpgrades() {
        try {
            // Get all users eligible for upgrade (only volume requirement)
            const eligibleUsers = await this.dbPool.query(`
                SELECT
                    u.telegram_user_id,
                    u.reputation_level,
                    u.completed_transactions,
                    u.total_volume_brl,
                    rlc.level as next_level,
                    rlc.min_volume_for_upgrade as next_vol_req
                FROM users u
                JOIN reputation_levels_config rlc ON rlc.level = u.reputation_level + 1
                WHERE
                    u.is_verified = true
                    AND u.is_banned = false
                    AND u.reputation_level < 10
                    AND u.total_volume_brl >= rlc.min_volume_for_upgrade
                    AND (u.last_level_upgrade IS NULL OR u.last_level_upgrade < NOW() - INTERVAL '24 hours')
            `);

            if (eligibleUsers.rowCount === 0) {
                return;
            }

            // Batch upgrade all eligible users
            const userIds = eligibleUsers.rows.map(user => user.telegram_user_id);

            // Perform batch upgrade (only volume check)
            const upgradeResult = await this.dbPool.query(`
                WITH upgrades AS (
                    SELECT
                        u.telegram_user_id,
                        u.reputation_level,
                        rlc.level as new_level,
                        rlc.daily_limit_brl as new_limit
                    FROM users u
                    JOIN reputation_levels_config rlc ON rlc.level = u.reputation_level + 1
                    WHERE
                        u.telegram_user_id = ANY($1::BIGINT[])
                        AND u.total_volume_brl >= rlc.min_volume_for_upgrade
                )
                UPDATE users u
                SET
                    reputation_level = upgrades.new_level,
                    daily_limit_brl = upgrades.new_limit,
                    last_level_upgrade = NOW(),
                    updated_at = NOW()
                FROM upgrades
                WHERE u.telegram_user_id = upgrades.telegram_user_id
                RETURNING u.telegram_user_id, upgrades.new_level
            `, [userIds]);

            if (upgradeResult.rowCount > 0) {
                logger.info(`[ScheduledJobs] Batch upgraded ${upgradeResult.rowCount} users`);

                // Log individual upgrades
                for (const upgrade of upgradeResult.rows) {
                    logger.info(`[ScheduledJobs] User ${upgrade.telegram_user_id} upgraded to level ${upgrade.new_level}`);
                }
            }

        } catch (error) {
            logger.error('[ScheduledJobs] Error checking pending upgrades:', error);
        }
    }

    /**
     * Schedule daily cleanup of expired transactions
     */
    scheduleTransactionCleanup() {
        // Run at 02:00 Brazil time
        const cleanupJob = cron.schedule('0 5 * * *', async () => {
            if (!this.isDatabaseAvailable()) {
                logger.error('[ScheduledJobs] Skipping transaction cleanup - database unavailable');
                return;
            }

            logger.info('[ScheduledJobs] Starting transaction cleanup...');

            try {
                // Mark expired pending transactions
                const expiredResult = await this.dbPool.query(`
                    UPDATE pix_transactions
                    SET
                        payment_status = 'EXPIRED',
                        updated_at = NOW()
                    WHERE
                        payment_status = 'PENDING'
                        AND created_at < NOW() - INTERVAL '24 hours'
                    RETURNING transaction_id
                `);

                // Clean up old verification attempts
                const verificationResult = await this.dbPool.query(`
                    UPDATE verification_transactions
                    SET
                        verification_status = 'EXPIRED',
                        updated_at = NOW()
                    WHERE
                        verification_status = 'PENDING'
                        AND created_at < NOW() - INTERVAL '12 hours'
                    RETURNING verification_id
                `);

                logger.info(`[ScheduledJobs] Cleanup: ${expiredResult.rowCount} expired transactions, ${verificationResult.rowCount} expired verifications`);

                await this.trackJobExecution('transaction_cleanup', {
                    success: true,
                    expiredTransactions: expiredResult.rowCount,
                    expiredVerifications: verificationResult.rowCount,
                    executedAt: new Date().toISOString()
                });

            } catch (error) {
                logger.error('[ScheduledJobs] Transaction cleanup failed:', error);

                // Enviar alerta de falha
                await alertService.sendJobFailureAlert('transaction_cleanup', error);

                await this.trackJobExecution('transaction_cleanup', {
                    success: false,
                    error: error.message,
                    executedAt: new Date().toISOString()
                });
            }
        }, {
            scheduled: true,
            timezone: "America/Sao_Paulo"
        });

        this.jobs.set('transaction_cleanup', cleanupJob);
        logger.info('[ScheduledJobs] Daily transaction cleanup scheduled for 02:00 Brazil time');
    }

    /**
     * Schedule cleanup of expired user states (prevents memory leaks)
     * NEW: Added to fix memory leak issue
     */
    scheduleUserStateCleanup() {
        // Run every 15 minutes
        const stateCleanupJob = cron.schedule('*/15 * * * *', async () => {
            if (!this.isDatabaseAvailable()) {
                return; // Silent skip for frequent jobs
            }

            logger.info('[ScheduledJobs] Cleaning up expired user states...');

            try {
                // Clean up database-stored states
                const dbResult = await this.dbPool.query('SELECT cleanup_expired_user_states()');
                const dbCleaned = dbResult.rows[0].cleanup_expired_user_states;

                // Clean up Redis-stored states
                const redisPattern = 'user_state:*';
                const keys = await this.redisConnection.keys(redisPattern);
                let redisCleaned = 0;

                for (const key of keys) {
                    const ttl = await this.redisConnection.ttl(key);
                    // If TTL is -1 (no expiry) or -2 (doesn't exist), set a 15-minute expiry
                    if (ttl === -1) {
                        await this.redisConnection.expire(key, 900); // 15 minutes
                        redisCleaned++;
                    }
                }

                if (dbCleaned > 0 || redisCleaned > 0) {
                    logger.info(`[ScheduledJobs] Cleaned up ${dbCleaned} DB states and fixed ${redisCleaned} Redis states`);
                }

            } catch (error) {
                logger.error('[ScheduledJobs] User state cleanup failed:', error);
            }
        });

        this.jobs.set('user_state_cleanup', stateCleanupJob);
        logger.info('[ScheduledJobs] User state cleanup scheduled every 15 minutes');
    }

    /**
     * Schedule polling of pending verification transactions (webhook fallback)
     * This ensures verifications are completed even if webhooks fail
     */
    scheduleVerificationPolling() {
        const depixApiService = require('./depixApiService');
        const { processWebhook } = require('../routes/webhookRoutes');

        // Run every 5 minutes
        const pollingJob = cron.schedule('*/5 * * * *', async () => {
            if (!this.isDatabaseAvailable()) {
                return; // Silent skip for frequent jobs
            }

            try {
                // Find PENDING verifications that are >2 minutes old (give webhooks time to arrive)
                const pendingVerifications = await this.dbPool.query(`
                    SELECT
                        vt.verification_id,
                        vt.telegram_user_id,
                        vt.depix_api_entry_id,
                        vt.verification_status,
                        vt.created_at
                    FROM verification_transactions vt
                    WHERE vt.verification_status = 'PENDING'
                        AND vt.created_at < NOW() - INTERVAL '2 minutes'
                        AND vt.created_at > NOW() - INTERVAL '12 hours'
                    ORDER BY vt.created_at ASC
                    LIMIT 50
                `);

                if (pendingVerifications.rowCount === 0) {
                    return;
                }

                logger.info(`[ScheduledJobs] Polling ${pendingVerifications.rowCount} pending verifications`);

                let completed = 0;
                let failed = 0;
                let pending = 0;

                for (const verification of pendingVerifications.rows) {
                    try {
                        // Query Depix API for status
                        const depixStatus = await depixApiService.getDepositStatus(verification.depix_api_entry_id);

                        if (depixStatus.status === 'depix_sent') {
                            // Payment completed! Process as webhook
                            logger.info(`[ScheduledJobs] Found completed verification for user ${verification.telegram_user_id} via polling`);

                            const client = await this.dbPool.connect();
                            try {
                                await client.query('BEGIN');

                                const payerName = depixStatus.payer?.name || null;
                                const payerCpfCnpj = depixStatus.payer?.cpfCnpj || null;

                                // Update verification transaction
                                await client.query(
                                    `UPDATE verification_transactions
                                    SET verification_status = 'COMPLETED',
                                        payer_name = $1,
                                        payer_cpf_cnpj = $2,
                                        verified_at = NOW(),
                                        updated_at = NOW()
                                    WHERE verification_id = $3`,
                                    [payerName, payerCpfCnpj, verification.verification_id]
                                );

                                // Update user as verified
                                await client.query(
                                    `UPDATE users
                                    SET is_verified = true,
                                        payer_cpf_cnpj = COALESCE($1, payer_cpf_cnpj),
                                        payer_name = COALESCE($2, payer_name),
                                        reputation_level = CASE WHEN reputation_level = 0 THEN 1 ELSE reputation_level END,
                                        daily_limit_brl = CASE WHEN reputation_level = 0 THEN 50 ELSE daily_limit_brl END,
                                        updated_at = NOW()
                                    WHERE telegram_user_id = $3 AND is_verified = false`,
                                    [payerCpfCnpj, payerName, verification.telegram_user_id]
                                );

                                await client.query('COMMIT');
                                completed++;

                                logger.info(`[ScheduledJobs] Successfully completed verification ${verification.verification_id} via polling`);

                            } catch (error) {
                                await client.query('ROLLBACK');
                                logger.error(`[ScheduledJobs] Error processing polled verification: ${error.message}`);
                                failed++;
                            } finally {
                                client.release();
                            }

                        } else if (['canceled', 'error', 'refunded', 'expired'].includes(depixStatus.status)) {
                            // Payment failed
                            await this.dbPool.query(
                                `UPDATE verification_transactions
                                SET verification_status = 'FAILED',
                                    updated_at = NOW()
                                WHERE verification_id = $1`,
                                [verification.verification_id]
                            );
                            failed++;
                        } else {
                            // Still pending in Depix
                            pending++;
                        }

                    } catch (error) {
                        // 404 or other error - payment likely expired/not found
                        if (error.message.includes('404')) {
                            // Mark as expired if it's been more than 2 hours
                            const ageHours = (Date.now() - new Date(verification.created_at).getTime()) / (1000 * 60 * 60);
                            if (ageHours > 2) {
                                await this.dbPool.query(
                                    `UPDATE verification_transactions
                                    SET verification_status = 'EXPIRED',
                                        updated_at = NOW()
                                    WHERE verification_id = $1`,
                                    [verification.verification_id]
                                );
                                failed++;
                            }
                        } else {
                            logger.error(`[ScheduledJobs] Error polling verification ${verification.verification_id}: ${error.message}`);
                        }
                    }
                }

                if (completed > 0 || failed > 0) {
                    logger.info(`[ScheduledJobs] Verification polling: ${completed} completed, ${failed} failed, ${pending} still pending`);
                }

                await this.trackJobExecution('verification_polling', {
                    success: true,
                    completed,
                    failed,
                    pending,
                    executedAt: new Date().toISOString()
                });

            } catch (error) {
                logger.error('[ScheduledJobs] Verification polling failed:', error);

                await this.trackJobExecution('verification_polling', {
                    success: false,
                    error: error.message,
                    executedAt: new Date().toISOString()
                });
            }
        });

        this.jobs.set('verification_polling', pollingJob);
        logger.info('[ScheduledJobs] Verification polling scheduled every 5 minutes (webhook fallback)');
    }

    /**
     * Schedule monitoring of withdrawal payments (DePix → PIX)
     * Checks for incoming DePix payments and expires old withdrawals
     */
    scheduleWithdrawalMonitoring() {
        const WithdrawalService = require('./withdrawalService');

        // Run every 10 seconds
        const withdrawalJob = cron.schedule('*/10 * * * * *', async () => {
            if (!this.isDatabaseAvailable()) {
                return; // Silent skip for frequent jobs
            }

            try {
                // Lazy initialization of withdrawal service
                if (!this.withdrawalService) {
                    this.withdrawalService = new WithdrawalService(this.dbPool, this.bot);
                } else if (this.bot && !this.withdrawalService.bot) {
                    this.withdrawalService.bot = this.bot;
                }

                // Check for incoming payments
                await this.withdrawalService.checkPendingPayments();

                // Expire old withdrawals (run every minute, not every 10 seconds)
                const now = new Date();
                if (now.getSeconds() < 10) {
                    await this.withdrawalService.expireOldWithdrawals();
                }

            } catch (error) {
                logger.error('[ScheduledJobs] Withdrawal monitoring error:', error);
            }
        });

        this.jobs.set('withdrawal_monitoring', withdrawalJob);
        logger.info('[ScheduledJobs] Withdrawal payment monitoring scheduled every 10 seconds');
    }

    /**
     * Schedule bounty Liquid payment scanner
     * Checks for incoming Liquid payments (L-BTC, USDT, DePix) to bounty addresses
     */
    scheduleBountyLiquidScanner() {
        const config = require('../core/config');

        // Only run if bounties are enabled
        if (!config.bounties?.enabled) {
            logger.info('[ScheduledJobs] Bounty Liquid scanner not started - bounties disabled');
            return;
        }

        // Run every 30 seconds
        const bountyLiquidJob = cron.schedule('*/30 * * * * *', async () => {
            if (!this.isDatabaseAvailable()) {
                return; // Silent skip for frequent jobs
            }

            try {
                // Lazy initialization of bounty service
                if (!this.bountyService) {
                    this.bountyService = new BountyService(this.dbPool, this.bot);
                } else if (this.bot && !this.bountyService.bot) {
                    this.bountyService.bot = this.bot;
                }

                // Get pending Liquid bounty payments (older than 30 seconds to allow for propagation)
                const pendingPayments = await this.dbPool.query(`
                    SELECT
                        bp.id,
                        bp.bounty_id,
                        bp.telegram_user_id,
                        bp.payment_method,
                        bp.liquid_address,
                        bp.address_index,
                        bp.created_at
                    FROM bounty_payments bp
                    WHERE bp.status = 'pending'
                        AND bp.payment_method IN ('LIQUID_LBTC', 'LIQUID_USDT', 'LIQUID_DEPIX')
                        AND bp.liquid_address IS NOT NULL
                        AND bp.created_at < NOW() - INTERVAL '30 seconds'
                        AND bp.created_at > NOW() - INTERVAL '24 hours'
                    ORDER BY bp.created_at ASC
                    LIMIT 20
                `);

                if (pendingPayments.rowCount === 0) {
                    return;
                }

                logger.info(`[BountyScanner] Checking ${pendingPayments.rowCount} pending Liquid bounty payments`);

                let processed = 0;
                let errors = 0;

                for (const payment of pendingPayments.rows) {
                    try {
                        // Check address balance using LiquidWalletService
                        const balanceResult = await this.checkBountyAddressBalance(
                            payment.address_index,
                            payment.payment_method,
                            payment.liquid_address
                        );

                        if (balanceResult && balanceResult.amount > 0) {
                            // Payment received!
                            logger.info(`[BountyScanner] Detected payment for bounty ${payment.bounty_id}: ${balanceResult.amount} ${payment.payment_method}`);

                            // Process the payment
                            await this.bountyService.confirmLiquidPaymentById(
                                payment.id,
                                balanceResult.amount,
                                balanceResult.txid
                            );

                            processed++;
                        }
                    } catch (error) {
                        logger.error(`[BountyScanner] Error checking payment ${payment.id}: ${error.message}`);
                        errors++;

                        // Mark as expired if it's been more than 12 hours
                        const ageHours = (Date.now() - new Date(payment.created_at).getTime()) / (1000 * 60 * 60);
                        if (ageHours > 12) {
                            await this.dbPool.query(
                                `UPDATE bounty_payments SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
                                [payment.id]
                            );
                        }
                    }
                }

                if (processed > 0) {
                    logger.info(`[BountyScanner] Processed ${processed} bounty Liquid payments`);
                }

                if (processed > 0 || errors > 0) {
                    await this.trackJobExecution('bounty_liquid_scanner', {
                        success: true,
                        processed,
                        errors,
                        pending: pendingPayments.rowCount - processed - errors,
                        executedAt: new Date().toISOString()
                    });
                }

            } catch (error) {
                logger.error('[ScheduledJobs] Bounty Liquid scanner error:', error);
            }
        });

        this.jobs.set('bounty_liquid_scanner', bountyLiquidJob);
        logger.info('[ScheduledJobs] Bounty Liquid payment scanner scheduled every 30 seconds');
    }

    /**
     * Check balance for a bounty address using LWK (can decrypt confidential amounts)
     * @param {number} addressIndex - Address derivation index
     * @param {string} paymentType - LIQUID_LBTC, LIQUID_USDT, or LIQUID_DEPIX
     * @param {string} liquidAddress - The Liquid address to check
     * @returns {Object|null} { amount, txid } or null if no payment found
     */
    async checkBountyAddressBalance(addressIndex, paymentType, liquidAddress) {
        // Map payment type to asset type for LWK
        const assetTypeMap = {
            'LIQUID_DEPIX': 'DEPIX',
            'LIQUID_LBTC': 'LBTC',
            'LIQUID_USDT': 'USDT'
        };

        const assetType = assetTypeMap[paymentType];
        if (!assetType) {
            logger.warn(`[BountyScanner] Unknown payment type: ${paymentType}`);
            return null;
        }

        try {
            const { execFile } = require('child_process');
            const { promisify } = require('util');
            const path = require('path');
            const execFileAsync = promisify(execFile);

            const LWK_SCRIPT_PATH = path.join(__dirname, '../../scripts/lwk_address.py');

            // Use LWK to check payment - it can decrypt confidential amounts
            const { stdout } = await execFileAsync('python3', [LWK_SCRIPT_PATH, 'check_payment', addressIndex.toString(), assetType], {
                timeout: 60000,
                env: { ...process.env, HOME: '/home/cmo' }
            });

            const result = JSON.parse(stdout.trim());

            if (!result.success) {
                logger.error(`[BountyScanner] LWK check_payment error: ${result.error}`);
                return null;
            }

            if (result.found && result.total_amount > 0) {
                logger.info(`[BountyScanner] LWK detected ${assetType} payment: index=${addressIndex}, amount=${result.total_amount}, txid=${result.txid}`);
                return {
                    amount: result.total_amount,
                    txid: result.txid,
                    assetType: assetType
                };
            }

            return null;

        } catch (error) {
            logger.error(`[BountyScanner] Error checking address balance via LWK: ${error.message}`);
            return null;
        }
    }

    /**
     * Track job execution in Redis for monitoring
     */
    async trackJobExecution(jobName, data) {
        try {
            const key = `job:${jobName}:last_execution`;
            await this.redisConnection.set(key, JSON.stringify(data), 'EX', 86400 * 7); // Keep for 7 days

            // Also track in a list for history
            const historyKey = `job:${jobName}:history`;
            await this.redisConnection.lpush(historyKey, JSON.stringify(data));
            await this.redisConnection.ltrim(historyKey, 0, 99); // Keep last 100 executions
        } catch (error) {
            logger.error(`[ScheduledJobs] Failed to track execution for ${jobName}:`, error);
        }
    }

    /**
     * Get job status for monitoring
     */
    async getJobStatus(jobName) {
        try {
            const key = `job:${jobName}:last_execution`;
            const data = await this.redisConnection.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            logger.error(`[ScheduledJobs] Failed to get status for ${jobName}:`, error);
            return null;
        }
    }

    /**
     * Manually trigger a job (for testing/admin purposes)
     * OPTIMIZED: Uses batch processing
     */
    async triggerJob(jobName) {
        switch (jobName) {
            case 'daily_limit_reset':
                const resetResult = await this.dbPool.query('SELECT reset_daily_limits()');
                return { success: true, usersReset: resetResult.rows[0].reset_daily_limits };

            case 'stats_recalculation':
                // Get all active users from last 7 days
                const activeUsers = await this.dbPool.query(`
                    SELECT DISTINCT user_id
                    FROM pix_transactions
                    WHERE created_at >= NOW() - INTERVAL '7 days'
                `);

                if (activeUsers.rowCount === 0) {
                    return { success: true, message: 'No active users to recalculate' };
                }

                // Use batch processing
                const userIds = activeUsers.rows.map(row => row.user_id);
                const result = await this.dbPool.query(
                    'SELECT batch_recalculate_user_stats($1::TEXT[])',
                    [userIds]
                );

                return { success: true, usersProcessed: result.rows[0].batch_recalculate_user_stats };

            case 'user_state_cleanup':
                const cleanupResult = await this.dbPool.query('SELECT cleanup_expired_user_states()');
                return { success: true, statesCleaned: cleanupResult.rows[0].cleanup_expired_user_states };

            default:
                throw new Error(`Unknown job: ${jobName}`);
        }
    }

    /**
     * Graceful shutdown - stop all scheduled jobs safely
     */
    async gracefulShutdown() {
        logger.info('[ScheduledJobs] Starting graceful shutdown...');
        this.isShuttingDown = true;

        // Wait a bit for any running jobs to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        for (const [name, job] of this.jobs) {
            try {
                job.stop();
                logger.info(`[ScheduledJobs] Stopped job: ${name}`);
            } catch (error) {
                logger.error(`[ScheduledJobs] Error stopping job ${name}:`, error);
            }
        }

        this.jobs.clear();
        logger.info('[ScheduledJobs] Graceful shutdown completed');
    }

    /**
     * Stop all scheduled jobs (legacy method, now calls gracefulShutdown)
     */
    stop() {
        return this.gracefulShutdown();
    }

    /**
     * Get status of all jobs
     */
    async getAllJobStatuses() {
        const statuses = {};

        for (const jobName of this.jobs.keys()) {
            statuses[jobName] = await this.getJobStatus(jobName);
        }

        return statuses;
    }
}

module.exports = ScheduledJobs;