const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { v4: uuidv4 } = require('uuid');
const config = require('../core/config');

const depixApi = axios.create({
    baseURL: config.depix.apiBaseUrl,
    timeout: 20000, 
});

if (config.tor.socksProxy && config.app.nodeEnv !== 'development_no_tor') {
    const httpsAgent = new SocksProxyAgent(config.tor.socksProxy);
    depixApi.defaults.httpsAgent = httpsAgent;
    console.log(`DePix API service configured to use Tor proxy: ${config.tor.socksProxy}`);
} else {
    console.log('DePix API service configured WITHOUT Tor proxy.');
}

depixApi.interceptors.request.use(
    (axiosConfig) => {
        axiosConfig.headers['Authorization'] = `Bearer ${config.depix.apiJwtToken}`;
        if (!axiosConfig.url.endsWith('/ping')) {
            axiosConfig.headers['X-Nonce'] = uuidv4();
        }
        axiosConfig.headers['Content-Type'] = 'application/json';
        console.log(`DePix API Request: ${axiosConfig.method.toUpperCase()} ${axiosConfig.url} with Nonce ${axiosConfig.headers['X-Nonce'] || 'N/A'}`);
        if (axiosConfig.data) {
            console.log('DePix API Request Body:', JSON.stringify(axiosConfig.data));
        }
        return axiosConfig;
    },
    (error) => {
        console.error('Error in DePix API request interceptor:', error);
        return Promise.reject(error);
    }
);

depixApi.interceptors.response.use(
    (response) => {
        console.log(`DePix API Response Status: ${response.status} for ${response.config.url}`);
        if (response.config.url.endsWith('/ping')) {
            console.log('DePix API /ping Response Data:', JSON.stringify(response.data));
        } else {
            console.log('DePix API Response Data:', JSON.stringify(response.data));
        }
        if (response.data.async === true) {
            console.warn('DePix API responded in ASYNC mode. Polling not yet implemented.');
        }
        return response.data; 
    },
    (error) => {
        if (error.response) {
            console.error(`DePix API Error Status: ${error.response.status} for ${error.config.url}`);
            console.error('DePix API Error Data:', JSON.stringify(error.response.data));
        } else if (error.request) {
            console.error(`DePix API Error: No response received for ${error.config.url}.`, error.message);
        } else {
            console.error('DePix API Error: Request setup error.', error.message);
        }
        return Promise.reject(error);
    }
);

const ping = async () => {
    try {
        const data = await depixApi.get('/ping');
        if (data && data.response && data.response.msg === 'Pong!') {
            console.log('DePix API /ping successful.');
            return true;
        }
        console.warn('DePix API /ping did not return "Pong!" as expected:', data);
        return false;
    } catch (error) {
        console.error('DePix API /ping failed.');
        return false;
    }
};

const generatePixForDeposit = async (amountInCents, userLiquidAddress, endUserFullName = undefined, endUserTaxNumber = undefined) => {
    const payload = {
        amountInCents: parseInt(amountInCents, 10),
        depixAddress: userLiquidAddress, 
    };
    if (endUserFullName) payload.endUserFullName = endUserFullName;
    if (endUserTaxNumber) payload.endUserTaxNumber = endUserTaxNumber;

    if (!userLiquidAddress) {
        throw new Error('User Liquid address is required to generate Pix for deposit.');
    }
    try {
        const data = await depixApi.post('/deposit', payload); 
        if (data.response && data.response.errorMessage) {
            console.error('DePix API /deposit returned an error message:', data.response.errorMessage);
            throw new Error(data.response.errorMessage);
        }
        if (data.response && data.response.qrCopyPaste && data.response.qrImageUrl && data.response.id) {
            return data.response; 
        }
        if (data.async === true && data.urlResponse) {
            console.warn('DePix API /deposit responded in ASYNC mode. This is not fully handled yet.');
            throw new Error('API DePix respondeu em modo assíncrono. Tente novamente em alguns instantes.');
        }
        console.error('Resposta inesperada da API DePix /deposit:', data);
        throw new Error('Resposta inesperada da API DePix ao gerar QR Code.');
    } catch (error) {
        const errorMessage = error.response?.data?.response?.errorMessage || error.message || 'Erro desconhecido ao comunicar com a API DePix.';
        console.error(`Failed to generate Pix for deposit: ${errorMessage}`);
        throw new Error(`Falha ao gerar QR Code Pix: ${errorMessage}`);
    }
};

module.exports = {
    ping,
    generatePixForDeposit,
};
