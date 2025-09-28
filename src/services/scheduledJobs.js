const cron = require('node-cron');
const logger = require('../core/logger');

class ScheduledJobs {
    constructor(dbPool, redisConnection) {
        this.dbPool = dbPool;
        this.redisConnection = redisConnection;
        this.jobs = new Map();
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

        logger.info('[ScheduledJobs] All jobs initialized');
    }

    /**
     * Schedule daily limit reset at midnight Brazil time
     */
    scheduleDailyLimitReset() {
        // Run at 00:00 Brazil time (03:00 UTC)
        const resetJob = cron.schedule('0 3 * * *', async () => {
            logger.info('[ScheduledJobs] Starting daily limit reset...');

            try {
                const result = await this.dbPool.query('SELECT reset_daily_limits()');
                const resetCount = result.rows[0].reset_daily_limits;

                logger.info(`[ScheduledJobs] Daily limits reset for ${resetCount} users`);

                await this.trackJobExecution('daily_limit_reset', {
                    success: true,
                    usersReset: resetCount,
                    executedAt: new Date().toISOString()
                });

            } catch (error) {
                logger.error('[ScheduledJobs] Daily limit reset failed:', error);

                await this.trackJobExecution('daily_limit_reset', {
                    success: false,
                    error: error.message,
                    executedAt: new Date().toISOString()
                });
            }
        }, {
            scheduled: true,
            timezone: "America/Sao_Paulo"
        });

        this.jobs.set('daily_limit_reset', resetJob);
        logger.info('[ScheduledJobs] Daily limit reset scheduled for 00:00 Brazil time');
    }

    /**
     * Schedule stats recalculation with optimized batch processing
     * FIXED: N+1 query problem
     */
    scheduleStatsRecalculation() {
        // Run every hour at minute 15
        const statsJob = cron.schedule('15 * * * *', async () => {
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

                // OPTIMIZED: Batch process all users in a single query
                const recalcResult = await this.dbPool.query(
                    'SELECT batch_recalculate_user_stats($1::TEXT[])',
                    [userIds]
                );

                const recalculated = recalcResult.rows[0].batch_recalculate_user_stats;

                // Alternative approach: Direct batch update (even more efficient)
                // This updates all user stats in a single query without calling stored procedures
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
     */
    async checkPendingUpgrades() {
        try {
            // Get all users eligible for upgrade
            const eligibleUsers = await this.dbPool.query(`
                SELECT
                    u.telegram_user_id,
                    u.reputation_level,
                    u.completed_transactions,
                    u.total_volume_brl,
                    rlc.level as next_level,
                    rlc.min_transactions_for_upgrade as next_tx_req,
                    rlc.min_volume_for_upgrade as next_vol_req
                FROM users u
                JOIN reputation_levels_config rlc ON rlc.level = u.reputation_level + 1
                WHERE
                    u.is_verified = true
                    AND u.is_banned = false
                    AND u.reputation_level < 10
                    AND u.completed_transactions >= rlc.min_transactions_for_upgrade
                    AND u.total_volume_brl >= rlc.min_volume_for_upgrade
                    AND (u.last_level_upgrade IS NULL OR u.last_level_upgrade < NOW() - INTERVAL '24 hours')
            `);

            if (eligibleUsers.rowCount === 0) {
                return;
            }

            // Batch upgrade all eligible users
            const userIds = eligibleUsers.rows.map(user => user.telegram_user_id);

            // Perform batch upgrade
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
                        AND u.completed_transactions >= rlc.min_transactions_for_upgrade
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
            logger.debug('[ScheduledJobs] Cleaning up expired user states...');

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
     * Stop all scheduled jobs
     */
    stop() {
        logger.info('[ScheduledJobs] Stopping all scheduled jobs...');

        for (const [name, job] of this.jobs) {
            job.stop();
            logger.info(`[ScheduledJobs] Stopped job: ${name}`);
        }

        this.jobs.clear();
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