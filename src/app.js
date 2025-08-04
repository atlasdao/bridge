const config = require('./core/config');
const { Telegraf } = require('telegraf');
const express =require('express');
const { Pool } = require('pg');
const IORedis = require('ioredis');

// As importações dos módulos permanecem as mesmas
const { registerBotHandlers } = require('./bot/handlers');
const { createWebhookRoutes } = require('./routes/webhookRoutes');
const { initializeExpectationWorker, expectationMessageQueue } = require('./queues/expectationMessageQueue');
const { initializeExpirationWorker, expirationQueue } = require('./queues/expirationQueue');

console.log('Starting Atlas Bridge Bot...');

// A configuração do .env já é carregada a partir do config.js
console.log(`Application starting in NODE_ENV: ${config.app.nodeEnv}`);

const dbPool = new Pool({
    connectionString: config.supabase.databaseUrl,
});

dbPool.query('SELECT NOW() AS now', (err, res) => {
    if (err) {
        console.error('Error connecting to Supabase database:', err.stack);
        process.exit(1);
    } else {
        console.log('Successfully connected to Supabase database. Current time from DB:', res.rows[0].now);
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

mainRedisConnection.on('connect', () => {
    console.log(`Main Redis connection successful to DB ${config.redis.db}.`);
});
mainRedisConnection.on('error', (err) => {
    console.error(`Main Redis connection error to DB ${config.redis.db}:`, err.message);
});

// A instância do bot é criada aqui e será injetada onde for necessária.
const bot = new Telegraf(config.telegram.botToken);

// O getter agora é mais simples e não precisa de inicialização lazy.
const getBotInstance = () => bot;

// INJEÇÃO DE DEPENDÊNCIA: O 'bot' é passado para os handlers e workers.
registerBotHandlers(bot, dbPool, expectationMessageQueue, expirationQueue);
initializeExpectationWorker(dbPool, getBotInstance);
initializeExpirationWorker(dbPool, getBotInstance);

bot.launch()
    .then(() => console.log('Telegram Bot started successfully via polling.'))
    .catch(err => {
        console.error('Error starting Telegram Bot:', err);
        process.exit(1);
    });

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send(`Atlas Bridge Bot App is alive! [ENV: ${config.app.nodeEnv}]`);
});

// INJEÇÃO DE DEPENDÊNCIA: O 'bot' também é passado para as rotas de webhook.
// Isso quebra o ciclo de dependência, que era a causa do bug.
app.use('/webhooks', createWebhookRoutes(bot, dbPool, expectationMessageQueue, expirationQueue));

const server = app.listen(config.app.port, '0.0.0.0', () => {
    console.log(`Express server listening on port ${config.app.port} for environment ${config.app.nodeEnv}.`);
    console.log(`Webhook endpoint expected at ${config.app.baseUrl}/webhooks/depix_payment`);
});

const gracefulShutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    server.close(async () => {
        console.log('HTTP server closed.');
        console.log('Stopping Telegram bot...');
        try {
            if (bot && typeof bot.stop === 'function') {
                 bot.stop(signal);
                 console.log('Telegram bot polling stopped.');
            }
        } catch (err) { console.error('Error stopping Telegram bot:', err.message); }

        console.log('Closing BullMQ queue connections...');
        try {
            if (expectationMessageQueue) await expectationMessageQueue.close();
            if (expirationQueue) await expirationQueue.close();
            console.log('BullMQ queues closed.');
        } catch(err) { console.error('Error closing BullMQ queues:', err.message); }
        
        console.log('Closing database pool...');
        try {
            await dbPool.end();
            console.log('Database pool closed.');
        } catch (err) { console.error('Error closing database pool:', err.message); }

        console.log('Closing main Redis connection...');
        try {
            if (mainRedisConnection && mainRedisConnection.status === 'ready') {
                await mainRedisConnection.quit();
                console.log('Main Redis connection closed.');
            }
        } catch (err) { console.error('Error closing main Redis connection:', err.message); }
        
        console.log('Shutdown complete.');
        process.exit(0);
    });
    setTimeout(() => {
        console.error('Graceful shutdown timed out, forcing exit.');
        process.exit(1);
    }, 15000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log('Application setup complete. Bot and server are running.');