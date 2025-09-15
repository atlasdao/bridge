const logger = require('../core/logger');

/**
 * Sanitiza dados sensíveis antes de fazer log
 */
class LogSanitizer {
    /**
     * Mascara CPF (mostra apenas primeiros 3 e últimos 2 dígitos)
     * @param {string} cpf - CPF completo
     * @returns {string} CPF mascarado
     */
    static maskCPF(cpf) {
        if (!cpf || cpf.length < 11) return '***';
        const cleaned = cpf.replace(/\D/g, '');
        return `${cleaned.substring(0, 3)}.***.***-${cleaned.substring(9, 11)}`;
    }

    /**
     * Mascara CNPJ (mostra apenas primeiros 2 e últimos 2 dígitos)
     * @param {string} cnpj - CNPJ completo
     * @returns {string} CNPJ mascarado
     */
    static maskCNPJ(cnpj) {
        if (!cnpj || cnpj.length < 14) return '***';
        const cleaned = cnpj.replace(/\D/g, '');
        return `${cleaned.substring(0, 2)}.****.****/****-${cleaned.substring(12, 14)}`;
    }

    /**
     * Mascara CPF ou CNPJ automaticamente
     * @param {string} document - Documento completo
     * @returns {string} Documento mascarado
     */
    static maskDocument(document) {
        if (!document) return '***';
        const cleaned = document.replace(/\D/g, '');
        if (cleaned.length === 11) {
            return this.maskCPF(document);
        } else if (cleaned.length === 14) {
            return this.maskCNPJ(document);
        }
        return '***';
    }

    /**
     * Mascara token JWT (mostra apenas primeiros 10 caracteres)
     * @param {string} token - Token JWT completo
     * @returns {string} Token mascarado
     */
    static maskToken(token) {
        if (!token || token.length < 20) return '***';
        return `${token.substring(0, 10)}...`;
    }

    /**
     * Remove campos sensíveis de objetos
     * @param {Object} obj - Objeto com dados
     * @param {Array} sensitiveFields - Lista de campos sensíveis
     * @returns {Object} Objeto sanitizado
     */
    static sanitizeObject(obj, sensitiveFields = []) {
        const defaultSensitiveFields = [
            'password', 'senha', 'token', 'jwt', 'authorization',
            'cpf', 'cnpj', 'cpf_cnpj', 'payer_cpf_cnpj',
            'api_key', 'apiKey', 'secret', 'private_key'
        ];

        const fieldsToSanitize = [...defaultSensitiveFields, ...sensitiveFields];
        const sanitized = { ...obj };

        for (const key in sanitized) {
            const lowerKey = key.toLowerCase();

            // Se o campo é sensível, mascara
            if (fieldsToSanitize.some(field => lowerKey.includes(field.toLowerCase()))) {
                if (typeof sanitized[key] === 'string') {
                    if (lowerKey.includes('cpf') || lowerKey.includes('cnpj')) {
                        sanitized[key] = this.maskDocument(sanitized[key]);
                    } else if (lowerKey.includes('token') || lowerKey.includes('jwt')) {
                        sanitized[key] = this.maskToken(sanitized[key]);
                    } else {
                        sanitized[key] = '***REDACTED***';
                    }
                }
            }

            // Recursão para objetos aninhados
            if (sanitized[key] && typeof sanitized[key] === 'object') {
                sanitized[key] = this.sanitizeObject(sanitized[key], sensitiveFields);
            }
        }

        return sanitized;
    }

    /**
     * Cria um logger seguro que automaticamente sanitiza dados
     */
    static createSecureLogger() {
        return {
            info: (message, data) => {
                const sanitizedData = data ? this.sanitizeObject(data) : undefined;
                logger.info(message, sanitizedData);
            },
            error: (message, error) => {
                const sanitizedError = error ? {
                    message: error.message,
                    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
                } : undefined;
                logger.error(message, sanitizedError);
            },
            warn: (message, data) => {
                const sanitizedData = data ? this.sanitizeObject(data) : undefined;
                logger.warn(message, sanitizedData);
            },
            debug: (message, data) => {
                if (process.env.NODE_ENV === 'development') {
                    const sanitizedData = data ? this.sanitizeObject(data) : undefined;
                    logger.debug(message, sanitizedData);
                }
            }
        };
    }
}

module.exports = LogSanitizer;