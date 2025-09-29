// Smart User Experience Enhancements - Simplified version
// Works with existing database schema

const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');

class UserExperienceService {
    constructor() {
        // Helpful tips shown during waiting periods
        this.waitingTips = [
            "O pagamento Pix costuma ser confirmado em segundos",
            "Seus DePix serão enviados automaticamente após confirmação",
            "Você pode acompanhar o status em tempo real",
            "A Atlas Bridge usa a tecnologia Liquid Network do Bitcoin",
            "Suas transações são privadas e seguras",
            "DePix é um Real digital soberano - você tem controle total"
        ];

        // Progress messages for different stages
        this.progressMessages = {
            generating: ['Preparando...', 'Gerando QR...', 'Quase pronto...'],
            verifying: ['Verificando limites...', 'Checando disponibilidade...', 'Confirmando...'],
            processing: ['Processando...', 'Validando...', 'Finalizando...']
        };

        // Success celebrations (appropriate, not exaggerated)
        this.successMessages = {
            firstTransaction: '🎉 Parabéns pela sua primeira transação!',
            milestone10: '⭐ 10 transações completadas! Você está indo bem!',
            milestone50: '🏆 50 transações! Você é um usuário experiente!',
            levelUp: '📈 Você subiu de nível! Novos limites desbloqueados!',
            default: '✅ Transação concluída com sucesso!'
        };
    }

    // Get a random tip for waiting periods
    getRandomTip() {
        return this.waitingTips[Math.floor(Math.random() * this.waitingTips.length)];
    }

    // Get appropriate success message based on user achievements
    async getSuccessMessage(dbPool, userId, transactionAmount) {
        try {
            // Get user stats using existing columns
            const { rows } = await dbPool.query(
                `SELECT
                    total_transactions,
                    reputation_level
                FROM users
                WHERE telegram_user_id = $1`,
                [userId]
            );

            if (rows.length === 0) return this.successMessages.default;

            const user = rows[0];
            const totalTransactions = user.total_transactions || 0;

            // Check for milestones
            if (totalTransactions === 1) {
                return this.successMessages.firstTransaction;
            } else if (totalTransactions === 10) {
                return this.successMessages.milestone10;
            } else if (totalTransactions === 50) {
                return this.successMessages.milestone50;
            }

            return this.successMessages.default;
        } catch (error) {
            console.error('Error getting success message:', error);
            return this.successMessages.default;
        }
    }

    // Format progress bar for visual feedback
    formatProgressBar(percentage, width = 10) {
        const filled = Math.round((percentage / 100) * width);
        return '█'.repeat(filled) + '░'.repeat(width - filled);
    }

    // Get formatted user status with progress indicators
    async getUserProgress(dbPool, userId) {
        try {
            const { rows } = await dbPool.query(
                `SELECT
                    reputation_level,
                    daily_limit_brl,
                    daily_used_brl,
                    total_transactions
                FROM users
                WHERE telegram_user_id = $1`,
                [userId]
            );

            if (rows.length === 0) return null;

            const user = rows[0];
            const dailyProgress = ((user.daily_used_brl || 0) / user.daily_limit_brl) * 100;

            return {
                level: user.reputation_level || 1,
                levelProgress: 0, // Simplified - no XP tracking
                levelProgressBar: this.formatProgressBar(0),
                dailyUsed: user.daily_used_brl || 0,
                dailyLimit: user.daily_limit_brl,
                dailyProgress: dailyProgress,
                dailyProgressBar: this.formatProgressBar(dailyProgress),
                totalTransactions: user.total_transactions || 0,
                streak: 0, // No streak tracking in current schema
                xp: 0, // No XP in current schema
                xpNeeded: 100 // Placeholder
            };
        } catch (error) {
            console.error('Error getting user progress:', error);
            return null;
        }
    }

    // Stub for XP system (not implemented in current schema)
    async awardXP(dbPool, userId, amount, reason) {
        // Just return success without doing anything
        return { xpAwarded: 0, leveledUp: false };
    }

    // Stub for streak system (not implemented in current schema)
    async updateDailyStreak(dbPool, userId) {
        // Return 0 as we don't track streaks
        return 0;
    }

    // Get onboarding progress for new users
    getOnboardingStep(user) {
        if (!user) return 'start';
        if (!user.liquid_address) return 'wallet';
        if (!user.is_verified) return 'verification';
        if (user.total_transactions === 0) return 'first_transaction';
        return 'complete';
    }

    // Format helpful onboarding message
    getOnboardingMessage(step) {
        const messages = {
            start: '👋 Bem-vindo! Vamos configurar sua conta em 3 passos simples.',
            wallet: '💼 Passo 1/3: Adicione seu endereço Liquid para receber DePix',
            verification: '✅ Passo 2/3: Valide sua conta com um Pix de R$ 1,00',
            first_transaction: '🚀 Passo 3/3: Faça sua primeira transação!',
            complete: '✨ Configuração completa! Aproveite o Atlas Bridge!'
        };
        return messages[step] || messages.start;
    }
}

module.exports = new UserExperienceService();