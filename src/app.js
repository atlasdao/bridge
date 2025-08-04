const config = require('./core/config');
const logger = require('./core/logger');
const { Telegraf } = require('telegraf');
const express = require('express');
const { Pool } = require('pg');
const IORedis = require('ioredis');
const { registerBotHandlers } = require('./bot/handlers');
const { createWebhookRoutes } = require('./routes/webhookRoutes');
const { initializeExpectationWorker, expectationMessageQueue } = require('./queues/expectationMessageQueue');
const { initializeExpirationWorker, expirationQueue } = require('./queues/expirationQueue');

logger.info('--------------------------------------------------');
logger.info('--- Starting Atlas Bridge Bot ---');
logger.info(`--- Environment: ${config.app.nodeEnv} ---`);
logger.info('--------------------------------------------------');

// INJEÇÃO DE DEPENDÊNCIA DO DB: Criamos uma pool para cada ambiente se necessário.
// Para a lógica do Webhook Forwarder, a produção precisa de acesso ao DB de desenvolvimento.
let devDbPool = null;
if (config.app.nodeEnv === 'production') {
    const devDatabaseUrl = process.env.DEV_DATABASE_URL;
    if (devDatabaseUrl) {
        devDbPool = new Pool({ connectionString: devDatabaseUrl });
        logger.info('Production environment has access to the Development Database for webhook forwarding.');
    } else {
        logger.warn('DEV_DATABASE_URL not set in .env.production. Webhook forwarding to dev environment will be disabled.');
    }
}

const dbPool = new Pool({
    connectionString: config.supabase.databaseUrl,
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

const bot = new Telegraf(config.telegram.botToken);
const getBotInstance = () => bot;

registerBotHandlers(bot, dbPool, expectationMessageQueue, expirationQueue);
initializeExpectationWorker(dbPool, getBotInstance);
initializeExpirationWorker(dbPool, getBotInstance);

bot.launch().then(() => logger.info('Telegram Bot started successfully via polling.')).catch(err => {
    logger.error('Error starting Telegram Bot:', err);
    process.exit(1);
});

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.status(200).send(`Atlas Bridge Bot App is alive! [ENV: ${config.app.nodeEnv}]`));

// Injetando ambas as pools de banco de dados nas rotas
app.use('/webhooks', createWebhookRoutes(bot, dbPool, devDbPool, expectationMessageQueue, expirationQueue));

const server = app.listen(config.app.port, '0.0.0.0', () => {
    logger.info(`Express server listening on port ${config.app.port} for environment ${config.app.nodeEnv}.`);
});

const gracefulShutdown = async (signal) => {
    logger.info(`\nReceived ${signal}. Shutting down gracefully...`);
    server.close(async () => {
        logger.info('HTTP server closed.');
        try {
            if (bot && typeof bot.stop === 'function') {
                bot.stop(signal);
                logger.info('Telegram bot polling stopped.');
            }
        } catch (err) { logger.error('Error stopping Telegram bot:', err.message); }
        try {
            if (expectationMessageQueue) await expectationMessageQueue.close();
            if (expirationQueue) await expirationQueue.close();
            logger.info('BullMQ queues closed.');
        } catch(err) { logger.error('Error closing BullMQ queues:', err.message); }
        try {
            await dbPool.end();
            logger.info('Primary Database pool closed.');
            if (devDbPool) await devDbPool.end();
            logger.info('Development Database pool closed.');
        } catch (err) { logger.error('Error closing database pool:', err.message); }
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