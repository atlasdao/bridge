/**
 * Serviço de Carteira Liquid para Saques
 *
 * Responsabilidades:
 * - Derivar endereços Liquid únicos via LWK Python
 * - Monitorar pagamentos via Esplora API
 * - Verificar confirmações de transações
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const path = require('path');
const logger = require('../core/logger');

const execFileAsync = promisify(execFile);

// Configurações
const LWK_SCRIPT_PATH = path.join(__dirname, '../../scripts/lwk_address.py');
const ESPLORA_API_URL = 'https://blockstream.info/liquid/api';
const DEPIX_ASSET_ID = '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189'; // Asset ID do DePix

class LiquidWalletService {
    constructor(dbPool) {
        this.dbPool = dbPool;
        this.esploraApi = axios.create({
            baseURL: ESPLORA_API_URL,
            timeout: 30000,
            headers: {
                'Accept': 'application/json'
            }
        });
    }

    /**
     * Deriva um novo endereço Liquid único para um saque
     * @returns {Promise<{address: string, index: number}>}
     */
    async deriveNewAddress() {
        try {
            // Obter próximo índice do banco de dados
            const result = await this.dbPool.query('SELECT get_next_withdrawal_address_index()');
            const index = result.rows[0].get_next_withdrawal_address_index;

            // Chamar script Python para derivar endereço
            const { stdout } = await execFileAsync('python3', [LWK_SCRIPT_PATH, 'derive', index.toString()]);
            const response = JSON.parse(stdout.trim());

            if (!response.success) {
                throw new Error(response.error || 'Erro ao derivar endereço');
            }

            logger.info(`[LiquidWallet] Endereço derivado: index=${index}, address=${response.address.substring(0, 20)}...`);

            return {
                address: response.address,
                index: index
            };
        } catch (error) {
            logger.error(`[LiquidWallet] Erro ao derivar endereço: ${error.message}`);
            throw error;
        }
    }

    /**
     * Verifica transações recebidas em um endereço
     * @param {string} address - Endereço Liquid
     * @returns {Promise<Array>} Lista de transações
     */
    async getAddressTransactions(address) {
        try {
            const response = await this.esploraApi.get(`/address/${address}/txs`);
            return response.data || [];
        } catch (error) {
            logger.error(`[LiquidWallet] Erro ao buscar transações: ${error.message}`);
            return [];
        }
    }

    /**
     * Verifica se um pagamento foi recebido usando LWK (suporta transações confidenciais)
     * @param {string} address - Endereço Liquid (não usado diretamente, usamos addressIndex)
     * @param {number} expectedAmount - Valor esperado em DePix
     * @param {number} tolerancePercent - Tolerância em %
     * @param {number} addressIndex - Índice do endereço na wallet
     * @returns {Promise<{found: boolean, status: string, txid: string, amount: number, confirmations: number, difference: number}>}
     */
    async checkPaymentReceived(address, expectedAmount, tolerancePercent = 0.1, addressIndex = null) {
        try {
            // Se não temos o índice, não podemos verificar via LWK
            if (addressIndex === null) {
                logger.warn(`[LiquidWallet] checkPaymentReceived chamado sem addressIndex para ${address}`);
                return { found: false, status: 'NOT_FOUND', txid: null, amount: null, confirmations: 0, difference: 0 };
            }

            // Usar script LWK para verificar pagamento (suporta CT)
            const { stdout } = await execFileAsync('python3', [LWK_SCRIPT_PATH, 'check_payment', addressIndex.toString()], {
                timeout: 60000
            });

            const result = JSON.parse(stdout.trim());

            if (!result.success) {
                logger.error(`[LiquidWallet] Erro no LWK check_payment: ${result.error}`);
                return { found: false, status: 'NOT_FOUND', txid: null, amount: null, confirmations: 0, difference: 0, error: result.error };
            }

            if (!result.found) {
                return { found: false, status: 'NOT_FOUND', txid: null, amount: null, confirmations: 0, difference: 0 };
            }

            // Pagamento encontrado - verificar valor
            const receivedAmount = result.total_amount;
            const minAmount = expectedAmount * (1 - tolerancePercent / 100);
            const maxAmount = expectedAmount * (1 + tolerancePercent / 100);
            const difference = receivedAmount - expectedAmount;

            let status;
            if (receivedAmount >= minAmount && receivedAmount <= maxAmount) {
                status = 'CORRECT';
            } else if (receivedAmount < minAmount) {
                status = 'INSUFFICIENT';
            } else {
                status = 'EXCESS';
            }

            // Obter confirmações da primeira transação
            let confirmations = 0;
            if (result.utxos && result.utxos.length > 0 && result.utxos[0].height) {
                try {
                    const tipResponse = await this.esploraApi.get('/blocks/tip/height');
                    const tipHeight = tipResponse.data;
                    confirmations = tipHeight - result.utxos[0].height + 1;
                } catch (e) {
                    confirmations = 1; // Assume pelo menos 1 se já está na blockchain
                }
            }

            logger.info(`[LiquidWallet] Pagamento detectado via LWK: index=${addressIndex}, amount=${receivedAmount} DePix (esperado: ${expectedAmount}) - Status: ${status}`);

            return {
                found: true,
                status: status,
                txid: result.txid,
                amount: receivedAmount,
                confirmations: confirmations,
                difference: difference,
                confidential: false
            };
        } catch (error) {
            logger.error(`[LiquidWallet] Erro ao verificar pagamento via LWK: ${error.message}`);
            return { found: false, status: 'NOT_FOUND', txid: null, amount: null, confirmations: 0, difference: 0, error: error.message };
        }
    }

    /**
     * Encontra QUALQUER pagamento para um endereço (independente do valor)
     * @param {Object} tx - Transação
     * @param {string} address - Endereço de destino
     * @returns {Object|null} Informações do pagamento ou null
     */
    async findAnyPaymentToAddress(tx, address) {
        try {
            if (!tx.vout) return null;

            for (const vout of tx.vout) {
                // Verificar se o output é para o endereço correto
                if (vout.scriptpubkey_address === address) {
                    // Para DePix, verificar o asset
                    if (vout.asset === DEPIX_ASSET_ID || !vout.asset) {
                        // Converter satoshis para valor com 2 casas decimais
                        const amount = vout.value ? vout.value / 100000000 : null;

                        // Se o valor é confidencial (null), retornar como confidencial
                        if (amount === null) {
                            logger.info(`[LiquidWallet] Transação confidencial detectada para ${address}`);
                            return { amount: 0, confidential: true };
                        }

                        return { amount: amount, confidential: false };
                    }
                }
            }

            return null;
        } catch (error) {
            logger.error(`[LiquidWallet] Erro ao analisar output: ${error.message}`);
            return null;
        }
    }

    /**
     * Obtém número de confirmações de uma transação
     * @param {string} txid - ID da transação
     * @returns {Promise<number>} Número de confirmações
     */
    async getTransactionConfirmations(txid) {
        try {
            const response = await this.esploraApi.get(`/tx/${txid}`);
            const tx = response.data;

            if (!tx.status || !tx.status.confirmed) {
                return 0;
            }

            // Buscar altura atual do bloco
            const tipResponse = await this.esploraApi.get('/blocks/tip/height');
            const tipHeight = tipResponse.data;

            const confirmations = tipHeight - tx.status.block_height + 1;
            return Math.max(0, confirmations);
        } catch (error) {
            logger.error(`[LiquidWallet] Erro ao obter confirmações: ${error.message}`);
            return 0;
        }
    }

    /**
     * Verifica status de uma transação
     * @param {string} txid - ID da transação
     * @returns {Promise<Object>} Status da transação
     */
    async getTransactionStatus(txid) {
        try {
            const response = await this.esploraApi.get(`/tx/${txid}`);
            const tx = response.data;

            return {
                confirmed: tx.status?.confirmed || false,
                blockHeight: tx.status?.block_height || null,
                blockTime: tx.status?.block_time || null
            };
        } catch (error) {
            logger.error(`[LiquidWallet] Erro ao obter status da transação: ${error.message}`);
            return { confirmed: false, blockHeight: null, blockTime: null, error: error.message };
        }
    }

    /**
     * Verifica se um endereço pertence à nossa carteira
     * @param {string} address - Endereço a verificar
     * @returns {Promise<{belongs: boolean, index: number}>}
     */
    async checkAddressBelongsToWallet(address) {
        try {
            const { stdout } = await execFileAsync('python3', [LWK_SCRIPT_PATH, 'check_address', address]);
            const response = JSON.parse(stdout.trim());

            if (!response.success) {
                throw new Error(response.error || 'Erro ao verificar endereço');
            }

            return {
                belongs: response.found,
                index: response.index || null
            };
        } catch (error) {
            logger.error(`[LiquidWallet] Erro ao verificar endereço: ${error.message}`);
            return { belongs: false, index: null };
        }
    }

    /**
     * Deriva múltiplos endereços para pré-caching (opcional)
     * @param {number} start - Índice inicial
     * @param {number} end - Índice final
     * @returns {Promise<Array>} Lista de endereços
     */
    async deriveAddressRange(start, end) {
        try {
            const { stdout } = await execFileAsync('python3', [LWK_SCRIPT_PATH, 'derive_range', start.toString(), end.toString()]);
            const response = JSON.parse(stdout.trim());

            if (!response.success) {
                throw new Error(response.error || 'Erro ao derivar endereços');
            }

            return response.addresses;
        } catch (error) {
            logger.error(`[LiquidWallet] Erro ao derivar range de endereços: ${error.message}`);
            throw error;
        }
    }
}

module.exports = LiquidWalletService;
