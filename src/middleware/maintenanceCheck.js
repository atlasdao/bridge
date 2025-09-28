const logger = require('../core/logger');

// Admin IDs - same as in adminCommandsComplete.js
const ADMIN_IDS = process.env.ADMIN_TELEGRAM_IDS ?
    process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => parseInt(id.trim())) :
    [];

/**
 * Check if user is admin
 */
const isAdmin = (userId) => {
    return ADMIN_IDS.includes(userId);
};

/**
 * Maintenance mode middleware for Telegraf
 * Blocks all non-admin users when maintenance mode is active
 */
class MaintenanceMiddleware {
    constructor(redisConnection, dbPool) {
        this.redis = redisConnection;
        this.dbPool = dbPool;
        this.maintenanceCache = null;
        this.cacheExpiry = 0;
    }

    /**
     * Get maintenance mode status with caching
     */
    async getMaintenanceStatus() {
        try {
            // Check cache first (cache for 5 seconds to avoid Redis spam)
            const now = Date.now();
            if (this.maintenanceCache !== null && this.cacheExpiry > now) {
                return this.maintenanceCache;
            }

            // Check Redis first
            if (this.redis) {
                const redisStatus = await this.redis.get('maintenance_mode');
                if (redisStatus !== null) {
                    const status = {
                        enabled: redisStatus === '1' || redisStatus === 'true',
                        message: null
                    };

                    // Get maintenance message if enabled
                    if (status.enabled) {
                        const message = await this.redis.get('maintenance_message');
                        status.message = message || 'Sistema em manutenção. Voltaremos em breve!';
                    }

                    // Update cache
                    this.maintenanceCache = status;
                    this.cacheExpiry = now + 5000; // 5 second cache

                    return status;
                }
            }

            // Fallback to database
            if (this.dbPool) {
                const result = await this.dbPool.query(`
                    SELECT value, message
                    FROM system_config
                    WHERE key = 'maintenance_mode'
                    LIMIT 1
                `);

                if (result.rows.length > 0) {
                    const status = {
                        enabled: result.rows[0].value === 'true' || result.rows[0].value === '1',
                        message: result.rows[0].message || 'Sistema em manutenção. Voltaremos em breve!'
                    };

                    // Update Redis if available
                    if (this.redis) {
                        await this.redis.set('maintenance_mode', status.enabled ? '1' : '0');
                        if (status.message) {
                            await this.redis.set('maintenance_message', status.message);
                        }
                    }

                    // Update cache
                    this.maintenanceCache = status;
                    this.cacheExpiry = now + 5000;

                    return status;
                }
            }

            // Default: no maintenance
            const defaultStatus = { enabled: false, message: null };
            this.maintenanceCache = defaultStatus;
            this.cacheExpiry = now + 5000;
            return defaultStatus;

        } catch (error) {
            logger.error(`[MaintenanceMiddleware] Error checking maintenance status: ${error.message}`);
            // In case of error, allow access (fail open)
            return { enabled: false, message: null };
        }
    }

    /**
     * Set maintenance mode - FIXED to ensure proper persistence
     */
    async setMaintenanceMode(enabled, message = null) {
        try {
            // Update Redis with consistent format
            if (this.redis) {
                await this.redis.set('maintenance_mode', enabled ? '1' : '0');
                if (enabled && message) {
                    await this.redis.set('maintenance_message', message);
                } else {
                    await this.redis.del('maintenance_message');
                }
            }

            // Update database
            if (this.dbPool) {
                // Check if config exists
                const existing = await this.dbPool.query(
                    'SELECT id FROM system_config WHERE key = $1',
                    ['maintenance_mode']
                );

                if (existing.rows.length > 0) {
                    // Update existing
                    await this.dbPool.query(
                        'UPDATE system_config SET value = $1, message = $2, updated_at = NOW() WHERE key = $3',
                        [enabled ? 'true' : 'false', message, 'maintenance_mode']
                    );
                } else {
                    // Create new
                    await this.dbPool.query(
                        'INSERT INTO system_config (key, value, message, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())',
                        ['maintenance_mode', enabled ? 'true' : 'false', message]
                    );
                }
            }

            // Clear cache
            this.maintenanceCache = null;
            this.cacheExpiry = 0;

            logger.info(`[MaintenanceMiddleware] Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
            return true;
        } catch (error) {
            logger.error(`[MaintenanceMiddleware] Error setting maintenance mode: ${error.message}`);
            throw error;
        }
    }

    /**
     * Middleware function for Telegraf
     */
    middleware() {
        return async (ctx, next) => {
            try {
                // Get user ID from different event types
                const userId = ctx.from?.id ||
                              ctx.callbackQuery?.from?.id ||
                              ctx.message?.from?.id ||
                              ctx.update?.message?.from?.id;

                if (!userId) {
                    // If we can't determine user ID, allow (shouldn't happen)
                    return next();
                }

                // Always allow admins
                if (isAdmin(userId)) {
                    // Mark as admin for other middleware
                    ctx.isAdmin = true;
                    return next();
                }

                // Check maintenance mode
                const maintenance = await this.getMaintenanceStatus();

                if (maintenance.enabled) {
                    // Block non-admin users during maintenance
                    logger.info(`[MaintenanceMiddleware] Blocked non-admin user ${userId} during maintenance`);

                    // Send maintenance message
                    const message = `🔧 **Manutenção do Sistema**\n\n${maintenance.message}\n\nPedimos desculpas pelo transtorno.`;

                    try {
                        if (ctx.callbackQuery) {
                            await ctx.answerCbQuery('⚠️ Sistema em manutenção', true);
                            await ctx.editMessageText(message, { parse_mode: 'Markdown' });
                        } else {
                            await ctx.reply(message, { parse_mode: 'Markdown' });
                        }
                    } catch (e) {
                        // If we can't send message, just log it
                        logger.error(`[MaintenanceMiddleware] Could not send maintenance message: ${e.message}`);
                    }

                    // Don't continue to next middleware
                    return;
                }

                // Not in maintenance, continue normally
                return next();

            } catch (error) {
                logger.error(`[MaintenanceMiddleware] Error in middleware: ${error.message}`);
                // On error, allow access (fail open)
                return next();
            }
        };
    }

    /**
     * Check function for manual use
     */
    async isMaintenanceMode() {
        const status = await this.getMaintenanceStatus();
        return status.enabled;
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.maintenanceCache = null;
        this.cacheExpiry = 0;
    }
}

module.exports = { MaintenanceMiddleware, isAdmin };