const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../core/config');
const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');

const QUEUE_NAME = 'expirationJobs';

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

const expirationQueue = new Queue(QUEUE_NAME, { connection });
logger.info(`BullMQ Queue "${QUEUE_NAME}" initialized on DB ${config.redis.db}.`);

const initializeExpirationWorker = (dbPool, botInstanceGetter) => {
    logger.info(`Initializing BullMQ Worker for queue: ${QUEUE_NAME} on DB ${config.redis.db}`);
    const worker = new Worker(QUEUE_NAME, async (job) => {
        const { telegramUserId, depixApiEntryId, requestedBrlAmount, qrId, userId, isVerification } = job.data;
        const bot = botInstanceGetter();

        if (!bot) {
            logger.error(`[Worker ${QUEUE_NAME}] FATAL: Bot instance is not available. Aborting job ${job.id}.`);
            throw new Error('Bot instance not available for expiration worker.');
        }
        
        // Para compatibilidade com jobs antigos
        const userIdToNotify = telegramUserId || userId;
        const depixId = depixApiEntryId || qrId;
        
        logger.info(`[Worker ${QUEUE_NAME}] Processing job ${job.id} for user ${userIdToNotify}, isVerification: ${isVerification}`);

        try {
            // Verificar se é uma transação de verificação
            if (isVerification) {
                const { rows: verificationRows } = await dbPool.query(
                    'SELECT verification_status, qr_code_message_id FROM verification_transactions WHERE depix_api_entry_id = $1',
                    [depixId]
                );
                
                if (verificationRows.length > 0 && verificationRows.verification_status === 'PENDING') {
                    logger.info(`[Worker ${QUEUE_NAME}] Verification ${depixId} has expired. Updating status and notifying user.`);
                    await dbPool.query(
                        'UPDATE verification_transactions SET verification_status = $1, updated_at = NOW() WHERE depix_api_entry_id = $2',
                        ['EXPIRED', depixId]
                    );
                    
                    const message = `⏰ **Validação Expirada**\\n\\n` +
                                  `O QR Code de validação de R\\$ 1,00 expirou\\.\\n\\n` +
                                  `Você pode gerar um novo QR Code quando quiser\\. Use o menu principal para tentar novamente\\.`;
                    
                    const qrMessageId = verificationRows[0].qr_code_message_id;
                    if (qrMessageId) {
                        try {
                            await bot.telegram.deleteMessage(userIdToNotify, qrMessageId);
                            logger.info(`[Worker ${QUEUE_NAME}] Deleted expired verification QR message ${qrMessageId}.`);
                        } catch (deleteError) {
                            logger.error(`[Worker ${QUEUE_NAME}] Failed to delete expired verification QR message ${qrMessageId}: ${deleteError.message}`);
                        }
                    }
                    await bot.telegram.sendMessage(userIdToNotify, message, { parse_mode: 'MarkdownV2' });
                } else if (verificationRows.length > 0) {
                    logger.info(`[Worker ${QUEUE_NAME}] Verification ${depixId} is no longer PENDING (status: ${verificationRows[0].verification_status}). Expiration job will complete without action.`);
                } else {
                    logger.warn(`[Worker ${QUEUE_NAME}] Verification with depix_api_entry_id ${depixId} not found.`);
                }
            } else {
                // Transação normal (não verificação)
                const { rows } = await dbPool.query(
                    'SELECT payment_status, qr_code_message_id FROM pix_transactions WHERE depix_api_entry_id = $1',
                    [depixId]
                );

                if (rows.length > 0 && rows[0].payment_status === 'PENDING') {
                    logger.info(`[Worker ${QUEUE_NAME}] Transaction ${depixId} has expired. Updating status and notifying user.`);
                    await dbPool.query( 'UPDATE pix_transactions SET payment_status = $1, updated_at = NOW() WHERE depix_api_entry_id = $2', ['EXPIRED', depixId] );

                    const amountStr = escapeMarkdownV2(Number(requestedBrlAmount).toFixed(2));
                    const message = `O QR Code referente à compra de R\\$ ${amountStr} expirou\\. Por favor, gere um novo se desejar continuar\\.`;

                    const qrMessageId = rows[0].qr_code_message_id;
                    if (qrMessageId) {
                        try {
                            await bot.telegram.deleteMessage(userIdToNotify, qrMessageId);
                            logger.info(`[Worker ${QUEUE_NAME}] Deleted expired QR Code message ${qrMessageId}.`);
                        } catch (deleteError) {
                            logger.error(`[Worker ${QUEUE_NAME}] Failed to delete expired QR code message ${qrMessageId}: ${deleteError.message}`);
                        }
                    }
                    await bot.telegram.sendMessage(userIdToNotify, message, { parse_mode: 'MarkdownV2' });
                } else if (rows.length > 0) {
                    logger.info(`[Worker ${QUEUE_NAME}] Transaction ${depixId} is no longer PENDING (status: ${rows[0].payment_status}). Expiration job will complete without action.`);
                } else {
                    logger.warn(`[Worker ${QUEUE_NAME}] Transaction with depix_api_entry_id ${depixId} not found.`);
                }
            }
        } catch (error) {
            logger.error(`[Worker ${QUEUE_NAME}] Error processing job ${job.id}:`, error);
            throw error;
        }
    }, { connection });

    worker.on('completed', (job) => logger.info(`[Worker ${QUEUE_NAME}] Job ${job.id} completed.`));
    worker.on('failed', (job, err) => logger.error(`[Worker ${QUEUE_NAME}] Job ${job.id} failed: ${err.message}`));
};

module.exports = { expirationQueue, initializeExpirationWorker };