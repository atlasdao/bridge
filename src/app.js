const config = require('./core/config');
const { Telegraf } = require('telegraf');
const express = require('express');
const { Pool } = require('pg');
const IORedis = require('ioredis');

// CORREÇÃO NA IMPORTAÇÃO
const { registerBotHandlers } = require('./bot/handlers'); 
const { createWebhookRoutes } = require('./routes/webhookRoutes');
const { initializeExpectationWorker, expectationMessageQueue } = require('./queues/expectationMessageQueue');

console.log('Starting Atlas Bridge Bot...');
console.log('NODE_ENV:', config.app.nodeEnv);

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
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

mainRedisConnection.on('connect', () => {
    console.log('Main Redis connection successful.');
});
mainRedisConnection.on('error', (err) => {
    console.error('Main Redis connection error:', err.message);
});

const bot = new Telegraf(config.telegram.botToken);

let botInstanceInternal = null;
const getBotInstance = () => {
    if (!botInstanceInternal) {
        botInstanceInternal = bot;
    }
    return botInstanceInternal;
};
module.exports.getBotInstance = getBotInstance; 

registerBotHandlers(bot, dbPool, expectationMessageQueue); 
initializeExpectationWorker(dbPool, getBotInstance);

bot.launch()
    .then(() => console.log('Telegram Bot started successfully via polling.'))
    .catch(err => {
        console.error('Error starting Telegram Bot:', err);
        process.exit(1); 
    });

const app = express();
app.use(express.json()); 

app.get('/', (req, res) => {
    res.status(200).send('Atlas Bridge Bot App is alive!');
});

app.use('/webhooks', createWebhookRoutes(dbPool, expectationMessageQueue)); 

const server = app.listen(config.app.port, '0.0.0.0', () => {
    console.log(`Express server listening on port ${config.app.port}.`);
    console.log(`Caddy should proxy requests from ${config.app.baseUrl} to localhost:${config.app.port}`);
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

        console.log('Closing BullMQ queue and worker connections...');
        try {
            if (expectationMessageQueue) await expectationMessageQueue.close();
            // Adicionar fechamento do worker se ele for exportado e tiver método close()
            console.log('BullMQ queue closed.');
        } catch(err) { console.error('Error closing BullMQ queue:', err.message); }

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

