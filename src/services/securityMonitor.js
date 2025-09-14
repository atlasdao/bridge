const logger = require('../core/logger');
const EventEmitter = require('events');

/**
 * Monitor de segurança para detectar atividades suspeitas
 */
class SecurityMonitor extends EventEmitter {
    constructor(dbPool, redisClient) {
        super();
        this.dbPool = dbPool;
        this.redis = redisClient;
        this.suspiciousActivities = new Map();
    }

    /**
     * Registra tentativa de login/acesso
     */
    async logAccessAttempt(userId, success, metadata = {}) {
        const key = `access:${userId}`;
        const now = Date.now();

        try {
            // Armazena no Redis com TTL de 1 hora
            await this.redis.zadd(key, now, JSON.stringify({
                success,
                timestamp: now,
                ...metadata
            }));

            await this.redis.expire(key, 3600);

            // Verifica padrões suspeitos
            await this.checkSuspiciousPatterns(userId);

        } catch (error) {
            logger.error('Error logging access attempt:', error);
        }
    }

    /**
     * Detecta padrões suspeitos
     */
    async checkSuspiciousPatterns(identifier) {
        const key = `access:${identifier}`;
        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000);

        try {
            // Busca tentativas na última hora
            const attempts = await this.redis.zrangebyscore(
                key,
                oneHourAgo,
                now
            );

            const parsedAttempts = attempts.map(a => JSON.parse(a));
            const failedAttempts = parsedAttempts.filter(a => !a.success);

            // Regras de detecção
            const rules = {
                // Mais de 5 tentativas falhas em 1 hora
                tooManyFailures: failedAttempts.length > 5,

                // Mais de 10 tentativas totais em 5 minutos
                rateTooHigh: this.checkRateLimit(parsedAttempts, 5 * 60 * 1000, 10),


                // Tentativas em horário suspeito (3am - 5am)
                suspiciousTime: this.checkSuspiciousTime(parsedAttempts),

                // Padrão de força bruta (tentativas rápidas e consecutivas)
                bruteForcePattern: this.checkBruteForcePattern(parsedAttempts)
            };

            // Avalia nível de risco
            const riskScore = this.calculateRiskScore(rules);

            if (riskScore >= 70) {
                await this.handleHighRiskActivity(identifier, rules, riskScore);
            } else if (riskScore >= 40) {
                await this.handleMediumRiskActivity(identifier, rules, riskScore);
            }

        } catch (error) {
            logger.error('Error checking suspicious patterns:', error);
        }
    }

    /**
     * Verifica taxa de requisições
     */
    checkRateLimit(attempts, timeWindow, maxAttempts) {
        const now = Date.now();
        const windowStart = now - timeWindow;
        const recentAttempts = attempts.filter(a => a.timestamp > windowStart);
        return recentAttempts.length > maxAttempts;
    }


    /**
     * Verifica horário suspeito
     */
    checkSuspiciousTime(attempts) {
        return attempts.some(a => {
            const hour = new Date(a.timestamp).getHours();
            return hour >= 3 && hour <= 5;
        });
    }

    /**
     * Detecta padrão de força bruta
     */
    checkBruteForcePattern(attempts) {
        if (attempts.length < 3) return false;

        // Ordena por timestamp
        const sorted = attempts.sort((a, b) => a.timestamp - b.timestamp);

        // Verifica se há muitas tentativas em intervalo muito curto
        for (let i = 0; i < sorted.length - 2; i++) {
            const timeSpan = sorted[i + 2].timestamp - sorted[i].timestamp;
            if (timeSpan < 10000) { // 3 tentativas em menos de 10 segundos
                return true;
            }
        }

        return false;
    }

    /**
     * Calcula score de risco
     */
    calculateRiskScore(rules) {
        let score = 0;

        if (rules.tooManyFailures) score += 40;
        if (rules.rateTooHigh) score += 30;
        if (rules.suspiciousTime) score += 10;
        if (rules.bruteForcePattern) score += 50;

        return Math.min(score, 100);
    }

    /**
     * Trata atividade de alto risco
     */
    async handleHighRiskActivity(identifier, rules, riskScore) {
        logger.warn(`HIGH RISK ACTIVITY DETECTED`, {
            identifier,
            riskScore,
            rules
        });

        // Registra no banco
        await this.logSecurityEvent('high_risk', identifier, rules, riskScore);

        // Emite evento para notificação
        this.emit('highRiskDetected', {
            identifier,
            riskScore,
            rules
        });
    }

    /**
     * Trata atividade de médio risco
     */
    async handleMediumRiskActivity(identifier, rules, riskScore) {
        logger.info(`Medium risk activity detected`, {
            identifier,
            riskScore
        });

        // Registra no banco
        await this.logSecurityEvent('medium_risk', identifier, rules, riskScore);

        // Aumenta monitoramento
        await this.increaseMonitoring(identifier);
    }


    /**
     * Registra evento de segurança no banco
     */
    async logSecurityEvent(type, identifier, details, riskScore) {
        try {
            await this.dbPool.query(
                `INSERT INTO security_events
                (event_type, identifier, details, risk_score, created_at)
                VALUES ($1, $2, $3, $4, NOW())`,
                [type, identifier, JSON.stringify(details), riskScore]
            );
        } catch (error) {
            logger.error('Error logging security event:', error);
        }
    }

    /**
     * Aumenta nível de monitoramento
     */
    async increaseMonitoring(identifier) {
        const key = `monitoring:${identifier}`;
        await this.redis.setex(key, 3600, 'enhanced'); // 1 hora de monitoramento aumentado
    }

    /**
     * Gera relatório de segurança
     */
    async generateSecurityReport(startDate, endDate) {
        try {
            const result = await this.dbPool.query(
                `SELECT
                    event_type,
                    COUNT(*) as count,
                    AVG(risk_score) as avg_risk_score,
                    MAX(risk_score) as max_risk_score
                FROM security_events
                WHERE created_at BETWEEN $1 AND $2
                GROUP BY event_type
                ORDER BY count DESC`,
                [startDate, endDate]
            );

            return {
                period: { start: startDate, end: endDate },
                summary: result.rows,
                totalEvents: result.rows.reduce((sum, row) => sum + parseInt(row.count), 0)
            };

        } catch (error) {
            logger.error('Error generating security report:', error);
            return null;
        }
    }

    /**
     * Middleware para Express
     */
    middleware() {
        return async (req, res, next) => {
            // Registra acesso
            const userId = req.user?.id || null;
            if (userId) {
                await this.logAccessAttempt(userId, true, {
                    path: req.path,
                    method: req.method
                });
            }

            next();
        };
    }
}

module.exports = SecurityMonitor;