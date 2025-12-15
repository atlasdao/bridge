const logger = require('../core/logger');
const axios = require('axios');

/**
 * Serviço de alertas para notificar sobre falhas em cron jobs
 * Comunica-se com o Alert Bot via HTTP para evitar dependências circulares
 */
class AlertService {
    constructor() {
        this.alertBotUrl = process.env.ALERT_BOT_URL || 'http://localhost:3001';
        this.enabled = process.env.ALERT_BOT_ENABLED === 'true';
        this.criticalJobs = ['daily_limit_reset']; // Jobs que sempre geram alerta
    }

    /**
     * Envia alerta de falha em job
     */
    async sendJobFailureAlert(jobName, error, additionalInfo = {}) {
        if (!this.enabled) {
            logger.warn('[AlertService] Alert system is disabled');
            return;
        }

        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

        let message = `🚨 *FALHA NO CRON JOB*\n\n`;
        message += `*Job:* ${jobName}\n`;
        message += `*Hora:* ${timestamp}\n`;
        message += `*Erro:* ${error.message || error}\n`;

        if (additionalInfo.attemptNumber) {
            message += `*Tentativa:* ${additionalInfo.attemptNumber}\n`;
        }

        if (additionalInfo.lastSuccess) {
            message += `*Última execução bem-sucedida:* ${additionalInfo.lastSuccess}\n`;
        }

        // Adicionar ação recomendada baseada no job
        message += '\n📋 *Ação Recomendada:*\n';

        switch (jobName) {
            case 'daily_limit_reset':
                message += '• Verificar conexão com banco de dados\n';
                message += '• Executar reset manual: `SELECT reset_daily_limits();`\n';
                message += '• Verificar logs do PM2\n';
                break;
            case 'stats_recalculation':
                message += '• Verificar performance do banco\n';
                message += '• Checar se há queries lentas\n';
                break;
            case 'transaction_cleanup':
                message += '• Verificar espaço em disco\n';
                message += '• Checar conexões ativas no banco\n';
                break;
            case 'verification_polling':
                message += '• Verificar API DePix\n';
                message += '• Checar conectividade de rede\n';
                break;
            default:
                message += '• Verificar logs do sistema\n';
                message += '• Checar saúde geral do servidor\n';
        }

        try {
            // Tentar enviar via HTTP para o alert bot
            await axios.post(`${this.alertBotUrl}/alert`, {
                message,
                severity: 'error',
                jobName
            }, {
                timeout: 5000
            });

            logger.info(`[AlertService] Alert sent for job: ${jobName}`);
        } catch (err) {
            // Se falhar, apenas loga (não queremos que alertas quebrem os jobs)
            logger.error(`[AlertService] Failed to send alert: ${err.message}`);
        }
    }

    /**
     * Envia alerta de sucesso para jobs críticos
     */
    async sendJobSuccessAlert(jobName, details = {}) {
        if (!this.enabled) {
            return;
        }

        // Só envia alerta de sucesso para jobs críticos
        if (!this.criticalJobs.includes(jobName)) {
            return;
        }

        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

        let message = `✅ *Job Crítico Executado*\n\n`;
        message += `*Job:* ${jobName}\n`;
        message += `*Hora:* ${timestamp}\n`;

        if (details.usersReset) {
            message += `*Usuários resetados:* ${details.usersReset}\n`;
        }

        if (details.usersProcessed) {
            message += `*Usuários processados:* ${details.usersProcessed}\n`;
        }

        try {
            await axios.post(`${this.alertBotUrl}/alert`, {
                message,
                severity: 'success',
                jobName
            }, {
                timeout: 5000
            });

            logger.info(`[AlertService] Success alert sent for job: ${jobName}`);
        } catch (err) {
            logger.error(`[AlertService] Failed to send success alert: ${err.message}`);
        }
    }

    /**
     * Envia alerta customizado
     */
    async sendCustomAlert(message, severity = 'info') {
        if (!this.enabled) {
            return;
        }

        try {
            await axios.post(`${this.alertBotUrl}/alert`, {
                message,
                severity
            }, {
                timeout: 5000
            });

            logger.info(`[AlertService] Custom alert sent with severity: ${severity}`);
        } catch (err) {
            logger.error(`[AlertService] Failed to send custom alert: ${err.message}`);
        }
    }
}

// Singleton
const alertService = new AlertService();

module.exports = alertService;
