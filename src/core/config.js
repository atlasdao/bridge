const path = require('path');
const logger = require('./logger'); // Importar o logger

const nodeEnv = process.env.NODE_ENV || 'development';
const envPath = path.resolve(__dirname, `../../.env.${nodeEnv}`);

logger.info(`Loading environment variables from: ${envPath}`);
require('dotenv').config({ path: envPath });

const config = {
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
    },
    depix: {
        apiBaseUrl: process.env.DEPIX_API_BASE_URL,
        apiJwtToken: process.env.DEPIX_API_JWT_TOKEN,
        webhookSecret: process.env.DEPIX_WEBHOOK_SECRET,
    },
    supabase: {
        url: process.env.SUPABASE_URL,
        serviceKey: process.env.SUPABASE_SERVICE_KEY,
        databaseUrl: process.env.DATABASE_URL,
    },
    app: {
        baseUrl: process.env.APP_BASE_URL,
        port: parseInt(process.env.PORT, 10) || (nodeEnv === 'production' ? 3000 : 3001),
        nodeEnv: nodeEnv,
    },
    // URL interna do ambiente de desenvolvimento para o forwarder.
    developmentServerUrl: 'http://localhost:3001',
    tor: {
        socksProxy: process.env.TOR_SOCKS_PROXY,
    },
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB, 10) || 0,
    },
    links: {
        communityGroup: process.env.LINK_COMMUNITY_GROUP || 'https://t.me/atlassupport_group',
        supportContact: process.env.LINK_SUPPORT_CONTACT || '@AtlasDAO_Support',
        githubRepo: process.env.LINK_GITHUB_REPO || 'https://github.com/atlasdao'
    }
};

const essentialConfigs = {
    'TELEGRAM_BOT_TOKEN': config.telegram.botToken,
    'DEPIX_API_BASE_URL': config.depix.apiBaseUrl,
    'DEPIX_API_JWT_TOKEN': config.depix.apiJwtToken,
    'DEPIX_WEBHOOK_SECRET': config.depix.webhookSecret,
    'DATABASE_URL': config.supabase.databaseUrl,
    'APP_BASE_URL': config.app.baseUrl,
    'REDIS_HOST': config.redis.host,
};

for (const [key, value] of Object.entries(essentialConfigs)) {
    if (!value) {
        throw new Error(`Missing essential configuration in ${envPath}: ${key}`);
    }
}

if (!config.tor.socksProxy) {
    logger.warn(`Warning from ${envPath}: Missing TOR_SOCKS_PROXY. API calls to DePix will not go through Tor.`);
}

logger.info(`Configuration loaded for NODE_ENV: "${config.app.nodeEnv}"`);
logger.info(`Using App Base URL: ${config.app.baseUrl}`);
logger.info(`Using App Port: ${config.app.port}`);
logger.info(`Using Redis DB: ${config.redis.db}`);

module.exports = config;