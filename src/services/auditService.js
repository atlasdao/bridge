const logger = require('../core/logger');

class AuditService {
    constructor(dbPool) {
        this.dbPool = dbPool;
    }

    /**
     * Registra ação administrativa
     */
    async logAdminAction(action) {
        const {
            adminId,
            adminUsername,
            actionType,
            actionDescription,
            targetUserId = null,
            targetUsername = null,
            metadata = {},
            ipAddress = null
        } = action;

        try {
            await this.dbPool.query(
                `INSERT INTO admin_audit_log (
                    admin_id,
                    admin_username,
                    action_type,
                    action_description,
                    target_user_id,
                    target_username,
                    metadata,
                    ip_address,
                    created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
                [
                    adminId,
                    adminUsername,
                    actionType,
                    actionDescription,
                    targetUserId,
                    targetUsername,
                    JSON.stringify(metadata),
                    ipAddress
                ]
            );

            logger.info(`[Audit] Admin ${adminUsername} (${adminId}): ${actionType} - ${actionDescription}`);
        } catch (error) {
            logger.error(`[Audit] Erro ao registrar ação: ${error.message}`);
            // Não lançar erro para não interromper a operação principal
        }
    }

    /**
     * Busca logs de auditoria com filtros
     */
    async getAuditLogs(filters = {}) {
        const {
            adminId = null,
            actionType = null,
            targetUserId = null,
            startDate = null,
            endDate = null,
            limit = 100,
            offset = 0
        } = filters;

        let query = `
            SELECT
                id,
                admin_id,
                admin_username,
                action_type,
                action_description,
                target_user_id,
                target_username,
                metadata,
                ip_address,
                created_at
            FROM admin_audit_log
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 1;

        if (adminId) {
            query += ` AND admin_id = $${paramCount++}`;
            params.push(adminId);
        }

        if (actionType) {
            query += ` AND action_type = $${paramCount++}`;
            params.push(actionType);
        }

        if (targetUserId) {
            query += ` AND target_user_id = $${paramCount++}`;
            params.push(targetUserId);
        }

        if (startDate) {
            query += ` AND created_at >= $${paramCount++}`;
            params.push(startDate);
        }

        if (endDate) {
            query += ` AND created_at <= $${paramCount++}`;
            params.push(endDate);
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount}`;
        params.push(limit, offset);

        const result = await this.dbPool.query(query, params);
        return result.rows;
    }

    /**
     * Obtém estatísticas de auditoria
     */
    async getAuditStats(adminId = null) {
        let query = `
            SELECT
                COUNT(*) as total_actions,
                COUNT(DISTINCT admin_id) as total_admins,
                COUNT(DISTINCT action_type) as action_types,
                COUNT(DISTINCT DATE(created_at)) as active_days,
                MAX(created_at) as last_action
            FROM admin_audit_log
        `;
        const params = [];

        if (adminId) {
            query += ' WHERE admin_id = $1';
            params.push(adminId);
        }

        const result = await this.dbPool.query(query, params);
        return result.rows[0];
    }

    /**
     * Tipos de ação padronizados
     */
    static ActionTypes = {
        // Broadcasts
        BROADCAST_SENT: 'broadcast_sent',
        BROADCAST_SCHEDULED: 'broadcast_scheduled',
        BROADCAST_CANCELLED: 'broadcast_cancelled',

        // Gerenciamento de usuários
        USER_BANNED: 'user_banned',
        USER_UNBANNED: 'user_unbanned',
        USER_VERIFIED: 'user_verified',
        USER_UNVERIFIED: 'user_unverified',
        USER_EDITED: 'user_edited',
        USER_LIMIT_RESET: 'user_limit_reset',
        USER_REPUTATION_CHANGED: 'user_reputation_changed',

        // Sistema
        SYSTEM_CONFIG_CHANGED: 'system_config_changed',
        SYSTEM_MAINTENANCE_ENABLED: 'system_maintenance_enabled',
        SYSTEM_MAINTENANCE_DISABLED: 'system_maintenance_disabled',
        SYSTEM_CACHE_CLEARED: 'system_cache_cleared',
        SYSTEM_BACKUP_CREATED: 'system_backup_created',

        // Segurança
        ADMIN_LOGIN: 'admin_login',
        ADMIN_LOGOUT: 'admin_logout',
        ADMIN_2FA_ENABLED: 'admin_2fa_enabled',
        ADMIN_2FA_DISABLED: 'admin_2fa_disabled',
        ADMIN_PERMISSION_CHANGED: 'admin_permission_changed',

        // Dados
        DATA_EXPORTED: 'data_exported',
        DATA_IMPORTED: 'data_imported',
        DATA_DELETED: 'data_deleted'
    };

    /**
     * Limpa logs antigos (manutenção)
     */
    async cleanupOldLogs(daysToKeep = 90) {
        try {
            const result = await this.dbPool.query(
                `DELETE FROM admin_audit_log
                 WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'
                 RETURNING id`
            );

            logger.info(`[Audit] ${result.rowCount} logs antigos removidos`);
            return result.rowCount;
        } catch (error) {
            logger.error(`[Audit] Erro ao limpar logs: ${error.message}`);
            throw error;
        }
    }

    /**
     * Exporta logs para CSV
     */
    async exportLogsToCSV(filters = {}) {
        const logs = await this.getAuditLogs({ ...filters, limit: 10000 });

        const csv = [
            'ID,Admin ID,Admin Username,Action Type,Description,Target User ID,Target Username,Created At',
            ...logs.map(log =>
                `${log.id},${log.admin_id},${log.admin_username},${log.action_type},"${log.action_description}",${log.target_user_id || ''},${log.target_username || ''},${log.created_at}`
            )
        ].join('\n');

        return csv;
    }

    /**
     * Obtém estatísticas de auditoria
     */
    async getAuditStatistics() {
        try {
            // Estatísticas por tipo de ação
            const actionCountsResult = await this.dbPool.query(`
                SELECT
                    action_type,
                    COUNT(*) as count
                FROM admin_audit_log
                WHERE created_at > NOW() - INTERVAL '30 days'
                GROUP BY action_type
                ORDER BY count DESC
            `);

            const actionCounts = {};
            actionCountsResult.rows.forEach(row => {
                actionCounts[row.action_type] = parseInt(row.count);
            });

            // Estatísticas por admin
            const adminActionsResult = await this.dbPool.query(`
                SELECT
                    admin_id,
                    admin_username as username,
                    COUNT(*) as action_count
                FROM admin_audit_log
                WHERE created_at > NOW() - INTERVAL '30 days'
                GROUP BY admin_id, admin_username
                ORDER BY action_count DESC
                LIMIT 10
            `);

            // Contadores de período
            const periodStatsResult = await this.dbPool.query(`
                SELECT
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '1 day' THEN 1 END) as actions_today,
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as actions_week,
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as actions_month
                FROM admin_audit_log
            `);

            const periodStats = periodStatsResult.rows[0];

            return {
                actionCounts,
                adminActions: adminActionsResult.rows.map(row => ({
                    adminId: row.admin_id,
                    username: row.username,
                    actionCount: parseInt(row.action_count)
                })),
                actionsToday: parseInt(periodStats.actions_today || 0),
                actionsWeek: parseInt(periodStats.actions_week || 0),
                actionsMonth: parseInt(periodStats.actions_month || 0)
            };
        } catch (error) {
            logger.error(`[Audit] Erro ao obter estatísticas: ${error.message}`);
            return {
                actionCounts: {},
                adminActions: [],
                actionsToday: 0,
                actionsWeek: 0,
                actionsMonth: 0
            };
        }
    }
}

module.exports = AuditService;