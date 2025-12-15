const { Telegraf } = require('telegraf');
const express = require('express');
const redis = require('redis');
const { Pool } = require('pg');
require('dotenv').config();

// Configuração
const ALERT_BOT_TOKEN = process.env.ALERT_BOT_TOKEN;
const ALERT_BOT_PASSWORD = process.env.ALERT_BOT_PASSWORD;
const ALERT_BOT_PORT = process.env.ALERT_BOT_PORT || 3001;

if (!ALERT_BOT_TOKEN || !ALERT_BOT_PASSWORD) {
    console.error('[AlertBot] Missing ALERT_BOT_TOKEN or ALERT_BOT_PASSWORD in .env');
    process.exit(1);
}

// Estado do bot - armazena usuários autorizados
const authorizedUsers = new Set();
const bot = new Telegraf(ALERT_BOT_TOKEN);

// Middleware de autenticação - ignora mensagens de usuários não autorizados
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;

    if (!userId) {
        return; // Ignora mensagens sem ID de usuário
    }

    // Se o usuário não está autorizado, não responde nada (bot silencioso)
    if (!authorizedUsers.has(userId)) {
        // Verifica se a mensagem é a senha de autenticação
        const text = ctx.message?.text || ctx.message?.caption;

        if (text && text.trim() === ALERT_BOT_PASSWORD) {
            authorizedUsers.add(userId);
            await ctx.reply('✅ Autenticação bem-sucedida!\n\nVocê agora receberá alertas sobre falhas nos cron jobs do Atlas Bridge.\n\n📋 Comandos disponíveis:\n/status - Ver status dos jobs\n/health - Verificar saúde do sistema\n/help - Ajuda');
            console.log(`[AlertBot] User ${userId} (${ctx.from.username || 'unknown'}) authenticated successfully`);
        }
        // Se não for a senha, simplesmente ignora (não responde nada)
        return;
    }

    // Usuário autorizado, continua o fluxo
    return next();
});

// Comando /start (só responde se autenticado)
bot.command('start', async (ctx) => {
    await ctx.reply('🔔 *Atlas Bridge Alert Bot*\n\nVocê já está autenticado e receberá alertas sobre falhas nos cron jobs.\n\n📋 Comandos disponíveis:\n/status - Ver status dos jobs\n/health - Verificar saúde do sistema\n/help - Ajuda', { parse_mode: 'Markdown' });
});

// Comando /help
bot.command('help', async (ctx) => {
    const helpText = `
🔔 *Atlas Bridge Alert Bot*

Este bot monitora os cron jobs do Atlas Bridge e envia alertas quando algo falha.

📋 *Comandos disponíveis:*

/status - Ver último status de execução dos jobs
/health - Verificar saúde geral do sistema
/users - Ver usuários autorizados (admin)
/help - Mostrar esta mensagem

🚨 *Alertas Automáticos:*
• Falha no reset de limites diários
• Falha na recalculação de estatísticas
• Falha na limpeza de transações
• Falha no polling de verificações
• Qualquer erro crítico no sistema

⚙️ *Jobs Monitorados:*
• Daily Limit Reset (00:00 Brazil)
• Stats Recalculation (a cada hora)
• Transaction Cleanup (02:00 Brazil)
• User State Cleanup (a cada 15 min)
• Verification Polling (a cada 5 min)
`;
    await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// Comando /status
bot.command('status', async (ctx) => {
    await ctx.reply('⏳ Buscando status dos jobs...');

    try {
        const redisClient = redis.createClient({
            socket: {
                host: process.env.REDIS_HOST || '127.0.0.1',
                port: process.env.REDIS_PORT || 6379
            },
            password: process.env.REDIS_PASSWORD
        });

        await redisClient.connect();

        const jobs = ['daily_limit_reset', 'stats_recalculation', 'transaction_cleanup', 'user_state_cleanup', 'verification_polling'];
        let statusText = '📊 *Status dos Cron Jobs*\n\n';

        for (const jobName of jobs) {
            const key = `job:${jobName}:last_execution`;
            const data = await redisClient.get(key);

            if (data) {
                const jobData = JSON.parse(data);
                const emoji = jobData.success ? '✅' : '❌';
                const timestamp = new Date(jobData.executedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

                statusText += `${emoji} *${jobName}*\n`;
                statusText += `   └ Executado: ${timestamp}\n`;

                if (jobData.success) {
                    if (jobData.usersReset) statusText += `   └ Usuários resetados: ${jobData.usersReset}\n`;
                    if (jobData.usersProcessed) statusText += `   └ Usuários processados: ${jobData.usersProcessed}\n`;
                } else {
                    statusText += `   └ Erro: ${jobData.error}\n`;
                }
                statusText += '\n';
            } else {
                statusText += `⚪ *${jobName}*\n   └ Nenhuma execução registrada\n\n`;
            }
        }

        await redisClient.disconnect();
        await ctx.reply(statusText, { parse_mode: 'Markdown' });
    } catch (error) {
        await ctx.reply(`❌ Erro ao buscar status: ${error.message}`);
        console.error('[AlertBot] Error fetching status:', error);
    }
});

// Comando /health
bot.command('health', async (ctx) => {
    await ctx.reply('⏳ Verificando saúde do sistema...');

    try {
        // Verificar banco de dados
        const dbPool = new Pool({
            connectionString: process.env.DATABASE_URL
        });

        let dbStatus = '✅ Online';
        try {
            const result = await dbPool.query('SELECT NOW()');
            dbStatus = `✅ Online (${new Date(result.rows[0].now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`;
        } catch (error) {
            dbStatus = `❌ Offline (${error.message})`;
        }
        await dbPool.end();

        // Verificar Redis
        let redisStatus = '✅ Online';
        try {
            const redisClient = redis.createClient({
                socket: {
                    host: process.env.REDIS_HOST || '127.0.0.1',
                    port: process.env.REDIS_PORT || 6379
                },
                password: process.env.REDIS_PASSWORD
            });
            await redisClient.connect();
            await redisClient.ping();
            await redisClient.disconnect();
        } catch (error) {
            redisStatus = `❌ Offline (${error.message})`;
        }

        const healthText = `
🏥 *Saúde do Sistema*

💾 *Banco de Dados (PostgreSQL):*
${dbStatus}

🔴 *Redis:*
${redisStatus}

🤖 *Alert Bot:*
✅ Online e funcionando

👥 *Usuários Autorizados:*
${authorizedUsers.size}

⏰ *Hora do Servidor:*
${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (Brasil)
`;

        await ctx.reply(healthText, { parse_mode: 'Markdown' });
    } catch (error) {
        await ctx.reply(`❌ Erro ao verificar saúde: ${error.message}`);
        console.error('[AlertBot] Error checking health:', error);
    }
});

// Comando /users (só admin)
bot.command('users', async (ctx) => {
    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => parseInt(id.trim()));

    if (!adminIds.includes(ctx.from.id)) {
        await ctx.reply('❌ Acesso negado. Apenas administradores podem usar este comando.');
        return;
    }

    let usersText = '👥 *Usuários Autorizados:*\n\n';

    if (authorizedUsers.size === 0) {
        usersText += 'Nenhum usuário autorizado no momento.';
    } else {
        authorizedUsers.forEach(userId => {
            usersText += `• ID: \`${userId}\`\n`;
        });
    }

    await ctx.reply(usersText, { parse_mode: 'Markdown' });
});

// Função para enviar alerta para todos os usuários autorizados
async function sendAlert(message, severity = 'error') {
    const emoji = {
        'error': '🚨',
        'warning': '⚠️',
        'info': 'ℹ️',
        'success': '✅'
    }[severity] || '🔔';

    const alertMessage = `${emoji} *ALERTA - Atlas Bridge*\n\n${message}`;

    const sendPromises = Array.from(authorizedUsers).map(async (userId) => {
        try {
            await bot.telegram.sendMessage(userId, alertMessage, { parse_mode: 'Markdown' });
            console.log(`[AlertBot] Alert sent to user ${userId}`);
        } catch (error) {
            console.error(`[AlertBot] Failed to send alert to user ${userId}:`, error.message);
            // Se o usuário bloqueou o bot, remove da lista
            if (error.response?.error_code === 403) {
                authorizedUsers.delete(userId);
                console.log(`[AlertBot] User ${userId} removed from authorized list (blocked bot)`);
            }
        }
    });

    await Promise.all(sendPromises);
}

// Função para enviar alerta de sucesso de job crítico
async function sendSuccessAlert(jobName, details = '') {
    const message = `✅ *Job Executado com Sucesso*\n\n*Job:* ${jobName}\n*Hora:* ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n${details}`;

    const sendPromises = Array.from(authorizedUsers).map(async (userId) => {
        try {
            await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            if (error.response?.error_code === 403) {
                authorizedUsers.delete(userId);
            }
        }
    });

    await Promise.all(sendPromises);
}

// Tratamento de erros
bot.catch((err, ctx) => {
    console.error('[AlertBot] Bot error:', err);
});

// Iniciar o bot
bot.launch()
    .then(() => {
        console.log('[AlertBot] Bot started successfully!');
        console.log('[AlertBot] Bot username:', bot.botInfo.username);
        console.log('[AlertBot] Waiting for users to authenticate...');
    })
    .catch((error) => {
        console.error('[AlertBot] Failed to start bot:', error);
        process.exit(1);
    });

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('[AlertBot] Received SIGINT, stopping bot...');
    bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
    console.log('[AlertBot] Received SIGTERM, stopping bot...');
    bot.stop('SIGTERM');
});

// Criar servidor HTTP para receber alertas do Atlas Bridge
const app = express();
app.use(express.json());

// Endpoint para receber alertas
app.post('/alert', async (req, res) => {
    try {
        const { message, severity = 'error' } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        await sendAlert(message, severity);
        res.json({ success: true, message: 'Alert sent to all authorized users' });
    } catch (error) {
        console.error('[AlertBot API] Error sending alert:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint de health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        authorizedUsers: authorizedUsers.size,
        uptime: process.uptime()
    });
});

// Iniciar servidor HTTP
app.listen(ALERT_BOT_PORT, () => {
    console.log(`[AlertBot API] HTTP server listening on port ${ALERT_BOT_PORT}`);
});

// Exportar funções para serem usadas pelo Atlas Bridge
module.exports = {
    sendAlert,
    sendSuccessAlert
};
