const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../core/config');
// Precisaremos do dbPool e da instância do bot aqui também, ou uma forma de acessá-los.
// Por simplicidade no MVP, vamos requerer a instância do bot de app.js e passar dbPool.
// Em uma arquitetura maior, você usaria injeção de dependência ou um service locator.

const QUEUE_NAME = 'expectationMessages';

// Configuração de conexão Redis para BullMQ
const connection = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: null, // BullMQ lida com retries
    enableReadyCheck: false,
});

connection.on('connect', () => console.log(`BullMQ Redis connected for ${QUEUE_NAME} queue.`));
connection.on('error', (err) => console.error(`BullMQ Redis connection error for ${QUEUE_NAME}:`, err));

// Criar a fila
const expectationMessageQueue = new Queue(QUEUE_NAME, { connection });

console.log(`BullMQ Queue "${QUEUE_NAME}" initialized.`);

// Função para inicializar o Worker (será chamada em app.js)
const initializeExpectationWorker = (dbPool, botInstanceGetter) => {
    console.log(`Initializing BullMQ Worker for queue: ${QUEUE_NAME}`);
    const worker = new Worker(QUEUE_NAME, async (job) => {
        const { telegramUserId, depixApiEntryId, supportContact } = job.data;
        const bot = botInstanceGetter(); // Obter a instância do bot

        if (!bot) {
            console.error(`[Worker ${QUEUE_NAME}] Bot instance not available. Job ID: ${job.id}`);
            throw new Error('Bot instance not available for worker.');
        }

        console.log(`[Worker ${QUEUE_NAME}] Processing job ${job.id} for user ${telegramUserId}, depixEntryId ${depixApiEntryId}`);

        try {
            const { rows } = await dbPool.query(
                'SELECT payment_status FROM pix_transactions WHERE depix_api_entry_id = $1',
                [depixApiEntryId]
            );

            if (rows.length > 0 && rows[0].payment_status === 'PENDING') {
                console.log(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} still PENDING. Sending expectation message to user ${telegramUserId}.`);
                
                const message = `Lembrete: Após o pagamento do Pix, seus DePix podem levar alguns instantes (geralmente até 2 minutos) para serem creditados em sua carteira Liquid.\n\n` +
                                `Se você já pagou e está aguardando, um pouco mais de paciência! Se houver qualquer problema ou demora excessiva, contate nosso suporte: ${supportContact}`;
                
                // Usar a função de escape de handlers.js ou redefini-la
                const escape = text => text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');

                await bot.telegram.sendMessage(
                    telegramUserId,
                    escape(message), // Usar a função de escape
                    { parse_mode: 'MarkdownV2' }
                );
                console.log(`[Worker ${QUEUE_NAME}] Expectation message sent to user ${telegramUserId} for ${depixApiEntryId}.`);
            } else if (rows.length > 0) {
                console.log(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} no longer PENDING (status: ${rows[0].payment_status}). No message sent.`);
            } else {
                console.log(`[Worker ${QUEUE_NAME}] Transaction ${depixApiEntryId} not found. No message sent.`);
            }
        } catch (error) {
            console.error(`[Worker ${QUEUE_NAME}] Error processing job ${job.id} for depixEntryId ${depixApiEntryId}:`, error);
            throw error; // Importante para que o BullMQ possa tentar novamente se configurado
        }
    }, { connection });

    worker.on('completed', (job) => {
        console.log(`[Worker ${QUEUE_NAME}] Job ${job.id} (depixEntryId: ${job.data.depixApiEntryId}) has completed.`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[Worker ${QUEUE_NAME}] Job ${job.id} (depixEntryId: ${job.data.depixApiEntryId}) has failed with error: ${err.message}`);
        console.error(err.stack);
    });
    console.log(`BullMQ Worker for ${QUEUE_NAME} initialized and listening for jobs.`);
};

module.exports = {
    expectationMessageQueue,
    initializeExpectationWorker,
    QUEUE_NAME // Exportar para usar no cancelamento
};
