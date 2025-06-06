const config = require('./core/config');
const { Telegraf } = require('telegraf'); // Markup não é usado diretamente aqui
const express = require('express');
const { Pool } = require('pg');
const IORedis = require('ioredis'); // IORedis principal para a aplicação, BullMQ usa o seu próprio

const registerBotHandlers = require('./bot/handlers'); 
const { createWebhookRoutes } = require('./routes/webhookRoutes');
const { initializeExpectationWorker, expectationMessageQueue } = require('./queues/expectationMessageQueue'); // Importar BullMQ

console.log('Starting Atlas Bridge Bot...');
console.log('NODE_ENV:', config.app.nodeEnv);

const dbPool = new Pool({
    connectionString: config.supabase.databaseUrl,
});

dbPool.query('SELECT NOW() AS now', (err, res) => {
    if (err) {
        console.error('Error connecting to Supabase database:', err.stack);
        process.exit(1); // Sair se não conseguir conectar ao DB
    } else {
        console.log('Successfully connected to Supabase database. Current time from DB:', res.rows[0].now);
    }
});

// Este IORedis é para uso geral da app, se necessário. BullMQ tem sua própria instância.
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
    // Considerar sair se o Redis principal for crítico e não conectar
});

const bot = new Telegraf(config.telegram.botToken);

let botInstanceInternal = null;
const getBotInstance = () => {
    if (!botInstanceInternal) {
        botInstanceInternal = bot;
    }
    return botInstanceInternal;
};
module.exports.getBotInstance = getBotInstance; // Para webhookRoutes e worker da fila

// Passar a fila para os handlers do bot, para que eles possam adicionar jobs
registerBotHandlers(bot, dbPool, expectationMessageQueue); 

// Inicializar o Worker da Fila BullMQ, passando o dbPool e a função para pegar a instância do bot
initializeExpectationWorker(dbPool, getBotInstance);

bot.launch()
    .then(() => console.log('Telegram Bot started successfully via polling.'))
    .catch(err => {
        console.error('Error starting Telegram Bot:', err);
        process.exit(1); // Sair se o bot não puder iniciar
    });

const app = express();
app.use(express.json()); 

app.get('/', (req, res) => {
    res.status(200).send('Atlas Bridge Bot App is alive!');
});

// Passar a fila para as rotas de webhook, para que possam cancelar jobs
app.use('/webhooks', createWebhookRoutes(dbPool, expectationMessageQueue)); 

const server = app.listen(config.app.port, '0.0.0.0', () => {
    console.log(`Express server listening on port ${config.app.port}.`);
    console.log(`Caddy should proxy requests from ${config.app.baseUrl} to localhost:${config.app.port}`);
    console.log(`Webhook endpoint expected at ${config.app.baseUrl}/webhooks/depix_payment`);
});

const gracefulShutdown = async (signal) => { // Tornar async para aguardar fechamentos
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    
    // Parar de aceitar novas conexões HTTP
    server.close(async () => { // Tornar callback async
        console.log('HTTP server closed.');

        console.log('Stopping Telegram bot...');
        try {
            if (bot && typeof bot.stop === 'function') {
                 bot.stop(signal);
                 console.log('Telegram bot polling stopped.');
            }
        } catch (err) { console.error('Error stopping Telegram bot:', err.message); }

        console.log('Closing BullMQ queue and worker connections (if applicable)...');
        try {
            await expectationMessageQueue.close(); // Fechar a instância da fila
            // O worker do BullMQ geralmente para quando a conexão Redis é fechada.
            // Se houver um método worker.close(), chame-o aqui.
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
    }, 15000); // Aumentado para 15s devido a mais fechamentos
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log('Application setup complete. Bot and server are running.');
