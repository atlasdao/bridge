const logger = require('../core/logger');
const { Markup } = require('telegraf');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * AdminSystemOverhaul - Complete admin system overhaul with excellent UX
 * Fixes all persistence issues, navigation problems, and adds new features
 */
class AdminSystemOverhaul {
    constructor(bot, dbPool, redisClient) {
        this.bot = bot;
        this.dbPool = dbPool;
        this.redis = redisClient;

        // Cache for performance
        this.cache = new Map();
        this.cacheExpiry = new Map();

        // Admin IDs
        this.ADMIN_IDS = process.env.ADMIN_TELEGRAM_IDS ?
            process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => parseInt(id.trim())) :
            [];

        // Initialize database tables
        this.initializeTables();

        // State tracking for better UX
        this.userStates = new Map();
        this.navigationHistory = new Map();

        logger.info('[AdminOverhaul] System initialized with admins:', this.ADMIN_IDS);
    }

    /**
     * Initialize required database tables
     */
    async initializeTables() {
        try {
            // System configuration table
            await this.dbPool.query(`
                CREATE TABLE IF NOT EXISTS system_config (
                    id SERIAL PRIMARY KEY,
                    key VARCHAR(255) UNIQUE NOT NULL,
                    value TEXT,
                    description TEXT,
                    type VARCHAR(50) DEFAULT 'string',
                    metadata JSONB DEFAULT '{}',
                    updated_at TIMESTAMP DEFAULT NOW(),
                    updated_by INTEGER
                )
            `);

            // Admin activity log
            await this.dbPool.query(`
                CREATE TABLE IF NOT EXISTS admin_activity_log (
                    id SERIAL PRIMARY KEY,
                    admin_id INTEGER NOT NULL,
                    admin_username VARCHAR(255),
                    action VARCHAR(255) NOT NULL,
                    details JSONB DEFAULT '{}',
                    ip_address VARCHAR(45),
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // System alerts table
            await this.dbPool.query(`
                CREATE TABLE IF NOT EXISTS system_alerts (
                    id SERIAL PRIMARY KEY,
                    alert_type VARCHAR(50) NOT NULL,
                    severity VARCHAR(20) NOT NULL,
                    message TEXT NOT NULL,
                    details JSONB DEFAULT '{}',
                    resolved BOOLEAN DEFAULT false,
                    resolved_by INTEGER,
                    resolved_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // Quick actions table
            await this.dbPool.query(`
                CREATE TABLE IF NOT EXISTS admin_quick_actions (
                    id SERIAL PRIMARY KEY,
                    admin_id INTEGER NOT NULL,
                    action_name VARCHAR(100) NOT NULL,
                    action_data JSONB NOT NULL,
                    usage_count INTEGER DEFAULT 0,
                    last_used TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            logger.info('[AdminOverhaul] Database tables initialized');
        } catch (error) {
            logger.error('[AdminOverhaul] Error initializing tables:', error);
        }
    }

    /**
     * FIXED: Set maintenance mode with proper persistence
     */
    async setMaintenanceMode(enabled, message = null, adminId = null) {
        try {
            const defaultMessage = 'Sistema em manutenção. Voltaremos em breve!';
            const actualMessage = message || defaultMessage;

            // 1. Update Redis (use simple format for compatibility)
            if (this.redis) {
                await this.redis.set('maintenance_mode', enabled ? '1' : '0');
                if (enabled && actualMessage) {
                    await this.redis.set('maintenance_message', actualMessage);
                } else {
                    await this.redis.del('maintenance_message');
                }
            }

            // 2. Update database
            const existingConfig = await this.dbPool.query(
                'SELECT id FROM system_config WHERE key = $1',
                ['maintenance_mode']
            );

            if (existingConfig.rows.length > 0) {
                await this.dbPool.query(
                    `UPDATE system_config
                     SET value = $1,
                         description = $2,
                         updated_at = NOW(),
                         updated_by = $3,
                         metadata = $4
                     WHERE key = $5`,
                    [
                        enabled ? 'true' : 'false',
                        actualMessage,
                        adminId,
                        JSON.stringify({
                            enabled,
                            message: actualMessage,
                            updatedAt: new Date().toISOString()
                        }),
                        'maintenance_mode'
                    ]
                );
            } else {
                await this.dbPool.query(
                    `INSERT INTO system_config (key, value, description, metadata, updated_by)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [
                        'maintenance_mode',
                        enabled ? 'true' : 'false',
                        actualMessage,
                        JSON.stringify({
                            enabled,
                            message: actualMessage,
                            updatedAt: new Date().toISOString()
                        }),
                        adminId
                    ]
                );
            }

            // 3. Clear all caches
            this.cache.clear();
            this.cacheExpiry.clear();

            // 4. Log the action
            if (adminId) {
                await this.logAdminAction(adminId, 'MAINTENANCE_MODE_CHANGE', {
                    enabled,
                    message: actualMessage
                });
            }

            logger.info(`[AdminOverhaul] Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} successfully`);
            return { success: true, enabled, message: actualMessage };

        } catch (error) {
            logger.error('[AdminOverhaul] Error setting maintenance mode:', error);
            throw error;
        }
    }

    /**
     * FIXED: Get maintenance mode status with proper caching
     */
    async getMaintenanceStatus() {
        try {
            const cacheKey = 'maintenance_status';
            const now = Date.now();

            // Check cache (5 second TTL)
            if (this.cache.has(cacheKey) && this.cacheExpiry.get(cacheKey) > now) {
                return this.cache.get(cacheKey);
            }

            let status = { enabled: false, message: null };

            // 1. Try Redis first (fastest)
            if (this.redis) {
                const redisMode = await this.redis.get('maintenance_mode');
                if (redisMode !== null) {
                    status.enabled = redisMode === '1' || redisMode === 'true';
                    if (status.enabled) {
                        const redisMessage = await this.redis.get('maintenance_message');
                        status.message = redisMessage || 'Sistema em manutenção. Voltaremos em breve!';
                    }
                }
            }

            // 2. Fallback to database if Redis empty
            if (!status.enabled && this.dbPool) {
                const dbResult = await this.dbPool.query(
                    'SELECT value, description, metadata FROM system_config WHERE key = $1',
                    ['maintenance_mode']
                );

                if (dbResult.rows.length > 0) {
                    const row = dbResult.rows[0];
                    status.enabled = row.value === 'true' || row.value === '1';
                    status.message = row.description || 'Sistema em manutenção. Voltaremos em breve!';

                    // Sync to Redis if it was missing
                    if (this.redis) {
                        await this.redis.set('maintenance_mode', status.enabled ? '1' : '0');
                        if (status.message) {
                            await this.redis.set('maintenance_message', status.message);
                        }
                    }
                }
            }

            // Cache the result
            this.cache.set(cacheKey, status);
            this.cacheExpiry.set(cacheKey, now + 5000);

            return status;

        } catch (error) {
            logger.error('[AdminOverhaul] Error getting maintenance status:', error);
            return { enabled: false, message: null };
        }
    }

    /**
     * Get comprehensive system statistics
     */
    async getSystemStats() {
        try {
            const stats = {
                timestamp: new Date(),
                users: { total: 0, active24h: 0, new24h: 0 },
                transactions: { total: 0, today: 0, volume: 0 },
                system: { uptime: 0, memory: 0, cpu: 0 },
                alerts: { critical: 0, warning: 0, info: 0 }
            };

            // User statistics
            const userStats = await this.dbPool.query(`
                SELECT
                    COUNT(*) as total,
                    COUNT(CASE WHEN last_interaction > NOW() - INTERVAL '24 hours' THEN 1 END) as active_24h,
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as new_24h
                FROM users
            `);

            if (userStats.rows.length > 0) {
                stats.users = {
                    total: parseInt(userStats.rows[0].total || 0),
                    active24h: parseInt(userStats.rows[0].active_24h || 0),
                    new24h: parseInt(userStats.rows[0].new_24h || 0)
                };
            }

            // Transaction statistics
            const txStats = await this.dbPool.query(`
                SELECT
                    COUNT(*) as total,
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as today,
                    COALESCE(SUM(CASE WHEN status = 'CONFIRMED' THEN amount END), 0) as volume
                FROM transactions
            `);

            if (txStats.rows.length > 0) {
                stats.transactions = {
                    total: parseInt(txStats.rows[0].total || 0),
                    today: parseInt(txStats.rows[0].today || 0),
                    volume: parseFloat(txStats.rows[0].volume || 0)
                };
            }

            // System statistics
            stats.system = {
                uptime: process.uptime(),
                memory: process.memoryUsage().heapUsed / 1024 / 1024, // MB
                cpu: os.loadavg()[0]
            };

            // Alert statistics
            const alertStats = await this.dbPool.query(`
                SELECT
                    COUNT(CASE WHEN severity = 'critical' AND NOT resolved THEN 1 END) as critical,
                    COUNT(CASE WHEN severity = 'warning' AND NOT resolved THEN 1 END) as warning,
                    COUNT(CASE WHEN severity = 'info' AND NOT resolved THEN 1 END) as info
                FROM system_alerts
                WHERE created_at > NOW() - INTERVAL '7 days'
            `);

            if (alertStats.rows.length > 0) {
                stats.alerts = {
                    critical: parseInt(alertStats.rows[0].critical || 0),
                    warning: parseInt(alertStats.rows[0].warning || 0),
                    info: parseInt(alertStats.rows[0].info || 0)
                };
            }

            return stats;

        } catch (error) {
            logger.error('[AdminOverhaul] Error getting system stats:', error);
            return null;
        }
    }

    /**
     * Log admin action
     */
    async logAdminAction(adminId, action, details = {}) {
        try {
            const adminUser = await this.bot.telegram.getChat(adminId);
            await this.dbPool.query(
                `INSERT INTO admin_activity_log (admin_id, admin_username, action, details)
                 VALUES ($1, $2, $3, $4)`,
                [adminId, adminUser.username || 'Unknown', action, JSON.stringify(details)]
            );
        } catch (error) {
            logger.error('[AdminOverhaul] Error logging admin action:', error);
        }
    }

    /**
     * Create system alert
     */
    async createAlert(type, severity, message, details = {}) {
        try {
            await this.dbPool.query(
                `INSERT INTO system_alerts (alert_type, severity, message, details)
                 VALUES ($1, $2, $3, $4)`,
                [type, severity, message, JSON.stringify(details)]
            );

            // Notify all admins for critical alerts
            if (severity === 'critical') {
                await this.notifyAdmins(`🚨 ALERTA CRÍTICO\n\n${message}`, { important: true });
            }

        } catch (error) {
            logger.error('[AdminOverhaul] Error creating alert:', error);
        }
    }

    /**
     * Notify all admins
     */
    async notifyAdmins(message, options = {}) {
        const promises = this.ADMIN_IDS.map(async (adminId) => {
            try {
                await this.bot.telegram.sendMessage(adminId, message, {
                    parse_mode: 'Markdown',
                    disable_notification: !options.important
                });
            } catch (e) {
                logger.error(`[AdminOverhaul] Failed to notify admin ${adminId}:`, e.message);
            }
        });

        await Promise.allSettled(promises);
    }

    /**
     * Format uptime for display
     */
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);

        return parts.length > 0 ? parts.join(' ') : '< 1m';
    }

    /**
     * Format number with thousands separator
     */
    formatNumber(num) {
        return new Intl.NumberFormat('pt-BR').format(num);
    }

    /**
     * Format currency
     */
    formatCurrency(amount) {
        return new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency: 'BRL'
        }).format(amount);
    }

    /**
     * Store navigation state for better UX
     */
    setUserState(userId, state) {
        this.userStates.set(userId, state);
    }

    getUserState(userId) {
        return this.userStates.get(userId) || null;
    }

    clearUserState(userId) {
        this.userStates.delete(userId);
    }

    /**
     * Navigation history for back button functionality
     */
    pushNavigation(userId, menu) {
        if (!this.navigationHistory.has(userId)) {
            this.navigationHistory.set(userId, []);
        }
        const history = this.navigationHistory.get(userId);
        history.push(menu);
        // Keep only last 10 items
        if (history.length > 10) {
            history.shift();
        }
    }

    popNavigation(userId) {
        const history = this.navigationHistory.get(userId);
        if (history && history.length > 0) {
            return history.pop();
        }
        return 'main';
    }

    clearNavigation(userId) {
        this.navigationHistory.delete(userId);
    }

    /**
     * Execute system command safely
     */
    async executeCommand(command, timeout = 5000) {
        try {
            const { stdout, stderr } = await execAsync(command, { timeout });
            return { success: true, stdout, stderr };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Get recent admin activity
     */
    async getRecentActivity(limit = 10) {
        try {
            const result = await this.dbPool.query(
                `SELECT * FROM admin_activity_log
                 ORDER BY created_at DESC
                 LIMIT $1`,
                [limit]
            );
            return result.rows;
        } catch (error) {
            logger.error('[AdminOverhaul] Error getting recent activity:', error);
            return [];
        }
    }

    /**
     * Get system configuration value
     */
    async getConfig(key, defaultValue = null) {
        try {
            const result = await this.dbPool.query(
                'SELECT value, metadata FROM system_config WHERE key = $1',
                [key]
            );

            if (result.rows.length > 0) {
                return result.rows[0].value;
            }

            return defaultValue;
        } catch (error) {
            logger.error('[AdminOverhaul] Error getting config:', error);
            return defaultValue;
        }
    }

    /**
     * Set system configuration value
     */
    async setConfig(key, value, description = null, adminId = null) {
        try {
            const existing = await this.dbPool.query(
                'SELECT id FROM system_config WHERE key = $1',
                [key]
            );

            if (existing.rows.length > 0) {
                await this.dbPool.query(
                    `UPDATE system_config
                     SET value = $1, description = $2, updated_at = NOW(), updated_by = $3
                     WHERE key = $4`,
                    [value, description, adminId, key]
                );
            } else {
                await this.dbPool.query(
                    `INSERT INTO system_config (key, value, description, updated_by)
                     VALUES ($1, $2, $3, $4)`,
                    [key, value, description, adminId]
                );
            }

            // Clear cache
            this.cache.delete(`config_${key}`);

            return true;
        } catch (error) {
            logger.error('[AdminOverhaul] Error setting config:', error);
            return false;
        }
    }

    /**
     * Check if user is admin
     */
    isAdmin(userId) {
        return this.ADMIN_IDS.includes(userId);
    }

    /**
     * Get admin info
     */
    async getAdminInfo(adminId) {
        try {
            const user = await this.bot.telegram.getChat(adminId);
            return {
                id: user.id,
                username: user.username,
                firstName: user.first_name,
                lastName: user.last_name
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Clean up old data
     */
    async cleanupOldData(days = 30) {
        try {
            // Clean old logs
            await this.dbPool.query(
                'DELETE FROM admin_activity_log WHERE created_at < NOW() - INTERVAL $1',
                [`${days} days`]
            );

            // Clean resolved alerts
            await this.dbPool.query(
                'DELETE FROM system_alerts WHERE resolved = true AND resolved_at < NOW() - INTERVAL $1',
                [`${days} days`]
            );

            logger.info(`[AdminOverhaul] Cleaned up data older than ${days} days`);
            return true;
        } catch (error) {
            logger.error('[AdminOverhaul] Error cleaning up old data:', error);
            return false;
        }
    }
}

module.exports = AdminSystemOverhaul;