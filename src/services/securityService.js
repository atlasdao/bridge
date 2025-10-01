const logger = require('../core/logger');

/**
 * Verifica se um usuário está na blacklist unificada
 * @param {Object} dbPool - Pool de conexão do banco de dados
 * @param {Object} params - Parâmetros para verificação
 * @returns {Object} - { isBanned: boolean, reason: string, banType: string, expiresAt: Date, matchedField: string }
 */
async function checkBlacklist(dbPool, params) {
    try {
        const result = await dbPool.query(
            `SELECT * FROM check_user_banned($1, $2, $3, $4, $5, $6)`,
            [
                params.telegram_id || null,
                params.telegram_username || null,
                params.cpf_cnpj || null,
                params.email || null,
                params.phone || null,
                params.full_name || null
            ]
        );

        if (result.rows.length === 0) {
            return {
                isBanned: false,
                reason: null,
                banType: null,
                expiresAt: null,
                matchedField: null
            };
        }

        const ban = result.rows[0];
        return {
            isBanned: ban.is_banned,
            reason: ban.ban_reason,
            banType: ban.ban_type,
            expiresAt: ban.expires_at,
            matchedField: ban.matched_field
        };
    } catch (error) {
        logger.error(`Error checking blacklist: ${error.message}`);
        return {
            isBanned: false,
            reason: null,
            banType: null,
            expiresAt: null,
            matchedField: null
        };
    }
}

/**
 * Verifica se o usuário pode realizar uma transação
 * @param {Object} dbPool - Pool de conexão do banco de dados
 * @param {Number} userId - ID do usuário no Telegram
 * @param {Number} amount - Valor em reais da transação
 * @returns {Object} - { canTransact: boolean, reason: string, userInfo: object }
 */
async function checkUserCanTransact(dbPool, userId, amount) {
    try {
        // FIRST: Force reset of daily limits if needed (before any checks)
        // This ensures limits are always fresh, even if cron job fails
        await dbPool.query(
            `UPDATE users
            SET daily_used_brl = 0,
                last_limit_reset = CURRENT_TIMESTAMP
            WHERE (telegram_user_id = $1 OR telegram_id = $1)
                AND last_limit_reset < CURRENT_DATE`,
            [userId]
        );

        // Primeiro buscar informações do usuário
        const userResult = await dbPool.query(
            `SELECT
                telegram_id,
                telegram_username,
                liquid_address,
                is_verified,
                payer_name,
                payer_cpf_cnpj,
                reputation_level,
                daily_limit_brl,
                daily_used_brl,
                is_banned,
                (daily_limit_brl - daily_used_brl) as available_today
            FROM users
            WHERE telegram_id = $1`,
            [userId]
        );

        const userInfo = userResult.rows[0] || null;

        // Verificar blacklist unificada
        const blacklistCheck = await checkBlacklist(dbPool, {
            telegram_id: userId,
            telegram_username: userInfo?.telegram_username,
            cpf_cnpj: userInfo?.payer_cpf_cnpj,
            full_name: userInfo?.payer_name
        });

        if (blacklistCheck.isBanned) {
            // Se está na blacklist, atualizar o campo is_banned no usuário
            if (userInfo && !userInfo.is_banned) {
                await dbPool.query(
                    'UPDATE users SET is_banned = true WHERE telegram_id = $1',
                    [userId]
                );
            }

            let banMessage = `Usuário bloqueado: ${blacklistCheck.reason}`;
            if (blacklistCheck.banType === 'temporary' && blacklistCheck.expiresAt) {
                const expiresDate = new Date(blacklistCheck.expiresAt);
                banMessage += ` (até ${expiresDate.toLocaleDateString('pt-BR')})`;
            }

            return {
                canTransact: false,
                reason: banMessage,
                userInfo: userInfo
            };
        }

        // Chamar função SQL que faz as outras verificações
        const result = await dbPool.query(
            'SELECT * FROM can_user_transact($1, $2)',
            [userId, amount]
        );

        if (result.rows.length === 0) {
            return {
                canTransact: false,
                reason: 'Erro ao verificar permissões',
                userInfo: null
            };
        }

        const check = result.rows[0];
        
        return {
            canTransact: check.can_transact,
            reason: check.reason,
            availableLimit: parseFloat(check.available_limit || 0),
            userInfo: userInfo
        };
        
    } catch (error) {
        logger.error(`Error checking user transaction permissions: ${error.message}`);
        return {
            canTransact: false,
            reason: 'Erro ao verificar permissões. Tente novamente.',
            userInfo: null
        };
    }
}

/**
 * Verifica e atualiza o nível de reputação do usuário
 * @param {Object} dbPool - Pool de conexão do banco de dados
 * @param {Number} userId - ID do usuário no Telegram
 * @returns {Object} - Informações sobre o upgrade
 */
async function checkAndUpgradeReputation(dbPool, userId) {
    try {
        const result = await dbPool.query(
            'SELECT * FROM check_reputation_upgrade($1)',
            [userId]
        );
        
        if (result.rows.length === 0) {
            return {
                upgraded: false,
                message: 'Erro ao verificar nível de reputação'
            };
        }
        
        const upgradeInfo = result.rows[0];
        return {
            upgraded: upgradeInfo.upgraded,
            newLevel: upgradeInfo.new_level,
            newLimit: parseFloat(upgradeInfo.new_limit || 0),
            message: upgradeInfo.message
        };
        
    } catch (error) {
        logger.error(`Error checking reputation upgrade: ${error.message}`);
        return {
            upgraded: false,
            message: 'Erro ao verificar nível de reputação'
        };
    }
}

/**
 * Cria uma transação de verificação de R$ 1
 * @param {Object} dbPool - Pool de conexão do banco de dados
 * @param {Number} userId - ID do usuário no Telegram
 * @returns {Object} - Informações da transação de verificação
 */
async function createVerificationTransaction(dbPool, userId, qrCodeData, depixApiEntryId) {
    try {
        const result = await dbPool.query(
            `INSERT INTO verification_transactions 
            (telegram_user_id, pix_qr_code_payload, depix_api_entry_id, verification_status)
            VALUES ($1, $2, $3, 'PENDING')
            RETURNING verification_id`,
            [userId, qrCodeData, depixApiEntryId]
        );
        
        logger.info(`Verification transaction created for user ${userId} with depix_api_entry_id: ${depixApiEntryId}`);
        
        return {
            success: true,
            verificationId: result.rows[0].verification_id
        };
        
    } catch (error) {
        logger.error(`Error creating verification transaction: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Processa o pagamento de verificação quando confirmado
 * @param {Object} dbPool - Pool de conexão do banco de dados
 * @param {String} depixApiEntryId - ID da transação na API DePix
 * @param {String} payerName - Nome do pagador
 * @param {String} payerCpfCnpj - CPF/CNPJ do pagador
 * @returns {Object} - Resultado do processamento
 */
async function processVerificationPayment(dbPool, depixApiEntryId, payerName, payerCpfCnpj) {
    const client = await dbPool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Buscar a transação de verificação
        const verificationResult = await client.query(
            `SELECT telegram_user_id, verification_status 
            FROM verification_transactions 
            WHERE depix_api_entry_id = $1`,
            [depixApiEntryId]
        );
        
        if (verificationResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: 'Transação de verificação não encontrada' };
        }
        
        const verification = verificationResult.rows[0];
        
        if (verification.verification_status !== 'PENDING') {
            await client.query('ROLLBACK');
            return { success: false, error: 'Transação já processada' };
        }
        
        // Atualizar transação de verificação
        await client.query(
            `UPDATE verification_transactions 
            SET verification_status = 'CONFIRMED',
                payer_name = $1,
                payer_cpf_cnpj = $2,
                verified_at = NOW(),
                updated_at = NOW()
            WHERE depix_api_entry_id = $3`,
            [payerName, payerCpfCnpj, depixApiEntryId]
        );
        
        // Atualizar usuário como verificado e definir nível 1
        await client.query(
            `UPDATE users 
            SET is_verified = true,
                verification_status = 'verified',
                payer_name = $1,
                payer_cpf_cnpj = $2,
                verification_payment_date = NOW(),
                reputation_level = 1,
                daily_limit_brl = 50,
                updated_at = NOW()
            WHERE telegram_id = $3`,
            [payerName, payerCpfCnpj, verification.telegram_user_id]
        );
        
        // Registrar mudança de nível
        await client.query(
            `INSERT INTO reputation_level_history 
            (telegram_user_id, old_level, new_level, old_limit, new_limit, reason)
            VALUES ($1, 0, 1, 0, 50, 'verification_completed')`,
            [verification.telegram_user_id]
        );
        
        await client.query('COMMIT');
        
        return {
            success: true,
            userId: verification.telegram_user_id,
            payerName: payerName,
            payerCpfCnpj: payerCpfCnpj
        };
        
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`Error processing verification payment: ${error.message}`);
        return { success: false, error: error.message };
    } finally {
        client.release();
    }
}

/**
 * Atualiza o valor usado diariamente pelo usuário
 * @param {Object} dbPool - Pool de conexão do banco de dados
 * @param {Number} userId - ID do usuário no Telegram
 * @param {Number} amount - Valor a adicionar ao uso diário
 */
async function updateDailyUsage(dbPool, userId, amount) {
    try {
        await dbPool.query(
            `UPDATE users
            SET daily_used_brl = daily_used_brl + $1,
                updated_at = NOW()
            WHERE telegram_user_id = $2`,
            [amount, userId]
        );
        
        // Registrar no log diário
        await dbPool.query(
            `INSERT INTO daily_limits_log (telegram_user_id, date, total_used_brl, transaction_count)
            VALUES ($1, CURRENT_DATE, $2, 1)
            ON CONFLICT (telegram_user_id, date) 
            DO UPDATE SET 
                total_used_brl = daily_limits_log.total_used_brl + $2,
                transaction_count = daily_limits_log.transaction_count + 1`,
            [userId, amount]
        );
        
        return { success: true };
        
    } catch (error) {
        logger.error(`Error updating daily usage: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Obtém o status completo do usuário
 * @param {Object} dbPool - Pool de conexão do banco de dados
 * @param {Number} userId - ID do usuário no Telegram
 */
async function getUserStatus(dbPool, userId) {
    try {
        const result = await dbPool.query(
            `SELECT
                u.*,
                rlc.description as level_description,
                rlc.max_per_transaction_brl,
                (u.daily_limit_brl - u.daily_used_brl) as available_today,
                CASE
                    WHEN u.last_limit_reset < CURRENT_DATE THEN 0
                    ELSE u.daily_used_brl
                END as actual_daily_used,
                COALESCE(u.completed_transactions, 0) as completed_transactions,
                COALESCE(u.total_volume_brl, 0) as total_volume_brl
            FROM users u
            LEFT JOIN reputation_levels_config rlc ON u.reputation_level = rlc.level
            WHERE u.telegram_id = $1 OR u.telegram_user_id = $1`,
            [userId]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        return result.rows[0];
        
    } catch (error) {
        logger.error(`Error getting user status: ${error.message}`);
        return null;
    }
}

module.exports = {
    checkBlacklist,
    checkUserCanTransact,
    checkAndUpgradeReputation,
    createVerificationTransaction,
    processVerificationPayment,
    updateDailyUsage,
    getUserStatus
};