const path = require('path');

// Determina qual arquivo .env carregar com base no NODE_ENV
const nodeEnv = process.env.NODE_ENV || 'development';
const envPath = path.resolve(__dirname, `../../.env.${nodeEnv}`);

console.log(`Loading environment variables from: ${envPath}`);
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
        port: parseInt(process.env.PORT, 10) || 3000,
        nodeEnv: nodeEnv, // Usa a variável já determinada
    },
    tor: {
        socksProxy: process.env.TOR_SOCKS_PROXY,
    },
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        // NOVA CONFIGURAÇÃO: DB do Redis para isolamento
        db: parseInt(process.env.REDIS_DB, 10) || 0,
    },
    links: {
        communityGroup: process.env.LINK_COMMUNITY_GROUP || 'https://t.me/atlassupport_group',
        supportContact: process.env.LINK_SUPPORT_CONTACT || '@AtlasDAO_Support',
        githubRepo: process.env.LINK_GITHUB_REPO || 'https://github.com/atlasdao'
    }
};

// Validação (permanece a mesma)
const essentialConfigs = {
    'TELEGRAM_BOT_TOKEN': config.telegram.botToken,
    'DEPIX_API_BASE_URL': config.depix.apiBaseUrl,
    'DEPIX_API_JWT_TOKEN': config.depix.apiJwtToken,
    'DEPIX_WEBHOOK_SECRET': config.depix.webhookSecret,
    'SUPABASE_URL': config.supabase.url,
    'SUPABASE_SERVICE_KEY': config.supabase.serviceKey,
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
    console.warn(`Warning from ${envPath}: Missing TOR_SOCKS_PROXY. API calls to DePix will not go through Tor.`);
}

console.log(`Configuration loaded for NODE_ENV: "${config.app.nodeEnv}"`);
console.log(`Using Redis DB: ${config.redis.db}`);

module.exports = config;