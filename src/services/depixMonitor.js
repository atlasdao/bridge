const logger = require('../core/logger');
const depixApiService = require('./depixApiService');

class DepixMonitor {
    constructor() {
        this.intervalId = null;
        this.PING_INTERVAL = 65000; // 65 segundos para evitar rate limit de 60s
        this.dbPool = null; // Will be set via setDbPool method
    }

    setDbPool(dbPool) {
        this.dbPool = dbPool;
    }

    async updateStatus(isOnline, errorMessage = null, responseTime = null) {
        try {
            const query = `
                UPDATE depix_status
                SET is_online = $1,
                    last_ping_at = NOW(),
                    last_online_at = CASE WHEN $1 = true THEN NOW() ELSE last_online_at END,
                    error_message = $2,
                    response_time_ms = $3,
                    updated_at = NOW()
                WHERE id = 1
            `;
            await this.dbPool.query(query, [isOnline, errorMessage, responseTime]);
            logger.info(`DePix status updated: ${isOnline ? 'ONLINE' : 'OFFLINE'}${errorMessage ? ` - ${errorMessage}` : ''}`);
        } catch (error) {
            logger.error('Error updating DePix status in database:', error);
        }
    }

    async checkStatus() {
        try {
            // Verificar último ping antes de fazer um novo
            const lastPingResult = await this.dbPool.query(
                'SELECT last_ping_at FROM depix_status WHERE id = 1'
            );

            if (lastPingResult.rows.length > 0) {
                const lastPing = lastPingResult.rows[0].last_ping_at;
                const timeSinceLastPing = Date.now() - new Date(lastPing).getTime();

                // Se o último ping foi há menos de 60 segundos, pular
                if (timeSinceLastPing < 60000) {
                    logger.info(`Skipping DePix ping, last ping was ${Math.floor(timeSinceLastPing/1000)}s ago`);
                    return;
                }
            }

            const startTime = Date.now();
            const result = await depixApiService.ping();
            const responseTime = Date.now() - startTime;

            if (result.success) {
                await this.updateStatus(true, null, responseTime);
                return true;
            } else {
                await this.updateStatus(false, result.error || 'Ping failed', responseTime);
                return false;
            }
        } catch (error) {
            logger.error(`DePix monitor error: ${error.message}`);
            await this.updateStatus(false, error.message, null);
            return false;
        }
    }

    async getStatus() {
        try {
            const result = await this.dbPool.query('SELECT is_online, last_ping_at, error_message FROM depix_status WHERE id = 1');
            if (result.rows.length > 0) {
                const status = result.rows[0];
                // Se o último ping foi há mais de 3 minutos, considerar offline
                const lastPing = new Date(status.last_ping_at);
                const now = new Date();
                const diffMinutes = (now - lastPing) / 1000 / 60;

                if (diffMinutes > 3) {
                    logger.warn('DePix status check is stale (>3 minutes old), considering offline');
                    return false;
                }

                return status.is_online;
            }
            return false;
        } catch (error) {
            logger.error('Error checking DePix status from database:', error);
            return false;
        }
    }

    start() {
        if (this.intervalId) {
            logger.warn('DePix monitor already running');
            return;
        }

        logger.info('Starting DePix status monitor...');

        // Verificar se precisa fazer ping inicial
        this.dbPool.query('SELECT last_ping_at FROM depix_status WHERE id = 1')
            .then(result => {
                if (result.rows.length > 0) {
                    const lastPing = result.rows[0].last_ping_at;
                    const timeSinceLastPing = Date.now() - new Date(lastPing).getTime();

                    // Só fazer ping inicial se o último foi há mais de 60 segundos
                    if (timeSinceLastPing > 60000) {
                        this.checkStatus();
                    } else {
                        logger.info(`Skipping initial ping, last ping was ${Math.floor(timeSinceLastPing/1000)}s ago`);
                    }
                } else {
                    // Primeira vez, fazer ping
                    this.checkStatus();
                }
            })
            .catch(error => {
                logger.error('Error checking last ping time:', error);
                // Em caso de erro, fazer ping mesmo assim
                this.checkStatus();
            });

        // Configurar intervalo
        this.intervalId = setInterval(() => {
            this.checkStatus();
        }, this.PING_INTERVAL);

        logger.info(`DePix monitor started with ${this.PING_INTERVAL / 1000}s interval`);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.info('DePix monitor stopped');
        }
    }
}

// Singleton
const depixMonitor = new DepixMonitor();

module.exports = depixMonitor;