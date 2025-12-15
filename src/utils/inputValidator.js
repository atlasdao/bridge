/**
 * Validação robusta de entrada de dados
 */
class InputValidator {
    /**
     * Valida e sanitiza valor monetário
     * @param {string|number} value - Valor a validar
     * @param {Object} options - Opções de validação
     * @returns {Object} { valid: boolean, value: number, error: string }
     */
    static validateMonetaryAmount(value, options = {}) {
        const {
            minValue = 0.01,
            maxValue = 100000,
            allowZero = false,
            maxDecimals = 2
        } = options;

        // Remove espaços e converte vírgula para ponto
        const cleaned = String(value).trim().replace(',', '.');

        // Verifica formato básico
        const monetaryRegex = /^\d+(\.\d{1,2})?$/;
        if (!monetaryRegex.test(cleaned)) {
            return {
                valid: false,
                value: null,
                error: 'Formato inválido. Use números com até 2 casas decimais.'
            };
        }

        const numericValue = parseFloat(cleaned);

        // Validações de range
        if (isNaN(numericValue)) {
            return { valid: false, value: null, error: 'Valor não é um número válido.' };
        }

        if (!allowZero && numericValue === 0) {
            return { valid: false, value: null, error: 'Valor não pode ser zero.' };
        }

        if (numericValue < minValue) {
            return {
                valid: false,
                value: null,
                error: `Valor mínimo é R$ ${minValue.toFixed(2)}`
            };
        }

        if (numericValue > maxValue) {
            return {
                valid: false,
                value: null,
                error: `Valor máximo é R$ ${maxValue.toFixed(2)}`
            };
        }

        // Verifica precisão decimal
        const decimalPlaces = (cleaned.split('.')[1] || '').length;
        if (decimalPlaces > maxDecimals) {
            return {
                valid: false,
                value: null,
                error: `Máximo de ${maxDecimals} casas decimais permitidas.`
            };
        }

        return {
            valid: true,
            value: parseFloat(numericValue.toFixed(maxDecimals)),
            error: null
        };
    }

    /**
     * Valida endereço Liquid Network
     * @param {string} address - Endereço a validar
     * @returns {Object} { valid: boolean, error: string }
     */
    static validateLiquidAddress(address) {
        if (!address || typeof address !== 'string') {
            return { valid: false, error: 'Endereço inválido' };
        }

        const trimmed = address.trim();

        // Validação de comprimento (Liquid pode ter endereços longos, especialmente confidenciais)
        if (trimmed.length < 34 || trimmed.length > 120) {
            return { valid: false, error: 'Comprimento de endereço inválido' };
        }

        // Validação de prefixo para Liquid Network
        const validPrefixes = [
            'VJL',  // Mainnet P2PKH
            'VT',   // Mainnet P2SH
            'ex1',  // Mainnet Bech32
            'lq1',  // Mainnet Bech32 (alternativo)
            'AzP',  // Testnet P2PKH
            'XMT',  // Testnet P2SH
            'tex1', // Testnet Bech32
            'tlq1'  // Testnet Bech32 (alternativo)
        ];

        const hasValidPrefix = validPrefixes.some(prefix => trimmed.startsWith(prefix));
        if (!hasValidPrefix) {
            return {
                valid: false,
                error: 'Endereço não parece ser da Liquid Network'
            };
        }

        // Validação de caracteres (Base58 ou Bech32)
        const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
        const bech32Regex = /^(ex1|lq1|tex1|tlq1)[023456789acdefghjklmnpqrstuvwxyz]+$/;

        const isBech32 = trimmed.startsWith('ex1') || trimmed.startsWith('lq1') ||
                        trimmed.startsWith('tex1') || trimmed.startsWith('tlq1');

        if (isBech32) {
            if (!bech32Regex.test(trimmed)) {
                return { valid: false, error: 'Endereço Bech32 contém caracteres inválidos' };
            }
        } else {
            if (!base58Regex.test(trimmed)) {
                return { valid: false, error: 'Endereço contém caracteres inválidos' };
            }
        }

        return { valid: true, error: null };
    }

    /**
     * Valida CPF
     * @param {string} cpf - CPF a validar
     * @returns {Object} { valid: boolean, formatted: string, error: string }
     */
    static validateCPF(cpf) {
        if (!cpf) return { valid: false, formatted: null, error: 'CPF é obrigatório' };

        // Remove caracteres não numéricos
        const cleaned = cpf.replace(/\D/g, '');

        if (cleaned.length !== 11) {
            return { valid: false, formatted: null, error: 'CPF deve ter 11 dígitos' };
        }

        // Verifica se todos os dígitos são iguais
        if (/^(\d)\1{10}$/.test(cleaned)) {
            return { valid: false, formatted: null, error: 'CPF inválido' };
        }

        // Validação dos dígitos verificadores
        let sum = 0;
        let remainder;

        for (let i = 1; i <= 9; i++) {
            sum += parseInt(cleaned.substring(i - 1, i)) * (11 - i);
        }

        remainder = (sum * 10) % 11;
        if (remainder === 10 || remainder === 11) remainder = 0;
        if (remainder !== parseInt(cleaned.substring(9, 10))) {
            return { valid: false, formatted: null, error: 'CPF inválido' };
        }

        sum = 0;
        for (let i = 1; i <= 10; i++) {
            sum += parseInt(cleaned.substring(i - 1, i)) * (12 - i);
        }

        remainder = (sum * 10) % 11;
        if (remainder === 10 || remainder === 11) remainder = 0;
        if (remainder !== parseInt(cleaned.substring(10, 11))) {
            return { valid: false, formatted: null, error: 'CPF inválido' };
        }

        // Formata CPF
        const formatted = cleaned.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

        return { valid: true, formatted, error: null };
    }

    /**
     * Valida CNPJ
     * @param {string} cnpj - CNPJ a validar
     * @returns {Object} { valid: boolean, formatted: string, error: string }
     */
    static validateCNPJ(cnpj) {
        if (!cnpj) return { valid: false, formatted: null, error: 'CNPJ é obrigatório' };

        // Remove caracteres não numéricos
        const cleaned = cnpj.replace(/\D/g, '');

        if (cleaned.length !== 14) {
            return { valid: false, formatted: null, error: 'CNPJ deve ter 14 dígitos' };
        }

        // Verifica se todos os dígitos são iguais
        if (/^(\d)\1{13}$/.test(cleaned)) {
            return { valid: false, formatted: null, error: 'CNPJ inválido' };
        }

        // Validação dos dígitos verificadores
        let length = cleaned.length - 2;
        let numbers = cleaned.substring(0, length);
        let digits = cleaned.substring(length);
        let sum = 0;
        let pos = length - 7;

        for (let i = length; i >= 1; i--) {
            sum += numbers.charAt(length - i) * pos--;
            if (pos < 2) pos = 9;
        }

        let result = sum % 11 < 2 ? 0 : 11 - sum % 11;
        if (result !== parseInt(digits.charAt(0))) {
            return { valid: false, formatted: null, error: 'CNPJ inválido' };
        }

        length = length + 1;
        numbers = cleaned.substring(0, length);
        sum = 0;
        pos = length - 7;

        for (let i = length; i >= 1; i--) {
            sum += numbers.charAt(length - i) * pos--;
            if (pos < 2) pos = 9;
        }

        result = sum % 11 < 2 ? 0 : 11 - sum % 11;
        if (result !== parseInt(digits.charAt(1))) {
            return { valid: false, formatted: null, error: 'CNPJ inválido' };
        }

        // Formata CNPJ
        const formatted = cleaned.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');

        return { valid: true, formatted, error: null };
    }

    /**
     * Sanitiza string para prevenir injeções
     * @param {string} input - String a sanitizar
     * @param {Object} options - Opções de sanitização
     * @returns {string} String sanitizada
     */
    static sanitizeString(input, options = {}) {
        const {
            maxLength = 1000,
            allowNumbers = true,
            allowSpecialChars = false,
            allowSpaces = true
        } = options;

        if (!input || typeof input !== 'string') return '';

        let sanitized = input.trim();

        // Limita comprimento
        if (sanitized.length > maxLength) {
            sanitized = sanitized.substring(0, maxLength);
        }

        // Remove caracteres de controle
        sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

        // Remove caracteres especiais se não permitidos
        if (!allowSpecialChars) {
            const pattern = allowNumbers
                ? (allowSpaces ? /[^a-zA-Z0-9\s]/g : /[^a-zA-Z0-9]/g)
                : (allowSpaces ? /[^a-zA-Z\s]/g : /[^a-zA-Z]/g);
            sanitized = sanitized.replace(pattern, '');
        }

        // Previne SQL injection básico
        sanitized = sanitized.replace(/['";\\]/g, '');

        // Remove múltiplos espaços
        if (allowSpaces) {
            sanitized = sanitized.replace(/\s+/g, ' ');
        }

        return sanitized;
    }

    /**
     * Valida comando do bot
     * @param {string} command - Comando a validar
     * @returns {boolean} True se válido
     */
    static isValidBotCommand(command) {
        const validCommands = [
            '/start', '/help', '/status', '/balance',
            '/deposit', '/withdraw', '/cancel', '/admin', '/saque'
        ];
        return validCommands.includes(command);
    }

    // ============================================
    // VALIDADORES DE CHAVE PIX
    // ============================================

    /**
     * Detecta o tipo de chave PIX automaticamente
     * @param {string} key - Chave PIX
     * @returns {string} Tipo: PHONE, EMAIL, CPF, CNPJ, RANDOM, AMBIGUOUS_CPF_PHONE
     */
    static detectPixKeyType(key) {
        if (!key || typeof key !== 'string') return 'RANDOM';

        const trimmed = key.trim();

        // Celular: começa com +55
        if (trimmed.startsWith('+55')) return 'PHONE';

        // Email: contém @
        if (trimmed.includes('@')) return 'EMAIL';

        // Limpar números para análise
        const numbersOnly = trimmed.replace(/\D/g, '');

        // CPF: 11 dígitos com pontuação (XXX.XXX.XXX-XX)
        if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(trimmed)) return 'CPF';

        // CNPJ: 14 dígitos (com ou sem pontuação)
        if (numbersOnly.length === 14) return 'CNPJ';

        // 11 dígitos sem formatação: pode ser CPF ou telefone - AMBÍGUO
        if (numbersOnly.length === 11 && /^\d{11}$/.test(trimmed)) {
            return 'AMBIGUOUS_CPF_PHONE';
        }

        // 10-11 dígitos que parecem telefone (começa com DDD válido)
        if (numbersOnly.length >= 10 && numbersOnly.length <= 11) {
            const ddd = parseInt(numbersOnly.substring(0, 2));
            // DDDs válidos no Brasil: 11-99
            if (ddd >= 11 && ddd <= 99) {
                return 'AMBIGUOUS_CPF_PHONE';
            }
        }

        // Chave aleatória PIX: UUID ou alfanumérico
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(trimmed)) return 'RANDOM';

        // Aleatória: outros formatos (alfanumérico com letras)
        if (/[a-zA-Z]/.test(trimmed)) return 'RANDOM';

        // Se chegou aqui e é só número mas não se encaixa em nada, é ambíguo
        if (/^\d+$/.test(trimmed) && numbersOnly.length >= 10 && numbersOnly.length <= 11) {
            return 'AMBIGUOUS_CPF_PHONE';
        }

        return 'RANDOM';
    }

    /**
     * Valida chave PIX de telefone
     * @param {string} phone - Telefone no formato +5511999999999
     * @returns {Object} { valid: boolean, type: string, normalized: string, error: string }
     */
    static validatePixPhone(phone) {
        if (!phone) {
            return { valid: false, type: 'PHONE', normalized: null, error: 'Telefone é obrigatório' };
        }

        // Remove espaços, parênteses e hífens
        const cleaned = phone.replace(/[\s\-\(\)]/g, '');

        // Formato esperado: +55XXXXXXXXXXX (13-14 caracteres)
        const phoneRegex = /^\+55\d{10,11}$/;

        if (!phoneRegex.test(cleaned)) {
            return {
                valid: false,
                type: 'PHONE',
                normalized: null,
                error: 'Telefone inválido. Use formato: +5511999999999'
            };
        }

        return { valid: true, type: 'PHONE', normalized: cleaned, error: null };
    }

    /**
     * Valida chave PIX de email
     * @param {string} email - Email
     * @returns {Object} { valid: boolean, type: string, normalized: string, error: string }
     */
    static validatePixEmail(email) {
        if (!email) {
            return { valid: false, type: 'EMAIL', normalized: null, error: 'Email é obrigatório' };
        }

        const cleaned = email.toLowerCase().trim();

        // Regex básico para email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(cleaned)) {
            return {
                valid: false,
                type: 'EMAIL',
                normalized: null,
                error: 'Email inválido'
            };
        }

        // PIX permite até 77 caracteres para email
        if (cleaned.length > 77) {
            return {
                valid: false,
                type: 'EMAIL',
                normalized: null,
                error: 'Email muito longo (máximo 77 caracteres)'
            };
        }

        return { valid: true, type: 'EMAIL', normalized: cleaned, error: null };
    }

    /**
     * Valida chave PIX aleatória (EVP)
     * @param {string} key - Chave aleatória
     * @returns {Object} { valid: boolean, type: string, normalized: string, error: string }
     */
    static validatePixRandom(key) {
        if (!key) {
            return { valid: false, type: 'RANDOM', normalized: null, error: 'Chave é obrigatória' };
        }

        const cleaned = key.trim();

        // Chave aleatória PIX: UUID formato XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
        // ou formato simples de 32 caracteres alfanuméricos
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const simpleRegex = /^[a-zA-Z0-9\-]{8,36}$/;

        if (!uuidRegex.test(cleaned) && !simpleRegex.test(cleaned)) {
            return {
                valid: false,
                type: 'RANDOM',
                normalized: null,
                error: 'Chave aleatória inválida. Use formato UUID ou alfanumérico (8-36 caracteres)'
            };
        }

        return { valid: true, type: 'RANDOM', normalized: cleaned, error: null };
    }

    /**
     * Valida chave PIX de CPF
     * @param {string} cpf - CPF com pontuação
     * @returns {Object} { valid: boolean, type: string, normalized: string, error: string }
     */
    static validatePixCPF(cpf) {
        const result = this.validateCPF(cpf);

        if (!result.valid) {
            return { valid: false, type: 'CPF', normalized: null, error: result.error };
        }

        return { valid: true, type: 'CPF', normalized: result.formatted, error: null };
    }

    /**
     * Valida chave PIX de CNPJ
     * @param {string} cnpj - CNPJ
     * @returns {Object} { valid: boolean, type: string, normalized: string, error: string }
     */
    static validatePixCNPJ(cnpj) {
        const result = this.validateCNPJ(cnpj);

        if (!result.valid) {
            return { valid: false, type: 'CNPJ', normalized: null, error: result.error };
        }

        return { valid: true, type: 'CNPJ', normalized: result.formatted, error: null };
    }

    /**
     * Valida chave PIX (detecta tipo automaticamente ou usa tipo fornecido)
     * @param {string} key - Chave PIX
     * @param {string} type - Tipo opcional (se não fornecido, detecta automaticamente)
     * @returns {Object} { valid: boolean, type: string, normalized: string, error: string }
     */
    static validatePixKey(key, type = null) {
        if (!key || typeof key !== 'string') {
            return { valid: false, type: null, normalized: null, error: 'Chave PIX é obrigatória' };
        }

        // Detectar tipo se não fornecido
        const detectedType = type || this.detectPixKeyType(key);

        switch (detectedType) {
            case 'PHONE':
                return this.validatePixPhone(key);
            case 'EMAIL':
                return this.validatePixEmail(key);
            case 'CPF':
                return this.validatePixCPF(key);
            case 'CNPJ':
                return this.validatePixCNPJ(key);
            case 'RANDOM':
            default:
                return this.validatePixRandom(key);
        }
    }

    /**
     * Retorna nome amigável do tipo de chave PIX
     * @param {string} type - Tipo da chave
     * @returns {string} Nome amigável
     */
    static getPixKeyTypeName(type) {
        const names = {
            'PHONE': 'Celular',
            'EMAIL': 'E-mail',
            'CPF': 'CPF',
            'CNPJ': 'CNPJ',
            'RANDOM': 'Aleatória'
        };
        return names[type] || 'Desconhecido';
    }
}

module.exports = InputValidator;