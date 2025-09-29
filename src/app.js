const config = require('./core/config');
const logger = require('./core/logger');
const { Telegraf } = require('telegraf');
const express = require('express');
const https = require('https');
const { Pool } = require('pg');
const IORedis = require('ioredis');
const { registerBotHandlers } = require('./bot/handlers');
const { registerAdminCommands } = require('./bot/adminCommandsComplete');
const { createWebhookRoutes } = require('./routes/webhookRoutes');
const { initializeExpectationWorker, expectationMessageQueue } = require('./queues/expectationMessageQueue');
const { initializeExpirationWorker, expirationQueue } = require('./queues/expirationQueue');
const SecurityMiddleware = require('./middleware/security');
const SecurityMonitor = require('./services/securityMonitor');
const depixMonitor = require('./services/depixMonitor');
const ScheduledJobsService = require('./services/scheduledJobs');

logger.info('--------------------------------------------------');
logger.info('--- Starting Atlas Bridge Bot ---');
logger.info(`--- Environment: ${config.app.nodeEnv} ---`);
logger.info('--------------------------------------------------');

const dbPool = new Pool({
    connectionString: config.supabase.databaseUrl,
});

// Configurar timezone para Brasília em todas as conexões
dbPool.on('connect', (client) => {
    client.query("SET TIME ZONE 'America/Sao_Paulo'");
});

dbPool.query('SELECT NOW() AS now', (err, res) => {
    if (err) {
        logger.error('Error connecting to Primary Database:', err.stack);
        process.exit(1);
    } else {
        logger.info(`Successfully connected to Primary Database (${config.app.nodeEnv}). DB Time: ${res.rows[0].now}`);
    }
});

const mainRedisConnection = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});
mainRedisConnection.on('connect', () => logger.info(`Main Redis connection successful to DB ${config.redis.db}.`));
mainRedisConnection.on('error', (err) => logger.error(`Main Redis connection error to DB ${config.redis.db}:`, err.message));

const httpsAgent = new https.Agent({
    keepAlive: true,
    family: 4,
    rejectUnauthorized: true,
    timeout: 30000
});

const bot = new Telegraf(config.telegram.botToken, {
    telegram: {
        apiRoot: 'https://api.telegram.org',
        webhookReply: false,
        agent: httpsAgent,
        apiMode: 'bot'
    },
    handlerTimeout: 90000
});
const getBotInstance = () => bot;

// Initialize maintenance middleware
const { MaintenanceMiddleware } = require('./middleware/maintenanceCheck');
const maintenanceMiddleware = new MaintenanceMiddleware(mainRedisConnection, dbPool);

// CRITICAL: Apply maintenance middleware BEFORE any handlers
// This ensures non-admin users are blocked during maintenance
bot.use(maintenanceMiddleware.middleware());

// Registrar handlers - admin primeiro para ter prioridade
registerAdminCommands(bot, dbPool, mainRedisConnection);
logger.info('[App] Using admin system');

registerBotHandlers(bot, dbPool, expectationMessageQueue, expirationQueue);
initializeExpectationWorker(dbPool, getBotInstance);
initializeExpirationWorker(dbPool, getBotInstance);

// Iniciar o monitor do DePix
depixMonitor.setDbPool(dbPool);
depixMonitor.start();

// Initialize scheduled jobs service
const scheduledJobs = new ScheduledJobsService(dbPool, mainRedisConnection);
scheduledJobs.initialize().then(() => {
    logger.info('[App] Scheduled jobs service initialized successfully');
}).catch(err => {
    logger.error('[App] Failed to initialize scheduled jobs:', err);
});

// Tentativa de conectar ao Telegram com retry e fallback
const disableTelegram = process.env.DISABLE_TELEGRAM === 'true';

if (disableTelegram) {
    logger.warn('Telegram Bot is DISABLED via DISABLE_TELEGRAM environment variable');
    logger.info('Application running in webhook-only mode');
} else {
    const maxRetries = 3;
    let retryCount = 0;

    const launchBot = async () => {
        try {
            logger.info('Attempting to connect to Telegram Bot...');

            // First get bot info to verify connection
            const botInfo = await bot.telegram.getMe();
            bot.botInfo = botInfo;
            logger.info(`Bot verified: @${botInfo.username} (ID: ${botInfo.id})`);

            // Then launch with polling
            await bot.launch({
                webhook: undefined,
                dropPendingUpdates: true,
                allowedUpdates: ['message', 'callback_query', 'inline_query']
            });

            logger.info('Telegram Bot started successfully via polling.');
            logger.info(`Bot username: @${bot.botInfo?.username || 'unknown'}`);

        } catch (err) {
            retryCount++;
            logger.error(`Error starting Telegram Bot (attempt ${retryCount}/${maxRetries}):`, err.message);

            // Log more details about the error
            if (err.response?.error_code === 401) {
                logger.error('Invalid bot token! Please check TELEGRAM_BOT_TOKEN in .env');
            } else if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
                logger.error('Network connection issue. Check internet connectivity and Telegram API access.');
            }

            if (retryCount < maxRetries) {
                logger.info(`Retrying in 5 seconds...`);
                setTimeout(launchBot, 5000);
            } else {
                logger.error('Failed to connect to Telegram after maximum retries');
                logger.warn('Continuing without Telegram bot - webhooks will still work');
                logger.info('To disable this warning, set DISABLE_TELEGRAM=true in .env');
            }
        }
    };

    launchBot();
}

const app = express();

// Middlewares de segurança
app.use(SecurityMiddleware.forceHTTPS);
app.use(SecurityMiddleware.setupHelmet());
app.use(SecurityMiddleware.sanitizeHeaders);
app.use(SecurityMiddleware.securityMonitor);
app.use(SecurityMiddleware.requestTimeout(30));

// Rate limiters
const rateLimiters = SecurityMiddleware.getRateLimiters();
app.use(rateLimiters.general);

app.use(express.json());
app.set('trust proxy', 1);

// Monitor de segurança
const securityMonitor = new SecurityMonitor(dbPool, mainRedisConnection);
app.use(securityMonitor.middleware());

// Eventos de segurança
securityMonitor.on('highRiskDetected', (data) => {
    logger.error('HIGH RISK SECURITY EVENT:', data);
    // Aqui você pode adicionar notificações para admin
});

app.get('/', (req, res) => res.status(200).send(`Atlas Bridge Bot App is alive! [ENV: ${config.app.nodeEnv}]`));
// Rate limiter específico para webhooks
app.use('/webhooks', rateLimiters.webhook, createWebhookRoutes(bot, dbPool, expectationMessageQueue, expirationQueue));

// CORREÇÃO: Especificar o host '0.0.0.0' para garantir que o servidor
// escute em todas as interfaces de rede, incluindo localhost.
// Isso resolve o erro ECONNREFUSED.
const server = app.listen(config.app.port, '0.0.0.0', () => {
    logger.info(`Express server listening on http://0.0.0.0:${config.app.port} for environment ${config.app.nodeEnv}.`);
});

const gracefulShutdown = async (signal) => {
    logger.info(`\nReceived ${signal}. Shutting down gracefully...`);
    server.close(async () => {
        logger.info('HTTP server closed.');
        try {
            if (bot && typeof bot.stop === 'function' && !disableTelegram) {
                bot.stop(signal);
                logger.info('Telegram bot polling stopped.');
            }
        } catch (err) {
            logger.error('Error stopping Telegram bot:', err.message);
        }
        try {
            depixMonitor.stop();
            logger.info('DePix monitor stopped.');
        } catch (err) {
            logger.error('Error stopping DePix monitor:', err.message);
        }
        try {
            if (expectationMessageQueue) await expectationMessageQueue.close();
            if (expirationQueue) await expirationQueue.close();
            logger.info('BullMQ queues closed.');
        } catch(err) {
            logger.error('Error closing BullMQ queues:', err.message);
        }
        try {
            await dbPool.end();
            logger.info('Primary Database pool closed.');
        } catch (err) {
            logger.error('Error closing database pool:', err.message);
        }
        if (mainRedisConnection && mainRedisConnection.status === 'ready') {
            await mainRedisConnection.quit();
            logger.info('Main Redis connection closed.');
        }
        logger.info('Shutdown complete.');
        process.exit(0);
    });
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));