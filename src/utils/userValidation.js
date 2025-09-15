const logger = require('../core/logger');

/**
 * Validações de usuário para o bot
 */
class UserValidation {
    /**
     * Verifica se o usuário tem username (@) no Telegram
     * @param {Object} ctx - Contexto do Telegraf
     * @returns {Object} { valid: boolean, username: string, error: string }
     */
    static checkUsername(ctx) {
        const username = ctx.from?.username;

        if (!username) {
            return {
                valid: false,
                username: null,
                error: '❌ Username obrigatório\n\n' +
                       'Para usar o Bridge, você precisa ter um username (@) no Telegram.\n\n' +
                       'Como configurar:\n' +
                       '1. Vá em Configurações do Telegram\n' +
                       '2. Toque em "Nome de usuário"\n' +
                       '3. Escolha um nome único\n' +
                       '4. Volte aqui e digite /start novamente'
            };
        }

        return {
            valid: true,
            username: username,
            error: null
        };
    }

    /**
     * Atualiza o username do usuário no banco se mudou
     * @param {Object} dbPool - Pool de conexão do banco
     * @param {Number} userId - ID do usuário no Telegram
     * @param {String} username - Username atual
     */
    static async updateUsernameIfChanged(dbPool, userId, username) {
        try {
            // Busca o username atual no banco
            const result = await dbPool.query(
                'SELECT telegram_username FROM users WHERE telegram_id = $1',
                [userId]
            );

            if (result.rows.length === 0) {
                // Usuário não existe, será criado depois
                return;
            }

            const currentUsername = result.rows[0].telegram_username;

            // Se mudou, atualiza
            if (currentUsername !== username) {
                await dbPool.query(
                    'UPDATE users SET telegram_username = $1, updated_at = NOW() WHERE telegram_id = $2',
                    [username, userId]
                );
                logger.info(`Username updated for user ${userId}: ${currentUsername} -> ${username}`);
            }
        } catch (error) {
            logger.error(`Error updating username: ${error.message}`);
        }
    }

    /**
     * Verifica se o usuário pode realizar transações
     * Inclui verificação de username
     */
    static async canUserTransact(ctx, dbPool) {
        // Primeiro verifica username
        const usernameCheck = this.checkUsername(ctx);
        if (!usernameCheck.valid) {
            return {
                canTransact: false,
                reason: usernameCheck.error
            };
        }

        // Atualiza username se necessário
        await this.updateUsernameIfChanged(dbPool, ctx.from.id, usernameCheck.username);

        return {
            canTransact: true,
            username: usernameCheck.username
        };
    }
}

module.exports = UserValidation;