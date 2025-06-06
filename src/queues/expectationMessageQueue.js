const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../core/config');
// Importar a função de escape diretamente do módulo handlers
const { escapeMarkdownV2 } = require('../bot/handlers');


const QUEUE_NAME = 'expectationMessages';

const connection = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

connection.on('connect', () => console.log(`BullMQ Redis connected for ${QUEUE_NAME} queue.`));
connection.on('error', (err) => console.error(`BullMQ Redis connection error for ${QUEUE_NAME}:`, err));

const expectationMessageQueue = new Queue(QUEUE_NAME, { connection });
console.log(`BullMQ Queue "${QUEUE_NAME}" initialized.`);

const initializeExpectationWorker = (dbPool, botInstanceGetter) => {
    console.log(`Initializing BullMQ Worker for queue: ${QUEUE_NAME}`);
    const worker = new Worker(QUEUE_NAME, async (job) => {
        const { telegramUserId, depixApiEntryId, supportContact } = job.data; // supportContact já vem escapado do handlers.js
        const bot = botInstanceGetter(); 

        if (!bot) { /* ... (erro) ... */ throw new Error('Bot instance not available for worker.'); }
        console.log(`[Worker ${QUEUE_NAME}] Processing job ${job.id} for user ${telegramUserId}, depixEntryId ${depixApiEntryId}`);

        try {
            const { rows } = await dbPool.query( 'SELECT payment_status FROM pix_transactions WHERE depix_api_entry_id = $1', [depixApiEntryId]);

            if (rows.length > 0 && rows[0].payment_status === 'PENDING') {
                console.log(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} still PENDING. Sending expectation message.`);
                
                // MENSAGEM DE EXPECTATIVA ATUALIZADA E JÁ USA supportContact escapado
                const message = 
                    `Lembrete: Após o pagamento do Pix, seus DePix podem levar alguns instantes \\(geralmente até 2 minutos\\) para serem creditados em sua carteira Liquid\\.\n\n` +
                    `Se você já pagou e está aguardando, um pouco mais de paciência\\! Se houver qualquer problema ou demora excessiva, contate nosso suporte: ${supportContact}`; // supportContact foi passado já escapado
                
                await bot.telegram.sendMessage( telegramUserId, message, { parse_mode: 'MarkdownV2' } ); // Não precisa mais escapar aqui
                console.log(`[Worker ${QUEUE_NAME}] Expectation message sent to user ${telegramUserId} for ${depixApiEntryId}.`);
            } else if (rows.length > 0) { /* ... (log) ... */ }
            else { /* ... (log) ... */ }
        } catch (error) { console.error(`[Worker ${QUEUE_NAME}] Error processing job ${job.id}:`, error); throw error; }
    }, { connection });

    worker.on('completed', (job) => { console.log(`[Worker ${QUEUE_NAME}] Job ${job.id} completed.`); });
    worker.on('failed', (job, err) => { console.error(`[Worker ${QUEUE_NAME}] Job ${job.id} failed: ${err.message}`);});
    console.log(`BullMQ Worker for ${QUEUE_NAME} initialized and listening for jobs.`);
};

module.exports = { expectationMessageQueue, initializeExpectationWorker, QUEUE_NAME };
