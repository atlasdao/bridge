/**
 * Serviço de Saques DePix → PIX
 *
 * Responsabilidades:
 * - Criar e gerenciar transações de saque
 * - Calcular taxas e valores
 * - Calcular estimativa de horário de conclusão
 * - Monitorar pagamentos pendentes
 * - Gerar estatísticas para dashboard
 */

const logger = require('../core/logger');
const LiquidWalletService = require('./liquidWalletService');

// Constantes de configuração
const WITHDRAWAL_CONFIG = {
    MIN_AMOUNT_BRL: 100,
    MAX_AMOUNT_BRL: 5940,
    OUR_FEE_PERCENT: 2.5,
    NETWORK_FEE_MIN: 0.31,
    NETWORK_FEE_MAX: 0.64,
    EXPIRATION_MINUTES: 60,
    // Horários úteis (fuso São Paulo)
    BUSINESS_HOURS: {
        // Todos os dias exceto domingo: 9:30-12:00
        morning: { start: '09:30', end: '12:00', days: [1, 2, 3, 4, 5, 6] },
        // Segunda a quinta: 13:30-20:30
        afternoonWeekday: { start: '13:30', end: '20:30', days: [1, 2, 3, 4] },
        // Sexta: 13:30-19:30
        afternoonFriday: { start: '13:30', end: '19:30', days: [5] }
    }
};

class WithdrawalService {
    constructor(dbPool, bot = null) {
        this.dbPool = dbPool;
        this.bot = bot;
        this.liquidWalletService = new LiquidWalletService(dbPool);
    }

    /**
     * Calcula taxas e valores para um saque
     * @param {number} pixAmount - Valor desejado em PIX (BRL)
     * @returns {Object} Detalhes do cálculo
     */
    calculateFees(pixAmount) {
        const ourFeeAmount = pixAmount * (WITHDRAWAL_CONFIG.OUR_FEE_PERCENT / 100);
        const networkFeeAmount = WITHDRAWAL_CONFIG.NETWORK_FEE_MIN +
            Math.random() * (WITHDRAWAL_CONFIG.NETWORK_FEE_MAX - WITHDRAWAL_CONFIG.NETWORK_FEE_MIN);

        const totalDepixRequired = pixAmount + ourFeeAmount + networkFeeAmount;

        return {
            requestedPixAmount: parseFloat(pixAmount.toFixed(2)),
            ourFeePercent: WITHDRAWAL_CONFIG.OUR_FEE_PERCENT,
            ourFeeAmount: parseFloat(ourFeeAmount.toFixed(2)),
            networkFeeAmount: parseFloat(networkFeeAmount.toFixed(2)),
            totalDepixRequired: parseFloat(totalDepixRequired.toFixed(2))
        };
    }

    /**
     * Verifica se está dentro do horário útil
     * @param {Date} date - Data/hora a verificar
     * @returns {boolean}
     */
    isBusinessHour(date = new Date()) {
        // Converter para horário de São Paulo
        const spDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const dayOfWeek = spDate.getDay(); // 0 = Domingo
        const hours = spDate.getHours();
        const minutes = spDate.getMinutes();
        const currentTime = hours * 60 + minutes; // Minutos desde meia-noite

        const { morning, afternoonWeekday, afternoonFriday } = WITHDRAWAL_CONFIG.BUSINESS_HOURS;

        // Converter horários para minutos
        const parseTime = (timeStr) => {
            const [h, m] = timeStr.split(':').map(Number);
            return h * 60 + m;
        };

        // Verificar manhã (todos os dias exceto domingo)
        if (morning.days.includes(dayOfWeek)) {
            const start = parseTime(morning.start);
            const end = parseTime(morning.end);
            if (currentTime >= start && currentTime < end) {
                return true;
            }
        }

        // Verificar tarde (segunda a quinta)
        if (afternoonWeekday.days.includes(dayOfWeek)) {
            const start = parseTime(afternoonWeekday.start);
            const end = parseTime(afternoonWeekday.end);
            if (currentTime >= start && currentTime < end) {
                return true;
            }
        }

        // Verificar tarde (sexta)
        if (afternoonFriday.days.includes(dayOfWeek)) {
            const start = parseTime(afternoonFriday.start);
            const end = parseTime(afternoonFriday.end);
            if (currentTime >= start && currentTime < end) {
                return true;
            }
        }

        return false;
    }

    /**
     * Calcula a estimativa de conclusão do saque
     * @param {Date} startDate - Data de início
     * @returns {Date} Data estimada de conclusão
     */
    calculateEstimatedCompletion(startDate = new Date()) {
        // Converter para horário de São Paulo
        let spDate = new Date(startDate.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

        // Se está no horário útil, adicionar 30-120 minutos
        if (this.isBusinessHour(startDate)) {
            // Prazo médio: 30 minutos a 2 horas
            const delayMinutes = 30 + Math.floor(Math.random() * 90);
            return new Date(startDate.getTime() + delayMinutes * 60 * 1000);
        }

        // Encontrar próximo horário útil
        const nextBusinessHour = this.getNextBusinessHour(spDate);

        // Adicionar 30-120 minutos ao início do horário útil
        const delayMinutes = 30 + Math.floor(Math.random() * 90);
        return new Date(nextBusinessHour.getTime() + delayMinutes * 60 * 1000);
    }

    /**
     * Obtém o próximo horário útil
     * @param {Date} fromDate - Data de referência
     * @returns {Date} Próximo horário útil
     */
    getNextBusinessHour(fromDate) {
        const spDate = new Date(fromDate.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        let currentDate = new Date(spDate);

        // Procurar nos próximos 7 dias
        for (let i = 0; i < 7; i++) {
            const dayOfWeek = currentDate.getDay();
            const { morning, afternoonWeekday, afternoonFriday } = WITHDRAWAL_CONFIG.BUSINESS_HOURS;

            const parseTime = (timeStr) => {
                const [h, m] = timeStr.split(':').map(Number);
                return h * 60 + m;
            };

            const currentMinutes = currentDate.getHours() * 60 + currentDate.getMinutes();

            // Verificar manhã
            if (morning.days.includes(dayOfWeek)) {
                const morningStart = parseTime(morning.start);
                if (currentMinutes < morningStart || i > 0) {
                    const result = new Date(currentDate);
                    result.setHours(Math.floor(morningStart / 60), morningStart % 60, 0, 0);
                    if (i > 0) result.setDate(result.getDate() + i);
                    return result;
                }
            }

            // Verificar tarde (segunda a quinta)
            if (afternoonWeekday.days.includes(dayOfWeek)) {
                const afternoonStart = parseTime(afternoonWeekday.start);
                if (currentMinutes < afternoonStart) {
                    const result = new Date(currentDate);
                    result.setHours(Math.floor(afternoonStart / 60), afternoonStart % 60, 0, 0);
                    return result;
                }
            }

            // Verificar tarde (sexta)
            if (afternoonFriday.days.includes(dayOfWeek)) {
                const afternoonStart = parseTime(afternoonFriday.start);
                if (currentMinutes < afternoonStart) {
                    const result = new Date(currentDate);
                    result.setHours(Math.floor(afternoonStart / 60), afternoonStart % 60, 0, 0);
                    return result;
                }
            }

            // Próximo dia
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(0, 0, 0, 0);
        }

        // Fallback: retornar amanhã 9:30
        const result = new Date(spDate);
        result.setDate(result.getDate() + 1);
        result.setHours(9, 30, 0, 0);
        return result;
    }

    /**
     * Formata a estimativa de conclusão para exibição
     * @param {Date} estimatedDate - Data estimada
     * @returns {string} Texto formatado
     */
    formatEstimatedCompletion(estimatedDate) {
        const now = new Date();
        const spNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

        // Calcular prazo máximo = expiração (60min) + processamento (até 2h)
        // Para mostrar ao usuário quando ele pode esperar receber o PIX
        const maxCompletionTime = new Date(now.getTime() + WITHDRAWAL_CONFIG.EXPIRATION_MINUTES * 60 * 1000);
        const spMaxCompletion = new Date(maxCompletionTime.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

        // Se estamos em horário comercial, mostrar "1-2 horas"
        if (this.isBusinessHour(now)) {
            return '1-2 horas';
        }

        // Fora do horário comercial, mostrar quando retoma
        const nextBusiness = this.getNextBusinessHour(spNow);
        const spNextBusiness = new Date(nextBusiness.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

        const isToday = spNow.toDateString() === spNextBusiness.toDateString();
        const isTomorrow = new Date(spNow.getTime() + 24 * 60 * 60 * 1000).toDateString() === spNextBusiness.toDateString();

        const timeStr = spNextBusiness.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        if (isToday) {
            return `Hoje a partir de ${timeStr}`;
        } else if (isTomorrow) {
            return `Amanhã a partir de ${timeStr}`;
        } else {
            const dayNames = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
            return `${dayNames[spNextBusiness.getDay()]} a partir de ${timeStr}`;
        }
    }

    /**
     * Cria uma nova transação de saque
     * @param {Object} params - Parâmetros do saque
     * @returns {Promise<Object>} Transação criada
     */
    async createWithdrawal(params) {
        const {
            telegramUserId,
            pixAmount,
            pixKeyType,
            pixKeyValue
        } = params;

        // Validar valor
        if (pixAmount < WITHDRAWAL_CONFIG.MIN_AMOUNT_BRL || pixAmount > WITHDRAWAL_CONFIG.MAX_AMOUNT_BRL) {
            throw new Error(`Valor deve estar entre R$ ${WITHDRAWAL_CONFIG.MIN_AMOUNT_BRL} e R$ ${WITHDRAWAL_CONFIG.MAX_AMOUNT_BRL}`);
        }

        // Verificar se usuário já tem saque pendente
        const pendingCheck = await this.dbPool.query(
            `SELECT withdrawal_id FROM withdrawal_transactions
             WHERE telegram_user_id = $1
             AND status IN ('AWAITING_PAYMENT', 'PAYMENT_DETECTED', 'PROCESSING')
             LIMIT 1`,
            [telegramUserId]
        );

        if (pendingCheck.rows.length > 0) {
            throw new Error('Você já tem um saque pendente. Aguarde a conclusão ou cancele-o.');
        }

        // Calcular taxas
        const fees = this.calculateFees(pixAmount);

        // Derivar endereço único
        const { address, index } = await this.liquidWalletService.deriveNewAddress();

        // Calcular estimativa de conclusão
        const estimatedCompletion = this.calculateEstimatedCompletion();

        // Gerar comando Eulen
        const eulenCommand = `/withdraw ${pixAmount.toFixed(0)} ${pixKeyValue}`;

        // Calcular expiração
        const expiresAt = new Date(Date.now() + WITHDRAWAL_CONFIG.EXPIRATION_MINUTES * 60 * 1000);

        // Inserir no banco
        const result = await this.dbPool.query(
            `INSERT INTO withdrawal_transactions (
                telegram_user_id,
                requested_pix_amount,
                our_fee_percent,
                our_fee_amount,
                network_fee_amount,
                total_depix_required,
                pix_key_type,
                pix_key_value,
                deposit_address,
                deposit_address_index,
                eulen_command,
                estimated_completion_at,
                expires_at,
                status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'AWAITING_PAYMENT')
            RETURNING *`,
            [
                telegramUserId,
                fees.requestedPixAmount,
                fees.ourFeePercent,
                fees.ourFeeAmount,
                fees.networkFeeAmount,
                fees.totalDepixRequired,
                pixKeyType,
                pixKeyValue,
                address,
                index,
                eulenCommand,
                estimatedCompletion,
                expiresAt
            ]
        );

        const withdrawal = result.rows[0];

        logger.info(`[Withdrawal] Saque criado: ${withdrawal.withdrawal_id} - R$ ${pixAmount} para ${pixKeyValue}`);

        return {
            ...withdrawal,
            estimatedCompletionText: this.formatEstimatedCompletion(estimatedCompletion)
        };
    }

    /**
     * Verifica pagamentos pendentes (chamado pelo job agendado)
     * @returns {Promise<Array>} Lista de saques com pagamento detectado
     */
    async checkPendingPayments() {
        try {
            // Buscar saques aguardando pagamento ou com pagamento insuficiente (não expirados)
            const pendingResult = await this.dbPool.query(
                `SELECT * FROM withdrawal_transactions
                 WHERE status IN ('AWAITING_PAYMENT', 'INSUFFICIENT_PAYMENT')
                 AND expires_at > NOW()
                 ORDER BY created_at ASC`
            );

            const detected = [];

            for (const withdrawal of pendingResult.rows) {
                try {
                    const payment = await this.liquidWalletService.checkPaymentReceived(
                        withdrawal.deposit_address,
                        parseFloat(withdrawal.total_depix_required),
                        0.1, // tolerância de 0.1%
                        withdrawal.deposit_address_index
                    );

                    if (payment.found) {
                        // Verificar se o valor mudou desde a última atualização no banco
                        const previousAmount = parseFloat(withdrawal.liquid_amount_received) || 0;
                        const amountChanged = Math.abs(payment.amount - previousAmount) > 0.01;

                        // Se o valor não mudou, não fazer nada (evitar spam)
                        if (!amountChanged && withdrawal.status !== 'AWAITING_PAYMENT') {
                            continue;
                        }

                        if (payment.status === 'CORRECT') {
                            // Pagamento correto - processar normalmente
                            await this.dbPool.query(
                                `UPDATE withdrawal_transactions
                                 SET status = 'PAYMENT_DETECTED',
                                     liquid_txid = $1,
                                     liquid_amount_received = $2,
                                     liquid_payment_detected_at = NOW(),
                                     liquid_confirmations = $3,
                                     updated_at = NOW()
                                 WHERE withdrawal_id = $4`,
                                [payment.txid, payment.amount, payment.confirmations, withdrawal.withdrawal_id]
                            );

                            try {
                                await this.dbPool.query(
                                    `INSERT INTO withdrawal_payment_monitoring
                                     (withdrawal_id, liquid_address, expected_amount, detected_txid, detected_amount, confirmations, status)
                                     VALUES ($1, $2, $3, $4, $5, $6, 'DETECTED')`,
                                    [withdrawal.withdrawal_id, withdrawal.deposit_address, withdrawal.total_depix_required,
                                        payment.txid, payment.amount, payment.confirmations]
                                );
                            } catch (insertErr) {
                                // Ignorar erro de duplicata
                            }

                            detected.push({
                                ...withdrawal,
                                txid: payment.txid,
                                amount: payment.amount,
                                confirmations: payment.confirmations,
                                status: 'CORRECT'
                            });

                            logger.info(`[Withdrawal] Pagamento CORRETO detectado: ${withdrawal.withdrawal_id} - TXID: ${payment.txid}`);

                            if (this.bot) {
                                await this.notifyPaymentDetected(withdrawal, payment);
                            }

                        } else if (payment.status === 'INSUFFICIENT') {
                            // Pagamento insuficiente - notificar usuário
                            const missing = Math.abs(payment.difference);

                            await this.dbPool.query(
                                `UPDATE withdrawal_transactions
                                 SET status = 'INSUFFICIENT_PAYMENT',
                                     liquid_txid = $1,
                                     liquid_amount_received = $2,
                                     liquid_payment_detected_at = NOW(),
                                     liquid_confirmations = $3,
                                     updated_at = NOW()
                                 WHERE withdrawal_id = $4`,
                                [payment.txid, payment.amount, payment.confirmations, withdrawal.withdrawal_id]
                            );

                            try {
                                await this.dbPool.query(
                                    `INSERT INTO withdrawal_payment_monitoring
                                     (withdrawal_id, liquid_address, expected_amount, detected_txid, detected_amount, confirmations, status)
                                     VALUES ($1, $2, $3, $4, $5, $6, 'INSUFFICIENT')`,
                                    [withdrawal.withdrawal_id, withdrawal.deposit_address, withdrawal.total_depix_required,
                                        payment.txid, payment.amount, payment.confirmations]
                                );
                            } catch (insertErr) {
                                // Ignorar erro de duplicata
                            }

                            logger.warn(`[Withdrawal] Pagamento INSUFICIENTE: ${withdrawal.withdrawal_id} - Recebido: ${payment.amount}, Esperado: ${withdrawal.total_depix_required}, Faltam: ${missing.toFixed(2)}`);

                            if (this.bot) {
                                await this.notifyInsufficientPayment(withdrawal, payment, missing);
                            }

                        } else if (payment.status === 'EXCESS') {
                            // Pagamento em excesso - processar saque normalmente mas avisar sobre reembolso
                            const excess = payment.difference;

                            // Marcar como PAYMENT_DETECTED (saque será processado)
                            await this.dbPool.query(
                                `UPDATE withdrawal_transactions
                                 SET status = 'PAYMENT_DETECTED',
                                     liquid_txid = $1,
                                     liquid_amount_received = $2,
                                     liquid_payment_detected_at = NOW(),
                                     liquid_confirmations = $3,
                                     excess_amount = $5,
                                     updated_at = NOW()
                                 WHERE withdrawal_id = $4`,
                                [payment.txid, payment.amount, payment.confirmations, withdrawal.withdrawal_id, excess]
                            );

                            try {
                                await this.dbPool.query(
                                    `INSERT INTO withdrawal_payment_monitoring
                                     (withdrawal_id, liquid_address, expected_amount, detected_txid, detected_amount, confirmations, status)
                                     VALUES ($1, $2, $3, $4, $5, $6, 'EXCESS_PROCESSED')`,
                                    [withdrawal.withdrawal_id, withdrawal.deposit_address, withdrawal.total_depix_required,
                                        payment.txid, payment.amount, payment.confirmations]
                                );
                            } catch (insertErr) {
                                // Ignorar erro de duplicata
                            }

                            detected.push({
                                ...withdrawal,
                                txid: payment.txid,
                                amount: payment.amount,
                                confirmations: payment.confirmations,
                                status: 'EXCESS'
                            });

                            logger.info(`[Withdrawal] Pagamento em EXCESSO (processando): ${withdrawal.withdrawal_id} - Recebido: ${payment.amount}, Esperado: ${withdrawal.total_depix_required}, Excesso: ${excess.toFixed(2)}`);

                            if (this.bot) {
                                await this.notifyExcessPayment(withdrawal, payment, excess);
                            }
                        }
                    }
                } catch (error) {
                    logger.error(`[Withdrawal] Erro ao verificar saque ${withdrawal.withdrawal_id}: ${error.message}`);
                }
            }

            return detected;
        } catch (error) {
            logger.error(`[Withdrawal] Erro ao verificar pagamentos pendentes: ${error.message}`);
            return [];
        }
    }

    /**
     * Notifica usuário sobre pagamento correto detectado
     * @param {Object} withdrawal - Dados do saque
     * @param {Object} payment - Dados do pagamento
     */
    async notifyPaymentDetected(withdrawal, payment) {
        try {
            const message = `✅ *Pagamento Recebido!*\n\n` +
                `Recebemos *${payment.amount.toFixed(2)} DePix*\n\n` +
                `💰 Valor PIX: *R$ ${parseFloat(withdrawal.requested_pix_amount).toFixed(2)}*\n` +
                `📱 Chave: \`${withdrawal.pix_key_value}\`\n\n` +
                `⏳ Seu PIX será enviado em breve.`;

            await this.bot.telegram.sendMessage(withdrawal.telegram_user_id, message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`[Withdrawal] Erro ao notificar pagamento correto: ${error.message}`);
        }
    }

    /**
     * Notifica usuário sobre pagamento insuficiente
     * @param {Object} withdrawal - Dados do saque
     * @param {Object} payment - Dados do pagamento
     * @param {number} missing - Valor faltante
     */
    async notifyInsufficientPayment(withdrawal, payment, missing) {
        try {
            const message = `⚠️ *Pagamento Incompleto*\n\n` +
                `Recebemos: *${payment.amount.toFixed(2)} DePix*\n` +
                `Esperado: *${parseFloat(withdrawal.total_depix_required).toFixed(2)} DePix*\n\n` +
                `❌ Faltam: *${missing.toFixed(2)} DePix*\n\n` +
                `Envie o valor restante para o mesmo endereço:\n` +
                `\`${withdrawal.deposit_address}\`\n\n` +
                `_O saque será processado quando o valor completo for recebido._`;

            await this.bot.telegram.sendMessage(withdrawal.telegram_user_id, message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`[Withdrawal] Erro ao notificar pagamento insuficiente: ${error.message}`);
        }
    }

    /**
     * Notifica usuário sobre pagamento em excesso
     * @param {Object} withdrawal - Dados do saque
     * @param {Object} payment - Dados do pagamento
     * @param {number} excess - Valor em excesso
     */
    async notifyExcessPayment(withdrawal, payment, excess) {
        try {
            const message = `✅ *Pagamento Recebido!*\n\n` +
                `Recebemos *${payment.amount.toFixed(2)} DePix*\n\n` +
                `💰 Valor PIX: *R$ ${parseFloat(withdrawal.requested_pix_amount).toFixed(2)}*\n` +
                `📱 Chave: \`${withdrawal.pix_key_value}\`\n\n` +
                `⏳ Seu PIX será enviado em breve.\n\n` +
                `⚠️ *Atenção:* Você enviou *${excess.toFixed(2)} DePix* a mais.\n` +
                `Para reembolso do excesso, contate: @atlasDAO\\_support`;

            await this.bot.telegram.sendMessage(withdrawal.telegram_user_id, message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`[Withdrawal] Erro ao notificar pagamento em excesso: ${error.message}`);
        }
    }

    /**
     * Expira saques antigos
     * @returns {Promise<number>} Número de saques expirados
     */
    async expireOldWithdrawals() {
        try {
            const result = await this.dbPool.query(
                `UPDATE withdrawal_transactions
                 SET status = 'EXPIRED',
                     updated_at = NOW()
                 WHERE status = 'AWAITING_PAYMENT'
                 AND expires_at <= NOW()
                 RETURNING withdrawal_id, telegram_user_id`
            );

            // Notificar usuários
            if (this.bot) {
                for (const withdrawal of result.rows) {
                    try {
                        await this.bot.telegram.sendMessage(
                            withdrawal.telegram_user_id,
                            '⏰ Seu saque expirou por falta de pagamento.\n\nVocê pode iniciar um novo saque quando quiser.'
                        );
                    } catch (e) {
                        // Ignorar erro de notificação
                    }
                }
            }

            if (result.rowCount > 0) {
                logger.info(`[Withdrawal] ${result.rowCount} saques expirados`);
            }

            return result.rowCount;
        } catch (error) {
            logger.error(`[Withdrawal] Erro ao expirar saques: ${error.message}`);
            return 0;
        }
    }

    /**
     * Marca saque como processado (admin)
     * @param {string} withdrawalId - ID do saque
     * @param {number} adminId - ID do admin
     * @returns {Promise<Object>} Saque atualizado
     */
    async markAsProcessed(withdrawalId, adminId) {
        const result = await this.dbPool.query(
            `UPDATE withdrawal_transactions
             SET status = 'COMPLETED',
                 processed_by_admin = $1,
                 processed_at = NOW(),
                 actual_completion_at = NOW(),
                 updated_at = NOW()
             WHERE withdrawal_id = $2
             AND status IN ('PAYMENT_DETECTED', 'PROCESSING')
             RETURNING *`,
            [adminId, withdrawalId]
        );

        if (result.rows.length === 0) {
            throw new Error('Saque não encontrado ou já processado');
        }

        const withdrawal = result.rows[0];

        // Notificar usuário
        if (this.bot) {
            try {
                const message = `✅ **PIX Enviado!**\n\n` +
                    `Seu saque foi processado com sucesso!\n\n` +
                    `💰 Valor: R$ ${parseFloat(withdrawal.requested_pix_amount).toFixed(2)}\n` +
                    `📱 Chave: ${withdrawal.pix_key_value}\n\n` +
                    `O valor já deve estar disponível na sua conta.`;

                await this.bot.telegram.sendMessage(withdrawal.telegram_user_id, message, { parse_mode: 'Markdown' });
            } catch (e) {
                logger.error(`[Withdrawal] Erro ao notificar conclusão: ${e.message}`);
            }
        }

        logger.info(`[Withdrawal] Saque ${withdrawalId} marcado como processado pelo admin ${adminId}`);

        return withdrawal;
    }

    /**
     * Cancela um saque
     * @param {string} withdrawalId - ID do saque
     * @param {number} userId - ID do usuário (para validação)
     * @returns {Promise<Object>} Saque cancelado
     */
    async cancelWithdrawal(withdrawalId, userId) {
        const result = await this.dbPool.query(
            `UPDATE withdrawal_transactions
             SET status = 'CANCELLED',
                 updated_at = NOW()
             WHERE withdrawal_id = $1
             AND telegram_user_id = $2
             AND status = 'AWAITING_PAYMENT'
             RETURNING *`,
            [withdrawalId, userId]
        );

        if (result.rows.length === 0) {
            throw new Error('Saque não encontrado ou não pode ser cancelado');
        }

        logger.info(`[Withdrawal] Saque ${withdrawalId} cancelado pelo usuário ${userId}`);

        return result.rows[0];
    }

    /**
     * Obtém estatísticas de saques para hoje
     * @returns {Promise<Object>}
     */
    async getStatsToday() {
        const result = await this.dbPool.query('SELECT * FROM get_withdrawal_stats_today()');
        return result.rows[0] || {};
    }

    /**
     * Obtém estatísticas de saques do mês
     * @returns {Promise<Object>}
     */
    async getStatsMonth() {
        const result = await this.dbPool.query('SELECT * FROM get_withdrawal_stats_month()');
        return result.rows[0] || {};
    }

    /**
     * Obtém saques pendentes de processamento
     * @returns {Promise<Array>}
     */
    async getPendingForProcessing() {
        const result = await this.dbPool.query(
            `SELECT w.*, u.telegram_username
             FROM withdrawal_transactions w
             JOIN users u ON w.telegram_user_id = u.telegram_user_id
             WHERE w.status = 'PAYMENT_DETECTED'
             ORDER BY w.liquid_payment_detected_at ASC`
        );
        return result.rows;
    }

    /**
     * Obtém saques aguardando pagamento
     * @returns {Promise<Array>}
     */
    async getAwaitingPayment() {
        const result = await this.dbPool.query(
            `SELECT w.*, u.telegram_username
             FROM withdrawal_transactions w
             JOIN users u ON w.telegram_user_id = u.telegram_user_id
             WHERE w.status = 'AWAITING_PAYMENT'
             AND w.expires_at > NOW()
             ORDER BY w.created_at ASC`
        );
        return result.rows;
    }

    /**
     * Obtém histórico de saques processados
     * @param {number} limit - Limite de resultados
     * @returns {Promise<Array>}
     */
    async getProcessedHistory(limit = 20) {
        const result = await this.dbPool.query(
            `SELECT w.*, u.telegram_username
             FROM withdrawal_transactions w
             JOIN users u ON w.telegram_user_id = u.telegram_user_id
             WHERE w.status = 'COMPLETED'
             ORDER BY w.actual_completion_at DESC
             LIMIT $1`,
            [limit]
        );
        return result.rows;
    }

    /**
     * Obtém detalhes de um saque específico
     * @param {string} withdrawalId - ID do saque
     * @returns {Promise<Object>}
     */
    async getWithdrawalDetails(withdrawalId) {
        const result = await this.dbPool.query(
            `SELECT w.*, u.telegram_username
             FROM withdrawal_transactions w
             JOIN users u ON w.telegram_user_id = u.telegram_user_id
             WHERE w.withdrawal_id = $1`,
            [withdrawalId]
        );
        return result.rows[0] || null;
    }

    /**
     * Obtém saque pendente de um usuário
     * @param {number} telegramUserId - ID do usuário
     * @returns {Promise<Object>}
     */
    async getUserPendingWithdrawal(telegramUserId) {
        const result = await this.dbPool.query(
            `SELECT * FROM withdrawal_transactions
             WHERE telegram_user_id = $1
             AND status IN ('AWAITING_PAYMENT', 'PAYMENT_DETECTED', 'PROCESSING')
             ORDER BY created_at DESC
             LIMIT 1`,
            [telegramUserId]
        );
        return result.rows[0] || null;
    }
}

module.exports = WithdrawalService;
