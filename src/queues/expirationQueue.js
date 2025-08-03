const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../core/config');
const { escapeMarkdownV2 } = require('../bot/handlers');

const QUEUE_NAME = 'expirationJobs';

const connection = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

connection.on('connect', () => console.log(`BullMQ Redis connected for ${QUEUE_NAME} queue.`));
connection.on('error', (err) => console.error(`BullMQ Redis connection error for ${QUEUE_NAME}:`, err));

const expirationQueue = new Queue(QUEUE_NAME, { connection });
console.log(`BullMQ Queue "${QUEUE_NAME}" initialized.`);

const initializeExpirationWorker = (dbPool, botInstanceGetter) => {
    console.log(`Initializing BullMQ Worker for queue: ${QUEUE_NAME}`);
    const worker = new Worker(QUEUE_NAME, async (job) => {
        const { telegramUserId, depixApiEntryId, requestedBrlAmount } = job.data;
        const bot = botInstanceGetter();

        if (!bot) {
            throw new Error('Bot instance not available for expiration worker.');
        }

        console.log(`[Worker ${QUEUE_NAME}] Processing job ${job.id} for user ${telegramUserId}, depixEntryId ${depixApiEntryId}`);

        try {
            const { rows } = await dbPool.query(
                'SELECT payment_status, qr_code_message_id FROM pix_transactions WHERE depix_api_entry_id = $1',
                [depixApiEntryId]
            );

            if (rows.length > 0 && rows[0].payment_status === 'PENDING') {
                console.log(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} has expired. Updating status and notifying user.`);

                await dbPool.query(
                    'UPDATE pix_transactions SET payment_status = $1, updated_at = NOW() WHERE depix_api_entry_id = $2',
                    ['EXPIRED', depixApiEntryId]
                );

                const amountStr = escapeMarkdownV2(Number(requestedBrlAmount).toFixed(2));
                const message = `O QR Code referente à compra de R\\$ ${amountStr} expirou\\. Por favor, gere um novo se desejar continuar\\.`;

                const qrMessageId = rows[0].qr_code_message_id;
                if (qrMessageId) {
                    try {
                        await bot.telegram.deleteMessage(telegramUserId, qrMessageId);
                        console.log(`[Worker ${QUEUE_NAME}] Deleted expired QR Code message ${qrMessageId} for user ${telegramUserId}.`);
                    } catch (deleteError) {
                        console.error(`[Worker ${QUEUE_NAME}] Failed to delete expired QR code message ${qrMessageId}. Error: ${deleteError.message}`);
                    }
                }

                await bot.telegram.sendMessage(telegramUserId, message, { parse_mode: 'MarkdownV2' });

                console.log(`[Worker ${QUEUE_NAME}] Expiration message sent to user ${telegramUserId} for ${depixApiEntryId}.`);

            } else if (rows.length > 0) {
                console.log(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} is no longer PENDING (status: ${rows[0].payment_status}). Job will complete without action.`);
            } else {
                console.warn(`[Worker ${QUEUE_NAME}] Transaction with depix_api_entry_id ${depixApiEntryId} not found.`);
            }
        } catch (error) {
            console.error(`[Worker ${QUEUE_NAME}] Error processing job ${job.id}:`, error);
            throw error;
        }
    }, { connection });

    worker.on('completed', (job) => { console.log(`[Worker ${QUEUE_NAME}] Job ${job.id} completed.`); });
    worker.on('failed', (job, err) => { console.error(`[Worker ${QUEUE_NAME}] Job ${job.id} failed: ${err.message}`);});
    console.log(`BullMQ Worker for ${QUEUE_NAME} initialized and listening for jobs.`);
};

module.exports = { expirationQueue, initializeExpirationWorker, QUEUE_NAME };