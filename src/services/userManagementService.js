const logger = require('../core/logger');

class UserManagementService {
    constructor(dbPool, auditService) {
        this.dbPool = dbPool;
        this.auditService = auditService;
    }

    /**
     * Busca usuários com filtros e paginação
     */
    async searchUsers(filters = {}) {
        const {
            searchTerm = null,
            isVerified = null,
            isBanned = null,
            isMerchant = null,
            hasWallet = null,
            minReputation = null,
            maxReputation = null,
            minVolume = null,
            maxVolume = null,
            lastActiveDays = null,
            sortBy = 'created_at',
            sortOrder = 'DESC',
            limit = 10,
            offset = 0
        } = filters;

        let query = `
            SELECT
                telegram_user_id,
                telegram_username,
                telegram_full_name,
                liquid_address,
                is_verified,
                is_banned,
                is_merchant,
                reputation_level,
                total_volume_brl,
                completed_transactions,
                daily_limit_brl,
                daily_used_brl,
                created_at,
                updated_at,
                bot_blocked,
                payer_name,
                payer_cpf_cnpj
            FROM users
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 1;

        // Busca por termo (ID, username ou nome)
        if (searchTerm) {
            query += ` AND (
                telegram_user_id::text LIKE $${paramCount} OR
                LOWER(telegram_username) LIKE LOWER($${paramCount}) OR
                LOWER(telegram_full_name) LIKE LOWER($${paramCount}) OR
                LOWER(payer_name) LIKE LOWER($${paramCount})
            )`;
            params.push(`%${searchTerm}%`);
            paramCount++;
        }

        if (isVerified !== null) {
            query += ` AND is_verified = $${paramCount++}`;
            params.push(isVerified);
        }

        if (isBanned !== null) {
            query += ` AND is_banned = $${paramCount++}`;
            params.push(isBanned);
        }

        if (isMerchant !== null) {
            query += ` AND is_merchant = $${paramCount++}`;
            params.push(isMerchant);
        }

        if (hasWallet !== null) {
            if (hasWallet) {
                query += ' AND liquid_address IS NOT NULL';
            } else {
                query += ' AND liquid_address IS NULL';
            }
        }

        if (minReputation !== null) {
            query += ` AND reputation_level >= $${paramCount++}`;
            params.push(minReputation);
        }

        if (maxReputation !== null) {
            query += ` AND reputation_level <= $${paramCount++}`;
            params.push(maxReputation);
        }

        if (minVolume !== null) {
            query += ` AND total_volume_brl >= $${paramCount++}`;
            params.push(minVolume);
        }

        if (maxVolume !== null) {
            query += ` AND total_volume_brl <= $${paramCount++}`;
            params.push(maxVolume);
        }

        if (lastActiveDays !== null) {
            query += ` AND updated_at > NOW() - INTERVAL '${parseInt(lastActiveDays)} days'`;
        }

        // Validar ordenação
        const allowedSortColumns = ['created_at', 'updated_at', 'reputation_level', 'total_volume_brl', 'telegram_user_id'];
        const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';
        const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        query += ` ORDER BY ${sortColumn} ${order}`;
        query += ` LIMIT $${paramCount++} OFFSET $${paramCount}`;
        params.push(limit, offset);

        const result = await this.dbPool.query(query, params);

        // Obter contagem total
        let countQuery = query.replace(
            /SELECT[\s\S]*?FROM users/,
            'SELECT COUNT(*) as total FROM users'
        ).replace(/ORDER BY[\s\S]*$/, '');

        const countParams = params.slice(0, -2); // Remove limit e offset
        const countResult = await this.dbPool.query(countQuery, countParams);

        return {
            users: result.rows,
            total: parseInt(countResult.rows[0].total),
            limit,
            offset
        };
    }

    /**
     * Obtém detalhes completos de um usuário
     */
    async getUserDetails(telegramUserId) {
        const userResult = await this.dbPool.query(
            'SELECT * FROM users WHERE telegram_user_id = $1',
            [telegramUserId]
        );

        if (userResult.rows.length === 0) {
            throw new Error('Usuário não encontrado');
        }

        const user = userResult.rows[0];

        // Buscar transações recentes
        const transactionsResult = await this.dbPool.query(
            `SELECT
                id,
                pix_id,
                status,
                amount,
                fee,
                net_amount,
                created_at,
                updated_at
            FROM pix_transactions
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 10`,
            [telegramUserId]
        );

        // Buscar histórico de banimento
        const banHistoryResult = await this.dbPool.query(
            `SELECT
                action,
                reason,
                admin_id,
                created_at
            FROM ban_history
            WHERE telegram_user_id = $1
            ORDER BY created_at DESC
            LIMIT 5`,
            [telegramUserId]
        );

        // Buscar histórico de reputação
        const reputationHistoryResult = await this.dbPool.query(
            `SELECT
                old_level,
                new_level,
                reason,
                created_at
            FROM reputation_level_history
            WHERE telegram_user_id = $1
            ORDER BY created_at DESC
            LIMIT 5`,
            [telegramUserId]
        );

        return {
            user,
            recentTransactions: transactionsResult.rows,
            banHistory: banHistoryResult.rows,
            reputationHistory: reputationHistoryResult.rows
        };
    }

    /**
     * Bane um usuário
     */
    async banUser(telegramUserId, adminId, adminUsername, reason) {
        const client = await this.dbPool.connect();
        try {
            await client.query('BEGIN');

            // Atualizar usuário
            await client.query(
                `UPDATE users
                 SET is_banned = true,
                     ban_reason = $1,
                     banned_at = NOW(),
                     banned_by = $2,
                     updated_at = NOW()
                 WHERE telegram_user_id = $3`,
                [reason, adminUsername, telegramUserId]
            );

            // Registrar no histórico
            await client.query(
                `INSERT INTO ban_history (
                    telegram_user_id,
                    action,
                    reason,
                    performed_by,
                    performed_at
                ) VALUES ($1, 'ban', $2, $3, NOW())`,
                [telegramUserId, reason, adminUsername || adminId.toString()]
            );

            await client.query('COMMIT');

            // Registrar auditoria
            await this.auditService.logAdminAction({
                adminId,
                adminUsername,
                actionType: 'user_banned',
                actionDescription: `Usuário ${telegramUserId} banido. Motivo: ${reason}`,
                targetUserId: telegramUserId
            });

            logger.info(`[UserManagement] Usuário ${telegramUserId} banido por ${adminUsername}`);
            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error(`[UserManagement] Erro ao banir usuário: ${error.message}`);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Desbane um usuário
     */
    async unbanUser(telegramUserId, adminId, adminUsername, reason = 'Desbanimento administrativo') {
        const client = await this.dbPool.connect();
        try {
            await client.query('BEGIN');

            // Atualizar usuário
            await client.query(
                `UPDATE users
                 SET is_banned = false,
                     ban_reason = NULL,
                     banned_at = NULL,
                     banned_by = NULL,
                     updated_at = NOW()
                 WHERE telegram_user_id = $1`,
                [telegramUserId]
            );

            // Registrar no histórico
            await client.query(
                `INSERT INTO ban_history (
                    telegram_user_id,
                    action,
                    reason,
                    performed_by,
                    performed_at
                ) VALUES ($1, 'unban', $2, $3, NOW())`,
                [telegramUserId, reason, adminUsername || adminId.toString()]
            );

            await client.query('COMMIT');

            // Registrar auditoria
            await this.auditService.logAdminAction({
                adminId,
                adminUsername,
                actionType: 'user_unbanned',
                actionDescription: `Usuário ${telegramUserId} desbanido. Motivo: ${reason}`,
                targetUserId: telegramUserId
            });

            logger.info(`[UserManagement] Usuário ${telegramUserId} desbanido por ${adminUsername}`);
            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error(`[UserManagement] Erro ao desbanir usuário: ${error.message}`);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Altera nível de reputação
     */
    async changeUserReputation(telegramUserId, newLevel, adminId, adminUsername, reason) {
        const client = await this.dbPool.connect();
        try {
            await client.query('BEGIN');

            // Obter nível atual
            const currentResult = await client.query(
                'SELECT reputation_level FROM users WHERE telegram_user_id = $1',
                [telegramUserId]
            );

            if (currentResult.rows.length === 0) {
                throw new Error('Usuário não encontrado');
            }

            const oldLevel = currentResult.rows[0].reputation_level;

            // Atualizar reputação
            await client.query(
                `UPDATE users
                 SET reputation_level = $1,
                     updated_at = NOW()
                 WHERE telegram_user_id = $2`,
                [newLevel, telegramUserId]
            );

            // Registrar histórico
            await client.query(
                `INSERT INTO reputation_level_history (
                    telegram_user_id,
                    old_level,
                    new_level,
                    reason,
                    admin_id,
                    created_at
                ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                [telegramUserId, oldLevel, newLevel, reason, adminId]
            );

            await client.query('COMMIT');

            // Registrar auditoria
            await this.auditService.logAdminAction({
                adminId,
                adminUsername,
                actionType: 'user_reputation_changed',
                actionDescription: `Reputação alterada de ${oldLevel} para ${newLevel}. Motivo: ${reason}`,
                targetUserId: telegramUserId,
                metadata: { oldLevel, newLevel }
            });

            logger.info(`[UserManagement] Reputação de ${telegramUserId} alterada de ${oldLevel} para ${newLevel}`);
            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error(`[UserManagement] Erro ao alterar reputação: ${error.message}`);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Reseta limites diários de um usuário
     */
    async resetUserLimits(telegramUserId, adminId, adminUsername) {
        try {
            await this.dbPool.query(
                `UPDATE users
                 SET daily_used_brl = 0,
                     last_limit_reset = NOW(),
                     updated_at = NOW()
                 WHERE telegram_user_id = $1`,
                [telegramUserId]
            );

            // Registrar auditoria
            await this.auditService.logAdminAction({
                adminId,
                adminUsername,
                actionType: 'user_limit_reset',
                actionDescription: `Limites diários resetados para usuário ${telegramUserId}`,
                targetUserId: telegramUserId
            });

            logger.info(`[UserManagement] Limites resetados para usuário ${telegramUserId}`);
            return true;
        } catch (error) {
            logger.error(`[UserManagement] Erro ao resetar limites: ${error.message}`);
            throw error;
        }
    }

    /**
     * Verifica manualmente um usuário
     */
    async verifyUser(telegramUserId, adminId, adminUsername) {
        try {
            await this.dbPool.query(
                `UPDATE users
                 SET is_verified = true,
                     verification_status = 'verified',
                     verified_at = NOW(),
                     updated_at = NOW()
                 WHERE telegram_user_id = $1`,
                [telegramUserId]
            );

            // Registrar auditoria
            await this.auditService.logAdminAction({
                adminId,
                adminUsername,
                actionType: 'user_verified',
                actionDescription: `Usuário ${telegramUserId} verificado manualmente`,
                targetUserId: telegramUserId
            });

            logger.info(`[UserManagement] Usuário ${telegramUserId} verificado por ${adminUsername}`);
            return true;
        } catch (error) {
            logger.error(`[UserManagement] Erro ao verificar usuário: ${error.message}`);
            throw error;
        }
    }

    /**
     * Exporta dados de usuários
     */
    async exportUsers(format = 'csv', filters = {}) {
        const result = await this.searchUsers({ ...filters, limit: 10000 });
        const users = result.users;

        if (format === 'csv') {
            const csv = [
                'ID,Username,Full Name,Verified,Banned,Reputation,Volume BRL,Transactions,Created At',
                ...users.map(u =>
                    `${u.telegram_user_id},${u.telegram_username || ''},${u.telegram_full_name || ''},${u.is_verified},${u.is_banned},${u.reputation_level},${u.total_volume_brl},${u.completed_transactions},${u.created_at}`
                )
            ].join('\n');
            return csv;
        } else if (format === 'json') {
            return JSON.stringify(users, null, 2);
        }

        throw new Error('Formato não suportado');
    }

    /**
     * Obtém estatísticas de usuários
     */
    async getUserStats() {
        const result = await this.dbPool.query(`
            SELECT
                COUNT(*) as total_users,
                COUNT(CASE WHEN is_verified = true THEN 1 END) as verified_users,
                COUNT(CASE WHEN is_banned = true THEN 1 END) as banned_users,
                COUNT(CASE WHEN is_merchant = true THEN 1 END) as merchants,
                COUNT(CASE WHEN liquid_address IS NOT NULL THEN 1 END) as with_wallet,
                COUNT(CASE WHEN bot_blocked = true THEN 1 END) as bot_blocked,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as new_today,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as new_week,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as new_month,
                COUNT(CASE WHEN updated_at > NOW() - INTERVAL '24 hours' THEN 1 END) as active_today,
                COUNT(CASE WHEN updated_at > NOW() - INTERVAL '7 days' THEN 1 END) as active_week,
                COUNT(CASE WHEN updated_at > NOW() - INTERVAL '30 days' THEN 1 END) as active_month,
                SUM(total_volume_brl) as total_volume,
                AVG(reputation_level) as avg_reputation,
                MAX(reputation_level) as max_reputation,
                MIN(reputation_level) as min_reputation
            FROM users
        `);

        return result.rows[0];
    }

    /**
     * Busca atividade suspeita
     */
    async findSuspiciousActivity() {
        const result = await this.dbPool.query(`
            SELECT
                telegram_user_id,
                telegram_username,
                total_volume_brl,
                completed_transactions,
                reputation_level,
                created_at,
                CASE
                    WHEN total_volume_brl > 10000 AND completed_transactions < 5 THEN 'Alto volume, poucas transações'
                    WHEN completed_transactions > 50 AND reputation_level < 2 THEN 'Muitas transações, baixa reputação'
                    WHEN created_at > NOW() - INTERVAL '24 hours' AND total_volume_brl > 5000 THEN 'Novo usuário, alto volume'
                    ELSE 'Outro'
                END as suspicious_reason
            FROM users
            WHERE
                (total_volume_brl > 10000 AND completed_transactions < 5) OR
                (completed_transactions > 50 AND reputation_level < 2) OR
                (created_at > NOW() - INTERVAL '24 hours' AND total_volume_brl > 5000)
            ORDER BY total_volume_brl DESC
            LIMIT 20
        `);

        return result.rows;
    }
}

module.exports = UserManagementService;