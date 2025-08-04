const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../core/config');
// CORREÇÃO: Importando a função do novo arquivo de utilitários.
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');

const QUEUE_NAME = 'expectationMessages';

const connection = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    db: config.redis.db,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

connection.on('connect', () => console.log(`BullMQ Redis connected for ${QUEUE_NAME} queue on DB ${config.redis.db}.`));
connection.on('error', (err) => console.error(`BullMQ Redis connection error for ${QUEUE_NAME} on DB ${config.redis.db}:`, err));

const expectationMessageQueue = new Queue(QUEUE_NAME, { connection });
console.log(`BullMQ Queue "${QUEUE_NAME}" initialized on DB ${config.redis.db}.`);

const initializeExpectationWorker = (dbPool, botInstanceGetter) => {
    console.log(`Initializing BullMQ Worker for queue: ${QUEUE_NAME} on DB ${config.redis.db}`);
    const worker = new Worker(QUEUE_NAME, async (job) => {
        const { telegramUserId, depixApiEntryId, supportContact } = job.data;
        const bot = botInstanceGetter(); 

        if (!bot) {
            console.error(`[Worker ${QUEUE_NAME}] FATAL: Bot instance is not available. Aborting job ${job.id}.`);
            throw new Error('Bot instance not available for worker.');
        }
        console.log(`[Worker ${QUEUE_NAME}] Processing job ${job.id} for user ${telegramUserId}, depixEntryId ${depixApiEntryId}`);

        try {
            const { rows } = await dbPool.query( 'SELECT payment_status FROM pix_transactions WHERE depix_api_entry_id = $1', [depixApiEntryId]);

            if (rows.length === 0) {
                console.warn(`[Worker ${QUEUE_NAME}] Transaction with depix_api_entry_id ${depixApiEntryId} not found. Job will be discarded.`);
                return;
            }

            const currentStatus = rows[0].payment_status;
            if (currentStatus === 'PENDING') {
                console.log(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} is PENDING. Sending expectation message.`);
                
                const message = 
                    `Lembrete: Após o pagamento do Pix, seus DePix podem levar alguns instantes \\(geralmente até 2 minutos\\) para serem creditados em sua carteira Liquid\\.\n\n` +
                    `Se você já pagou e está aguardando, um pouco mais de paciência\\! Se houver qualquer problema ou demora excessiva, contate nosso suporte: ${supportContact}`;
                
                const sentMessage = await bot.telegram.sendMessage( telegramUserId, message, { parse_mode: 'MarkdownV2' } );
                
                if (sentMessage && sentMessage.message_id) {
                    await dbPool.query('UPDATE pix_transactions SET reminder_message_id = $1 WHERE depix_api_entry_id = $2', [sentMessage.message_id, depixApiEntryId]);
                    console.log(`[Worker ${QUEUE_NAME}] Stored reminder_message_id ${sentMessage.message_id} for ${depixApiEntryId}.`);
                }
            } else {
                // LOG MELHORADO: Informa exatamente por que a mensagem não foi enviada.
                console.log(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} is no longer PENDING (current status: ${currentStatus}). Reminder message will NOT be sent.`);
            }
        } catch (error) {
            console.error(`[Worker ${QUEUE_NAME}] Error processing job ${job.id}:`, error);
            throw error; // Lança o erro para o BullMQ registrar como falha.
        }
    }, { connection });

    worker.on('completed', (job) => { console.log(`[Worker ${QUEUE_NAME}] Job ${job.id} completed.`); });
    worker.on('failed', (job, err) => { console.error(`[Worker ${QUEUE_NAME}] Job ${job.id} failed: ${err.message}`);});
    console.log(`BullMQ Worker for ${QUEUE_NAME} initialized and listening for jobs.`);
};

module.exports = { expectationMessageQueue, initializeExpectationWorker, QUEUE_NAME };