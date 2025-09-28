const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');

class BroadcastService {
    constructor(bot, dbPool) {
        this.bot = bot;
        this.dbPool = dbPool;
        this.activeOperations = new Map();
    }

    /**
     * Envia mensagem broadcast para todos os usuários
     * @param {string} message - Mensagem a ser enviada
     * @param {Object} options - Opções de broadcast
     * @returns {Object} Resultado do broadcast
     */
    async sendBroadcast(message, options = {}) {
        const {
            onlyVerified = false,
            onlyActive = true,
            batchSize = 30,
            delayBetweenBatches = 1000,
            parseMode = 'MarkdownV2',
            keyboard = null,
            operationId = null
        } = options;

        const stats = {
            total: 0,
            sent: 0,
            failed: 0,
            blocked: 0,
            invalid: 0,
            errors: []
        };

        try {
            // Buscar usuários do banco
            let query = `
                SELECT
                    telegram_user_id,
                    telegram_username,
                    is_verified,
                    is_banned,
                    bot_blocked
                FROM users
                WHERE 1=1
            `;
            const params = [];
            let paramCount = 1;

            if (onlyVerified) {
                query += ` AND is_verified = $${paramCount++}`;
                params.push(true);
            }

            if (onlyActive) {
                query += ` AND is_banned = $${paramCount++}`;
                params.push(false);
                query += ' AND (bot_blocked IS NULL OR bot_blocked = false)';
            }

            query += ' ORDER BY telegram_user_id';

            const result = await this.dbPool.query(query, params);
            const users = result.rows;
            stats.total = users.length;

            logger.info(`[Broadcast] Iniciando envio para ${stats.total} usuários`);

            // Validar que há usuários para enviar
            if (stats.total === 0) {
                logger.warn('[Broadcast] Nenhum usuário encontrado com os filtros aplicados');
                return stats;
            }

            // Processar em lotes
            for (let i = 0; i < users.length; i += batchSize) {
                // Verificar se operação foi cancelada
                if (operationId && this.activeOperations.get(operationId) === 'cancelled') {
                    logger.info(`[Broadcast] Operação ${operationId} cancelada`);
                    break;
                }

                const batch = users.slice(i, Math.min(i + batchSize, users.length));

                const batchPromises = batch.map(async (user) => {
                    try {
                        // Validar ID do usuário (deve ser positivo e razoável)
                        if (!user.telegram_user_id || user.telegram_user_id < 1 || user.telegram_user_id > 9999999999) {
                            stats.invalid++;
                            logger.warn(`[Broadcast] ID inválido: ${user.telegram_user_id}`);
                            return;
                        }

                        const messageOptions = {
                            parse_mode: parseMode
                        };

                        if (keyboard) {
                            messageOptions.reply_markup = keyboard;
                        }

                        await this.bot.telegram.sendMessage(
                            user.telegram_user_id,
                            message,
                            messageOptions
                        );

                        stats.sent++;
                        logger.info(`[Broadcast] Enviado para ${user.telegram_username || user.telegram_user_id}`);
                    } catch (error) {
                        stats.failed++;

                        // Detectar diferentes tipos de erro
                        if (error.code === 403 || error.description?.includes('bot was blocked')) {
                            stats.blocked++;
                            logger.info(`[Broadcast] Usuário bloqueou bot: ${user.telegram_user_id}`);
                            await this.markUserAsBlocked(user.telegram_user_id);
                        } else if (error.code === 400 && error.description?.includes('chat not found')) {
                            stats.invalid++;
                            logger.warn(`[Broadcast] Chat não encontrado: ${user.telegram_user_id}`);
                            await this.markUserAsInvalid(user.telegram_user_id);
                        } else if (error.code === 429) {
                            // Rate limit - aguardar mais tempo
                            logger.warn(`[Broadcast] Rate limit atingido, aguardando...`);
                            await new Promise(resolve => setTimeout(resolve, 5000));
                            // Tentar novamente
                            try {
                                await this.bot.telegram.sendMessage(
                                    user.telegram_user_id,
                                    message,
                                    messageOptions
                                );
                                stats.sent++;
                                stats.failed--; // Corrigir contagem
                            } catch (retryError) {
                                logger.error(`[Broadcast] Erro após retry para ${user.telegram_user_id}: ${retryError.message}`);
                            }
                        } else {
                            stats.errors.push({
                                userId: user.telegram_user_id,
                                error: error.message
                            });
                            logger.error(`[Broadcast] Erro ao enviar para ${user.telegram_user_id}: ${error.message}`);
                        }
                    }
                });

                await Promise.all(batchPromises);

                // Delay entre lotes para evitar rate limiting
                if (i + batchSize < users.length) {
                    await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
                }

                // Atualizar progresso
                const progress = Math.min(i + batchSize, users.length);
                logger.info(`[Broadcast] Progresso: ${progress}/${stats.total} (${Math.round(progress/stats.total * 100)}%)`);
            }

            // Limpar operação ativa
            if (operationId) {
                this.activeOperations.delete(operationId);
            }

            logger.info(`[Broadcast] Concluído - Enviados: ${stats.sent}, Falhas: ${stats.failed}, Bloqueados: ${stats.blocked}, Inválidos: ${stats.invalid}`);
            return stats;

        } catch (error) {
            logger.error(`[Broadcast] Erro geral: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * Envia broadcast segmentado
     * @param {string} message - Mensagem a ser enviada
     * @param {Object} filters - Filtros de segmentação
     * @param {Object} options - Opções adicionais
     */
    async sendSegmentedBroadcast(message, filters = {}, options = {}) {
        const {
            minReputation = null,
            maxReputation = null,
            minVolume = null,
            maxVolume = null,
            hasWallet = null,
            lastActiveDays = null,
            isVerified = null,
            isMerchant = null
        } = filters;

        let query = `
            SELECT
                telegram_user_id,
                telegram_username,
                is_verified,
                reputation_level,
                total_volume_brl
            FROM users
            WHERE is_banned = false
            AND (bot_blocked IS NULL OR bot_blocked = false)
        `;
        const params = [];
        let paramCount = 1;

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

        if (hasWallet !== null) {
            if (hasWallet) {
                query += ' AND liquid_address IS NOT NULL';
            } else {
                query += ' AND liquid_address IS NULL';
            }
        }

        if (isVerified !== null) {
            query += ` AND is_verified = $${paramCount++}`;
            params.push(isVerified);
        }

        if (isMerchant !== null) {
            query += ` AND is_merchant = $${paramCount++}`;
            params.push(isMerchant);
        }

        if (lastActiveDays !== null) {
            query += ` AND updated_at > NOW() - INTERVAL '${parseInt(lastActiveDays)} days'`;
        }

        query += ' ORDER BY telegram_user_id';

        const result = await this.dbPool.query(query, params);
        logger.info(`[SegmentedBroadcast] ${result.rows.length} usuários selecionados com os filtros aplicados`);

        // Usar IDs específicos para o broadcast
        const userIds = result.rows.map(u => u.telegram_user_id);

        return this.sendBroadcastToSpecificUsers(message, userIds, options);
    }

    /**
     * Envia broadcast para usuários específicos
     */
    async sendBroadcastToSpecificUsers(message, userIds, options = {}) {
        const stats = {
            total: userIds.length,
            sent: 0,
            failed: 0,
            blocked: 0,
            invalid: 0
        };

        const {
            batchSize = 30,
            delayBetweenBatches = 1000,
            parseMode = 'MarkdownV2',
            keyboard = null
        } = options;

        for (let i = 0; i < userIds.length; i += batchSize) {
            const batch = userIds.slice(i, Math.min(i + batchSize, userIds.length));

            const batchPromises = batch.map(async (userId) => {
                try {
                    const messageOptions = {
                        parse_mode: parseMode
                    };

                    if (keyboard) {
                        messageOptions.reply_markup = keyboard;
                    }

                    await this.bot.telegram.sendMessage(userId, message, messageOptions);
                    stats.sent++;
                } catch (error) {
                    stats.failed++;
                    if (error.code === 403) {
                        stats.blocked++;
                        await this.markUserAsBlocked(userId);
                    } else if (error.code === 400) {
                        stats.invalid++;
                    }
                }
            });

            await Promise.all(batchPromises);

            if (i + batchSize < userIds.length) {
                await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }

        return stats;
    }

    /**
     * Marca usuário como bloqueado
     */
    async markUserAsBlocked(telegramUserId) {
        try {
            await this.dbPool.query(
                `UPDATE users
                 SET bot_blocked = true,
                     bot_blocked_at = NOW(),
                     updated_at = NOW()
                 WHERE telegram_user_id = $1`,
                [telegramUserId]
            );
            logger.info(`[Broadcast] Usuário ${telegramUserId} marcado como bloqueado`);
        } catch (error) {
            logger.error(`[Broadcast] Erro ao marcar usuário como bloqueado: ${error.message}`);
        }
    }

    /**
     * Marca usuário como inválido
     */
    async markUserAsInvalid(telegramUserId) {
        try {
            await this.dbPool.query(
                `UPDATE users
                 SET chat_invalid = true,
                     chat_invalid_at = NOW(),
                     updated_at = NOW()
                 WHERE telegram_user_id = $1`,
                [telegramUserId]
            );
            logger.info(`[Broadcast] Usuário ${telegramUserId} marcado como inválido`);
        } catch (error) {
            logger.error(`[Broadcast] Erro ao marcar usuário como inválido: ${error.message}`);
        }
    }

    /**
     * Agenda broadcast para horário futuro
     */
    async scheduleBroadcast(message, scheduledTime, options = {}) {
        const delay = new Date(scheduledTime) - new Date();

        if (delay <= 0) {
            throw new Error('Horário agendado deve ser no futuro');
        }

        const operationId = `scheduled_${Date.now()}`;
        this.activeOperations.set(operationId, 'scheduled');

        logger.info(`[Broadcast] Agendado para ${scheduledTime} (em ${Math.round(delay/1000/60)} minutos)`);

        setTimeout(() => {
            if (this.activeOperations.get(operationId) !== 'cancelled') {
                this.sendBroadcast(message, { ...options, operationId });
            }
        }, delay);

        return {
            operationId,
            scheduled: true,
            scheduledTime,
            delay
        };
    }

    /**
     * Cancela operação de broadcast
     */
    cancelOperation(operationId) {
        if (this.activeOperations.has(operationId)) {
            this.activeOperations.set(operationId, 'cancelled');
            logger.info(`[Broadcast] Operação ${operationId} cancelada`);
            return true;
        }
        return false;
    }

    /**
     * Envia mensagem de teste para admins
     */
    async sendTestBroadcast(message, adminIds = [], options = {}) {
        const stats = {
            total: adminIds.length,
            sent: 0,
            failed: 0
        };

        const {
            parseMode = 'MarkdownV2',
            keyboard = null
        } = options;

        for (const adminId of adminIds) {
            try {
                const messageOptions = {
                    parse_mode: parseMode
                };

                if (keyboard) {
                    messageOptions.reply_markup = keyboard;
                }

                await this.bot.telegram.sendMessage(adminId, message, messageOptions);
                stats.sent++;
                logger.info(`[TestBroadcast] Enviado para admin ${adminId}`);
            } catch (error) {
                stats.failed++;
                logger.error(`[TestBroadcast] Erro ao enviar para admin ${adminId}: ${error.message}`);
            }
        }

        return stats;
    }

    /**
     * Obtém estatísticas de broadcast
     */
    async getBroadcastStats() {
        const result = await this.dbPool.query(`
            SELECT
                COUNT(*) as total_users,
                COUNT(CASE WHEN is_banned = false THEN 1 END) as active_users,
                COUNT(CASE WHEN bot_blocked = true THEN 1 END) as blocked_users,
                COUNT(CASE WHEN chat_invalid = true THEN 1 END) as invalid_users,
                COUNT(CASE WHEN is_verified = true THEN 1 END) as verified_users,
                COUNT(CASE WHEN liquid_address IS NOT NULL THEN 1 END) as with_wallet,
                COUNT(CASE WHEN is_merchant = true THEN 1 END) as merchants,
                COUNT(CASE WHEN updated_at > NOW() - INTERVAL '7 days' THEN 1 END) as active_week,
                COUNT(CASE WHEN updated_at > NOW() - INTERVAL '30 days' THEN 1 END) as active_month
            FROM users
        `);

        return result.rows[0];
    }

    /**
     * Obtém histórico de broadcasts
     */
    async getBroadcastHistory(limit = 10) {
        try {
            const result = await this.dbPool.query(`
                SELECT
                    id,
                    message_preview,
                    total_count,
                    sent_count,
                    failed_count,
                    blocked_count,
                    invalid_count,
                    segment_filter,
                    sent_by,
                    created_at,
                    completed_at
                FROM broadcast_history
                ORDER BY created_at DESC
                LIMIT $1
            `, [limit]);

            return result.rows;
        } catch (error) {
            logger.error(`[BroadcastService] Erro ao obter histórico: ${error.message}`);
            return [];
        }
    }
}

module.exports = BroadcastService;