/**
 * Atlas API Service for Bounties
 *
 * Handles PIX payment generation via Atlas API (different from DePix API).
 * Used exclusively for the bounty voting/funding system.
 */

const axios = require('axios');
const config = require('../core/config');
const logger = require('../core/logger');

// Create axios instance for Atlas API
const atlasApi = axios.create({
    baseURL: config.atlas.apiBaseUrl,
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.atlas.apiKey
    }
});

// Request interceptor for logging
atlasApi.interceptors.request.use(
    (axiosConfig) => {
        logger.info(`[AtlasAPI] Request: ${axiosConfig.method.toUpperCase()} ${axiosConfig.url}`);
        if (axiosConfig.data) {
            // Log without sensitive data
            const safeData = { ...axiosConfig.data };
            if (safeData.webhook?.secret) {
                safeData.webhook = { ...safeData.webhook, secret: '[REDACTED]' };
            }
            // logger.info('[AtlasAPI] Request Body:', JSON.stringify(safeData));
        }
        return axiosConfig;
    },
    (error) => {
        logger.error('[AtlasAPI] Request interceptor error:', error.message);
        return Promise.reject(error);
    }
);

// Response interceptor for logging
atlasApi.interceptors.response.use(
    (response) => {
        logger.info(`[AtlasAPI] Response: ${response.status} for ${response.config.url}`);
        return response.data;
    },
    (error) => {
        if (error.response) {
            logger.error(`[AtlasAPI] Error ${error.response.status}: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            logger.error(`[AtlasAPI] No response received: ${error.message}`);
        } else {
            logger.error(`[AtlasAPI] Request setup error: ${error.message}`);
        }
        return Promise.reject(error);
    }
);

/**
 * Create a PIX payment for bounty voting
 *
 * @param {Object} params - Payment parameters
 * @param {number} params.amount - Amount in BRL (e.g., 50.00)
 * @param {string} params.description - Payment description
 * @param {string} params.depixAddress - Liquid address to receive DePix
 * @param {string} params.merchantOrderId - Our internal order ID for tracking
 * @returns {Promise<Object>} Payment data including QR code
 */
const createPixPayment = async ({ amount, description, depixAddress, merchantOrderId }) => {
    if (!config.atlas.apiKey) {
        throw new Error('Atlas API key not configured');
    }

    if (amount < config.bounties.minPixAmountBrl) {
        throw new Error(`Valor mínimo é R$ ${config.bounties.minPixAmountBrl.toFixed(2)}`);
    }

    if (amount > config.bounties.maxPixAmountBrl) {
        throw new Error(`Valor máximo é R$ ${config.bounties.maxPixAmountBrl.toFixed(2)}`);
    }

    const webhookUrl = `${config.app.baseUrl}/webhooks/atlas`;

    const payload = {
        amount: parseFloat(amount.toFixed(2)),
        description: description || 'Atlas Bounty Vote',
        depixAddress: depixAddress,
        merchantOrderId: merchantOrderId,
        webhook: {
            url: webhookUrl,
            events: ['transaction.created', 'transaction.paid', 'transaction.failed', 'transaction.expired'],
            secret: config.atlas.webhookSecret
        }
    };

    try {
        const response = await atlasApi.post('/external/pix/create', payload);

        if (!response.id || !response.qrCode) {
            logger.error('[AtlasAPI] Invalid response:', response);
            throw new Error('Resposta inválida da API Atlas');
        }

        logger.info(`[AtlasAPI] PIX created: ${response.id} for order ${merchantOrderId}`);

        return {
            id: response.id,
            status: response.status,
            amount: response.amount,
            qrCode: response.qrCode,
            qrCodeImage: response.qrCodeImage,
            expiresAt: response.expiresAt,
            merchantOrderId: response.merchantOrderId
        };
    } catch (error) {
        const errorMessage = error.response?.data?.message || error.message || 'Erro ao criar pagamento PIX';
        logger.error(`[AtlasAPI] Failed to create PIX: ${errorMessage}`);
        throw new Error(`Falha ao gerar QR Code: ${errorMessage}`);
    }
};

/**
 * Get payment status from Atlas API
 *
 * @param {string} transactionId - Atlas transaction ID
 * @returns {Promise<Object>} Payment status data
 */
const getPaymentStatus = async (transactionId) => {
    if (!transactionId) {
        throw new Error('Transaction ID is required');
    }

    try {
        const response = await atlasApi.get(`/external/pix/status/${transactionId}`);

        return {
            id: response.id,
            status: response.status,
            amount: response.amount,
            processedAt: response.processedAt,
            expiresAt: response.expiresAt,
            merchantOrderId: response.merchantOrderId
        };
    } catch (error) {
        const errorMessage = error.response?.data?.message || error.message || 'Erro ao verificar status';
        logger.error(`[AtlasAPI] Failed to get status for ${transactionId}: ${errorMessage}`);
        throw new Error(`Falha ao verificar status: ${errorMessage}`);
    }
};

/**
 * Get current crypto prices for BRL conversion
 * Uses CoinGecko API (free, no auth required)
 *
 * @returns {Promise<Object>} Prices in BRL { btc: number, usdt: number }
 */
const getCryptoPrices = async () => {
    try {
        // CoinGecko free API for BTC and USDT prices in BRL
        const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether&vs_currencies=brl',
            { timeout: 10000 }
        );

        const prices = {
            btc: response.data.bitcoin?.brl || 0,
            usdt: response.data.tether?.brl || 0,
            depix: 1  // DePix is 1:1 with BRL
        };

        // logger.info(`[AtlasAPI] Crypto prices: BTC=${prices.btc} BRL, USDT=${prices.usdt} BRL`);
        return prices;
    } catch (error) {
        logger.error(`[AtlasAPI] Failed to get crypto prices: ${error.message}`);
        // Return fallback prices
        return {
            btc: 600000,  // ~R$ 600k fallback
            usdt: 6,      // ~R$ 6 fallback
            depix: 1
        };
    }
};

/**
 * Convert crypto amount to BRL
 *
 * @param {string} assetType - 'DEPIX', 'LBTC', 'USDT'
 * @param {number} amount - Amount in the asset
 * @returns {Promise<number>} Amount in BRL
 */
const convertToBrl = async (assetType, amount) => {
    const prices = await getCryptoPrices();

    switch (assetType.toUpperCase()) {
        case 'DEPIX':
        case 'PIX':
            return amount;  // 1:1 with BRL
        case 'LBTC':
        case 'L-BTC':
            return amount * prices.btc;
        case 'USDT':
        case 'L-USDT':
            return amount * prices.usdt;
        default:
            logger.warn(`[AtlasAPI] Unknown asset type: ${assetType}`);
            return amount;
    }
};

module.exports = {
    createPixPayment,
    getPaymentStatus,
    getCryptoPrices,
    convertToBrl
};
