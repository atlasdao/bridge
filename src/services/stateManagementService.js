/**
 * State Management Service
 * Handles user state with automatic TTL and cleanup to prevent memory leaks
 * Can use either in-memory storage with TTL or Redis for persistence
 */

const logger = require('../core/logger');

class StateManagementService {
    constructor(redisConnection = null, dbPool = null) {
        this.redisConnection = redisConnection;
        this.dbPool = dbPool;
        this.useRedis = !!redisConnection;
        this.useDatabase = !!dbPool;

        // In-memory fallback with TTL tracking
        this.memoryStore = new Map();
        this.expiryTimers = new Map();

        // Default TTL: 15 minutes
        this.defaultTTL = 15 * 60 * 1000; // milliseconds for in-memory
        this.defaultRedisTTL = 900; // seconds for Redis

        // Cleanup interval for in-memory storage
        this.cleanupInterval = null;

        // Start periodic cleanup if using in-memory storage
        if (!this.useRedis && !this.useDatabase) {
            this.startMemoryCleanup();
        }

        logger.info(`[StateManagement] Initialized with ${this.getStorageType()} storage`);
    }

    /**
     * Get storage type for logging
     */
    getStorageType() {
        if (this.useRedis) return 'Redis';
        if (this.useDatabase) return 'Database';
        return 'In-Memory';
    }

    /**
     * Set user state with automatic TTL
     */
    async setState(userId, stateType, stateData, ttlMs = null) {
        const ttl = ttlMs || this.defaultTTL;

        try {
            if (this.useRedis) {
                // Use Redis with automatic expiry
                const key = `user_state:${userId}:${stateType}`;
                const ttlSeconds = Math.ceil(ttl / 1000);

                await this.redisConnection.set(
                    key,
                    JSON.stringify({
                        type: stateType,
                        data: stateData,
                        createdAt: Date.now()
                    }),
                    'EX',
                    ttlSeconds
                );

                logger.debug(`[StateManagement] Set Redis state for user ${userId}, type: ${stateType}, TTL: ${ttlSeconds}s`);

            } else if (this.useDatabase) {
                // Use database with expires_at timestamp
                const expiresAt = new Date(Date.now() + ttl);

                await this.dbPool.query(`
                    INSERT INTO bot_user_states (user_id, state_type, state_data, expires_at, updated_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT (user_id)
                    DO UPDATE SET
                        state_type = $2,
                        state_data = $3,
                        expires_at = $4,
                        updated_at = NOW()
                `, [userId, stateType, JSON.stringify(stateData), expiresAt]);

                logger.debug(`[StateManagement] Set DB state for user ${userId}, type: ${stateType}, expires: ${expiresAt.toISOString()}`);

            } else {
                // Use in-memory storage with timer-based cleanup
                const key = `${userId}:${stateType}`;

                // Clear existing timer if any
                if (this.expiryTimers.has(key)) {
                    clearTimeout(this.expiryTimers.get(key));
                }

                // Store state
                this.memoryStore.set(key, {
                    type: stateType,
                    data: stateData,
                    createdAt: Date.now(),
                    expiresAt: Date.now() + ttl
                });

                // Set cleanup timer
                const timer = setTimeout(() => {
                    this.memoryStore.delete(key);
                    this.expiryTimers.delete(key);
                    logger.debug(`[StateManagement] Auto-expired memory state for user ${userId}, type: ${stateType}`);
                }, ttl);

                this.expiryTimers.set(key, timer);

                logger.debug(`[StateManagement] Set memory state for user ${userId}, type: ${stateType}, TTL: ${ttl}ms`);
            }

            return true;

        } catch (error) {
            logger.error(`[StateManagement] Error setting state for user ${userId}:`, error);
            return false;
        }
    }

    /**
     * Get user state
     */
    async getState(userId, stateType) {
        try {
            if (this.useRedis) {
                const key = `user_state:${userId}:${stateType}`;
                const data = await this.redisConnection.get(key);

                if (!data) return null;

                const parsed = JSON.parse(data);
                return parsed.data;

            } else if (this.useDatabase) {
                const result = await this.dbPool.query(`
                    SELECT state_data
                    FROM bot_user_states
                    WHERE user_id = $1
                        AND state_type = $2
                        AND expires_at > NOW()
                `, [userId, stateType]);

                if (result.rows.length === 0) return null;

                return result.rows[0].state_data;

            } else {
                const key = `${userId}:${stateType}`;
                const state = this.memoryStore.get(key);

                if (!state) return null;

                // Check if expired
                if (Date.now() > state.expiresAt) {
                    this.clearState(userId, stateType);
                    return null;
                }

                return state.data;
            }

        } catch (error) {
            logger.error(`[StateManagement] Error getting state for user ${userId}:`, error);
            return null;
        }
    }

    /**
     * Clear specific user state
     */
    async clearState(userId, stateType) {
        try {
            if (this.useRedis) {
                const key = `user_state:${userId}:${stateType}`;
                await this.redisConnection.del(key);

            } else if (this.useDatabase) {
                await this.dbPool.query(`
                    DELETE FROM bot_user_states
                    WHERE user_id = $1 AND state_type = $2
                `, [userId, stateType]);

            } else {
                const key = `${userId}:${stateType}`;

                // Clear timer
                if (this.expiryTimers.has(key)) {
                    clearTimeout(this.expiryTimers.get(key));
                    this.expiryTimers.delete(key);
                }

                // Clear state
                this.memoryStore.delete(key);
            }

            logger.debug(`[StateManagement] Cleared state for user ${userId}, type: ${stateType}`);
            return true;

        } catch (error) {
            logger.error(`[StateManagement] Error clearing state for user ${userId}:`, error);
            return false;
        }
    }

    /**
     * Clear all states for a user
     */
    async clearAllUserStates(userId) {
        try {
            if (this.useRedis) {
                const pattern = `user_state:${userId}:*`;
                const keys = await this.redisConnection.keys(pattern);

                if (keys.length > 0) {
                    await this.redisConnection.del(...keys);
                }

            } else if (this.useDatabase) {
                await this.dbPool.query(`
                    DELETE FROM bot_user_states
                    WHERE user_id = $1
                `, [userId]);

            } else {
                // Find all keys for this user
                const userKeys = Array.from(this.memoryStore.keys()).filter(key =>
                    key.startsWith(`${userId}:`)
                );

                for (const key of userKeys) {
                    // Clear timer
                    if (this.expiryTimers.has(key)) {
                        clearTimeout(this.expiryTimers.get(key));
                        this.expiryTimers.delete(key);
                    }

                    // Clear state
                    this.memoryStore.delete(key);
                }
            }

            logger.debug(`[StateManagement] Cleared all states for user ${userId}`);
            return true;

        } catch (error) {
            logger.error(`[StateManagement] Error clearing all states for user ${userId}:`, error);
            return false;
        }
    }

    /**
     * Check if user has a specific state
     */
    async hasState(userId, stateType) {
        const state = await this.getState(userId, stateType);
        return state !== null;
    }

    /**
     * Start periodic cleanup for in-memory storage
     */
    startMemoryCleanup() {
        // Run cleanup every 5 minutes
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            let cleaned = 0;

            for (const [key, state] of this.memoryStore.entries()) {
                if (now > state.expiresAt) {
                    this.memoryStore.delete(key);

                    // Clear timer if exists
                    if (this.expiryTimers.has(key)) {
                        clearTimeout(this.expiryTimers.get(key));
                        this.expiryTimers.delete(key);
                    }

                    cleaned++;
                }
            }

            if (cleaned > 0) {
                logger.info(`[StateManagement] Cleaned up ${cleaned} expired memory states`);
            }

        }, 5 * 60 * 1000); // 5 minutes

        logger.info('[StateManagement] Started periodic memory cleanup (5-minute interval)');
    }

    /**
     * Stop cleanup interval (for graceful shutdown)
     */
    stopCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        // Clear all timers
        for (const timer of this.expiryTimers.values()) {
            clearTimeout(timer);
        }
        this.expiryTimers.clear();

        logger.info('[StateManagement] Stopped cleanup processes');
    }

    /**
     * Get statistics about current states
     */
    async getStats() {
        try {
            if (this.useRedis) {
                const keys = await this.redisConnection.keys('user_state:*');
                return {
                    storage: 'Redis',
                    totalStates: keys.length
                };

            } else if (this.useDatabase) {
                const result = await this.dbPool.query(`
                    SELECT COUNT(*) as total,
                           COUNT(CASE WHEN expires_at > NOW() THEN 1 END) as active
                    FROM bot_user_states
                `);

                return {
                    storage: 'Database',
                    totalStates: parseInt(result.rows[0].total),
                    activeStates: parseInt(result.rows[0].active)
                };

            } else {
                return {
                    storage: 'In-Memory',
                    totalStates: this.memoryStore.size,
                    activeTimers: this.expiryTimers.size
                };
            }

        } catch (error) {
            logger.error('[StateManagement] Error getting stats:', error);
            return { error: error.message };
        }
    }

    /**
     * Migrate from old awaitingInputForUser format to new state management
     */
    migrateFromOldFormat(awaitingInputForUser) {
        let migrated = 0;

        for (const [userId, stateData] of Object.entries(awaitingInputForUser)) {
            // Determine state type from old data
            let stateType = 'awaiting_input';

            if (stateData.type) {
                stateType = stateData.type;
            } else if (stateData.expectingLiquidAddress) {
                stateType = 'awaiting_address';
            } else if (stateData.expectingAmount) {
                stateType = 'awaiting_amount';
            }

            // Set new state with default TTL
            this.setState(userId, stateType, stateData);
            migrated++;
        }

        if (migrated > 0) {
            logger.info(`[StateManagement] Migrated ${migrated} old states to new format`);
        }

        return migrated;
    }
}

module.exports = StateManagementService;