require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

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
        nodeEnv: process.env.NODE_ENV || 'development',
    },
    tor: {
        socksProxy: process.env.TOR_SOCKS_PROXY,
    },
    redis: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
    },
    // NOVA SEÇÃO DE LINKS
    links: {
        communityGroup: process.env.LINK_COMMUNITY_GROUP || 'https://t.me/sua_comunidade_atlas_default', // Adicione no .env se quiser
        supportContact: process.env.LINK_SUPPORT_CONTACT || '@Atlas_suporte_default', // Adicione no .env se quiser
        githubRepo: process.env.LINK_GITHUB_REPO || 'https://github.com/seu_usuario/seu_repo_default' // Adicione no .env se quiser
    }
};

// Validação básica das configurações essenciais
if (!config.telegram.botToken) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
}
if (!config.depix.apiBaseUrl) {
    throw new Error('Missing DEPIX_API_BASE_URL in .env');
}
if (!config.depix.apiJwtToken) {
    throw new Error('Missing DEPIX_API_JWT_TOKEN in .env');
}
if (!config.depix.webhookSecret) {
    throw new Error('Missing DEPIX_WEBHOOK_SECRET in .env');
}
if (!config.supabase.url || !config.supabase.serviceKey || !config.supabase.databaseUrl) {
    throw new Error('Missing Supabase configuration in .env');
}
if (!config.app.baseUrl || !config.app.port) {
    throw new Error('Missing App configuration (baseUrl, port) in .env');
}
if (!config.tor.socksProxy) {
    console.warn('Warning: Missing TOR_SOCKS_PROXY in .env. API calls to DePix will not go through Tor.');
}
if (!config.redis.host || !config.redis.port) {
    throw new Error('Missing Redis configuration (host, port) in .env');
}
if (!config.links.communityGroup) { // Exemplo de validação para os novos links
    console.warn('Warning: LINK_COMMUNITY_GROUP not set in .env, using default.');
}


module.exports = config;
