const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { v4: uuidv4 } = require('uuid');
const config = require('../core/config');
const logger = require('../core/logger');

const depixApi = axios.create({
    baseURL: config.depix.apiBaseUrl,
    timeout: 20000, 
});

if (config.tor.socksProxy && config.app.nodeEnv !== 'development_no_tor') {
    const httpsAgent = new SocksProxyAgent(config.tor.socksProxy);
    depixApi.defaults.httpsAgent = httpsAgent;
    logger.info(`DePix API service configured to use Tor proxy: ${config.tor.socksProxy}`);
} else {
    logger.info('DePix API service configured WITHOUT Tor proxy.');
}

depixApi.interceptors.request.use(
    (axiosConfig) => {
        axiosConfig.headers['Authorization'] = `Bearer ${config.depix.apiJwtToken}`;
        if (!axiosConfig.url.endsWith('/ping')) {
            axiosConfig.headers['X-Nonce'] = uuidv4();
        }
        axiosConfig.headers['Content-Type'] = 'application/json';
        logger.info(`DePix API Request: ${axiosConfig.method.toUpperCase()} ${axiosConfig.url}`, { nonce: axiosConfig.headers['X-Nonce'] || 'N/A' });
        if (axiosConfig.data) {
            logger.info('DePix API Request Body:', JSON.stringify(axiosConfig.data));
        }
        return axiosConfig;
    },
    (error) => {
        logger.error('Error in DePix API request interceptor:', error);
        return Promise.reject(error);
    }
);

depixApi.interceptors.response.use(
    (response) => {
        logger.info(`DePix API Response Status: ${response.status} for ${response.config.url}`);
        if (response.data.async === true) {
            logger.warn('DePix API responded in ASYNC mode. This is not fully handled and may cause issues.');
        }
        return response.data; 
    },
    (error) => {
        if (error.response) {
            logger.error(`DePix API Error Status: ${error.response.status} for ${error.config.url}`);
            logger.error('DePix API Error Data:', JSON.stringify(error.response.data));
        } else if (error.request) {
            logger.error(`DePix API Error: No response received for ${error.config.url}.`, error.message);
        } else {
            logger.error('DePix API Error: Request setup error.', error.message);
        }
        return Promise.reject(error);
    }
);

const ping = async () => {
    try {
        const data = await depixApi.get('/ping');
        const isOk = data?.response?.msg === 'Pong!';
        if (isOk) logger.info('DePix API /ping successful.');
        else logger.warn('DePix API /ping did not return "Pong!" as expected.');
        return isOk;
    } catch (error) {
        logger.error('DePix API /ping failed.');
        return false;
    }
};

const generatePixForDeposit = async (amountInCents, userLiquidAddress, webhookUrl) => {
    if (!userLiquidAddress || !webhookUrl) {
        throw new Error('User Liquid address and Webhook URL are required.');
    }
    const payload = {
        amountInCents: parseInt(amountInCents, 10),
        depixAddress: userLiquidAddress,
        callback_url: webhookUrl,
    };
    try {
        const data = await depixApi.post('/deposit', payload); 
        if (data.response?.errorMessage) {
            throw new Error(data.response.errorMessage);
        }
        if (data.response?.qrCopyPaste && data.response?.qrImageUrl && data.response?.id) {
            return data.response; 
        }
        if (data.async === true) {
            throw new Error('API DePix respondeu em modo assíncrono. Tente novamente em alguns instantes.');
        }
        throw new Error('Resposta inesperada da API DePix ao gerar QR Code.');
    } catch (error) {
        const errorMessage = error.response?.data?.response?.errorMessage || error.message || 'Erro desconhecido na API DePix.';
        logger.error(`Failed to generate Pix for deposit: ${errorMessage}`);
        throw new Error(`Falha ao gerar QR Code Pix: ${errorMessage}`);
    }
};

module.exports = {
    ping,
    generatePixForDeposit,
};