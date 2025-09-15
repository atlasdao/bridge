const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('../core/logger');

/**
 * Middleware de segurança para Express
 */
class SecurityMiddleware {
    /**
     * Força HTTPS em produção
     */
    static forceHTTPS(req, res, next) {
        if (process.env.NODE_ENV === 'production' &&
            req.header('x-forwarded-proto') !== 'https') {
            return res.redirect(`https://${req.header('host')}${req.url}`);
        }
        next();
    }

    /**
     * Configura headers de segurança com Helmet
     */
    static setupHelmet() {
        return helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'"],
                    imgSrc: ["'self'", "data:", "https:"],
                    connectSrc: ["'self'"],
                    fontSrc: ["'self'"],
                    objectSrc: ["'none'"],
                    mediaSrc: ["'self'"],
                    frameSrc: ["'none'"],
                },
            },
            hsts: {
                maxAge: 31536000,
                includeSubDomains: true,
                preload: true
            }
        });
    }

    /**
     * Rate limiting por endpoint
     */
    static createRateLimiter(options = {}) {
        const defaults = {
            windowMs: 15 * 60 * 1000, // 15 minutos
            max: 100, // limite de requests
            message: 'Muitas requisições, tente novamente mais tarde.',
            standardHeaders: true,
            legacyHeaders: false,
        };

        return rateLimit({ ...defaults, ...options });
    }

    /**
     * Rate limiters específicos para diferentes endpoints
     */
    static getRateLimiters() {
        return {
            // Limite geral da API
            general: this.createRateLimiter({
                windowMs: 15 * 60 * 1000,
                max: 100
            }),

            // Limite para webhooks (mais permissivo)
            webhook: this.createRateLimiter({
                windowMs: 1 * 60 * 1000,
                max: 60
            }),

            // Limite para comandos do bot (anti-spam)
            botCommand: this.createRateLimiter({
                windowMs: 1 * 60 * 1000,
                max: 10,
                skipSuccessfulRequests: false
            }),

            // Limite para transações financeiras (mais restritivo)
            transaction: this.createRateLimiter({
                windowMs: 5 * 60 * 1000,
                max: 5,
                message: 'Limite de transações excedido. Aguarde 5 minutos.'
            }),

            // Limite para login/autenticação
            auth: this.createRateLimiter({
                windowMs: 15 * 60 * 1000,
                max: 5,
                skipFailedRequests: false
            })
        };
    }


    /**
     * Middleware para detectar e prevenir ataques
     */
    static securityMonitor(req, res, next) {
        // Detecta possíveis SQL injection
        const suspiciousPatterns = [
            /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE)\b)/gi,
            /(--|#|\/\*|\*\/)/g,
            /(\bOR\b\s*\d+\s*=\s*\d+)/gi,
            /(\bAND\b\s*\d+\s*=\s*\d+)/gi
        ];

        const requestData = JSON.stringify({
            body: req.body,
            query: req.query,
            params: req.params
        });

        for (const pattern of suspiciousPatterns) {
            if (pattern.test(requestData)) {
                logger.warn('Suspicious request detected', {
                    url: req.url,
                    method: req.method
                });

                // Em produção, você pode querer bloquear
                if (process.env.NODE_ENV === 'production') {
                    return res.status(400).json({
                        error: 'Invalid request'
                    });
                }
            }
        }

        // Detecta tentativas de path traversal
        const pathTraversalPattern = /(\.\.(\/|\\))+/g;
        if (pathTraversalPattern.test(requestData)) {
            logger.warn('Path traversal attempt detected');
            return res.status(400).json({
                error: 'Invalid request'
            });
        }

        next();
    }

    /**
     * Sanitiza headers de requisição
     */
    static sanitizeHeaders(req, res, next) {
        // Remove headers potencialmente perigosos
        const dangerousHeaders = [
            'x-forwarded-host',
            'x-original-url',
            'x-rewrite-url'
        ];

        dangerousHeaders.forEach(header => {
            delete req.headers[header];
        });

        next();
    }

    /**
     * Timeout para prevenir ataques de slowloris
     */
    static requestTimeout(seconds = 30) {
        return (req, res, next) => {
            res.setTimeout(seconds * 1000, () => {
                logger.warn(`Request timeout for ${req.url}`);
                res.status(408).json({
                    error: 'Request timeout'
                });
            });
            next();
        };
    }
}

module.exports = SecurityMiddleware;