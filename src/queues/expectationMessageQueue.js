const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../core/config');
const logger = require('../core/logger');
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
connection.on('connect', () => logger.info(`BullMQ Redis connected for ${QUEUE_NAME} queue on DB ${config.redis.db}.`));
connection.on('error', (err) => logger.error(`BullMQ Redis connection error for ${QUEUE_NAME} on DB ${config.redis.db}:`, err));

const expectationMessageQueue = new Queue(QUEUE_NAME, { connection });
logger.info(`BullMQ Queue "${QUEUE_NAME}" initialized on DB ${config.redis.db}.`);

const initializeExpectationWorker = (dbPool, botInstanceGetter) => {
    logger.info(`Initializing BullMQ Worker for queue: ${QUEUE_NAME} on DB ${config.redis.db}`);
    const worker = new Worker(QUEUE_NAME, async (job) => {
        const { telegramUserId, depixApiEntryId, supportContact } = job.data;
        const bot = botInstanceGetter(); 

        if (!bot) {
            logger.error(`[Worker ${QUEUE_NAME}] FATAL: Bot instance is not available. Aborting job ${job.id}.`);
            throw new Error('Bot instance not available for worker.');
        }
        logger.info(`[Worker ${QUEUE_NAME}] Processing job ${job.id} for user ${telegramUserId}`);

        try {
            const { rows } = await dbPool.query( 'SELECT payment_status FROM pix_transactions WHERE depix_api_entry_id = $1', [depixApiEntryId]);
            if (rows.length === 0) {
                logger.warn(`[Worker ${QUEUE_NAME}] Transaction with depix_api_entry_id ${depixApiEntryId} not found. Job will be discarded.`);
                return;
            }
            if (rows[0].payment_status === 'PENDING') {
                logger.info(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} is PENDING. Sending expectation message.`);
                const message = `Lembrete: Após o pagamento do Pix, seus DePix podem levar alguns instantes para serem creditados em sua carteira Liquid\\.\n\n` +
                                `Se já pagou e está aguardando, um pouco mais de paciência\\! Se houver qualquer problema, contate nosso suporte: ${supportContact}`;
                const sentMessage = await bot.telegram.sendMessage( telegramUserId, message, { parse_mode: 'MarkdownV2' } );
                if (sentMessage?.message_id) {
                    await dbPool.query('UPDATE pix_transactions SET reminder_message_id = $1 WHERE depix_api_entry_id = $2', [sentMessage.message_id, depixApiEntryId]);
                    logger.info(`[Worker ${QUEUE_NAME}] Stored reminder_message_id ${sentMessage.message_id} for ${depixApiEntryId}.`);
                }
            } else {
                logger.info(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} is no longer PENDING (status: ${rows[0].payment_status}). Reminder message was not sent.`);
            }
        } catch (error) {
            logger.error(`[Worker ${QUEUE_NAME}] Error processing job ${job.id}:`, error);
            throw error;
        }
    }, { connection });

    worker.on('completed', (job) => logger.info(`[Worker ${QUEUE_NAME}] Job ${job.id} completed.`));
    worker.on('failed', (job, err) => logger.error(`[Worker ${QUEUE_NAME}] Job ${job.id} failed: ${err.message}`));
};

module.exports = { expectationMessageQueue, initializeExpectationWorker };