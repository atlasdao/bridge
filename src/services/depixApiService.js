const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { v4: uuidv4 } = require('uuid');
const config = require('../core/config');
const logger = require('../core/logger');

// Endereço Atlas para receber contribuições via splitFee
const ATLAS_SPLIT_ADDRESS = 'VJLBCUaw6GL8AuyjsrwpwTYNCUfUxPVTfxxffNTEZMKEjSwamWL6YqUUWLvz89ts1scTDKYoTF8oruMX';

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
        if (isOk) {
            logger.info('DePix API /ping successful.');
            return { success: true };
        } else {
            logger.warn('DePix API /ping did not return "Pong!" as expected.');
            return { success: false, error: 'Invalid ping response' };
        }
    } catch (error) {
        logger.error('DePix API /ping failed:', error.message);
        return { success: false, error: error.message };
    }
};

const generatePixForDeposit = async (amountInCents, userLiquidAddress, webhookUrl, userInfo = {}) => {
    if (!userLiquidAddress || !webhookUrl) {
        throw new Error('User Liquid address and Webhook URL are required.');
    }
    const payload = {
        amountInCents: parseInt(amountInCents, 10),
        depixAddress: userLiquidAddress,
        callback_url: webhookUrl,
    };

    // Adicionar splitFee se usuário tem contribuição configurada
    if (userInfo.contributionFee && parseFloat(userInfo.contributionFee) > 0) {
        payload.depixSplitAddress = ATLAS_SPLIT_ADDRESS;
        payload.splitFee = `${userInfo.contributionFee}%`;
        logger.info(`[CONTRIBUTION] Adding splitFee: ${userInfo.contributionFee}% to Atlas address`);
    }

    // Lógica de identificação do usuário:
    // 1. Se tem EUID (usuário já fez transação antes): usa EUID (apenas dono pode pagar)
    // 2. Se não tem EUID: QR aberto (EUID será capturado do webhook)
    // Nota: Eulen alterou regras - CPF não é mais usado para identificação

    if (userInfo.euid) {
        // Usuário já tem EUID - apenas dono do EUID pode pagar
        payload.euid = userInfo.euid;
        logger.info('Using EUID for transaction:', payload.euid);
    } else {
        // Usuário não tem EUID - gerar QR aberto
        // O EUID virá no webhook e será salvo para futuras transações
        logger.info('Generating open QR code - EUID will be captured from webhook');
    }
    try {
        const data = await depixApi.post('/deposit', payload); 
        if (data.response?.errorMessage) {
            throw new Error(data.response.errorMessage);
        }
        if (data.response?.qrCopyPaste && data.response?.qrImageUrl && data.response?.id) {
            logger.info(`DePix deposit created with ID: ${data.response.id}`);
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

const getDepositStatus = async (qrId) => {
    if (!qrId) {
        throw new Error('QR ID is required to check deposit status.');
    }
    try {
        const data = await depixApi.get(`/deposit-status/${qrId}`);
        if (data.response) {
            return data.response;
        }
        throw new Error('Resposta inesperada da API DePix ao verificar status.');
    } catch (error) {
        const errorMessage = error.response?.data?.response?.errorMessage || error.message || 'Erro ao verificar status.';
        logger.error(`Failed to get deposit status: ${errorMessage}`);
        throw new Error(`Falha ao verificar status: ${errorMessage}`);
    }
};

module.exports = {
    ping,
    generatePixForDeposit,
    getDepositStatus,
};