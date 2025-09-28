const logger = require('../core/logger');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class SystemManagementService {
    constructor(dbPool, redisClient, bot) {
        this.dbPool = dbPool;
        this.redisClient = redisClient;
        this.redis = redisClient; // Alias for compatibility
        this.bot = bot;
        this.maintenanceMode = false;
        this.configCache = new Map();
        this.cacheExpiry = new Map();

        // Initialize config table and load state
        this.initializeConfigTable();
        this.loadInitialState();
    }

    /**
     * Initialize system_config table if it doesn't exist
     */
    async initializeConfigTable() {
        try {
            await this.dbPool.query(`
                CREATE TABLE IF NOT EXISTS system_config (
                    id SERIAL PRIMARY KEY,
                    key VARCHAR(255) UNIQUE NOT NULL,
                    value TEXT,
                    message TEXT,
                    type VARCHAR(50) DEFAULT 'string',
                    metadata JSONB DEFAULT '{}',
                    active BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // Create index
            await this.dbPool.query(`
                CREATE INDEX IF NOT EXISTS idx_system_config_key
                ON system_config (key)
            `);

            logger.info('[SystemManagement] Config table initialized');
        } catch (error) {
            logger.error(`[SystemManagement] Error initializing config table: ${error.message}`);
        }
    }

    /**
     * Load initial state from Redis/DB
     */
    async loadInitialState() {
        try {
            // Check maintenance mode from Redis first
            if (this.redis) {
                const maintenanceStatus = await this.redis.get('maintenance_mode');
                this.maintenanceMode = maintenanceStatus === '1' || maintenanceStatus === 'true';

                if (this.maintenanceMode) {
                    logger.warn('[SystemManagement] MAINTENANCE MODE IS ACTIVE ON STARTUP');
                }
            }

            // Load configs from database
            try {
                const configs = await this.dbPool.query('SELECT * FROM system_config WHERE active = true');
                configs.rows.forEach(config => {
                    this.configCache.set(config.key, {
                        value: config.value,
                        message: config.message,
                        metadata: config.metadata
                    });
                });

                logger.info(`[SystemManagement] Loaded ${configs.rows.length} configs from database`);
            } catch (dbError) {
                // Table might not exist yet
                logger.warn(`[SystemManagement] Could not load configs from database: ${dbError.message}`);
            }
        } catch (error) {
            logger.error(`[SystemManagement] Error loading initial state: ${error.message}`);
        }
    }

    /**
     * Obtém status completo do sistema
     */
    async getSystemStatus() {
        const status = {
            timestamp: new Date(),
            app: await this.getAppStatus(),
            database: await this.getDatabaseStatus(),
            redis: await this.getRedisStatus(),
            telegram: await this.getTelegramStatus(),
            server: await this.getServerStatus(),
            apis: await this.getApisStatus()
        };

        status.health = this.calculateOverallHealth(status);
        return status;
    }

    /**
     * Status da aplicação
     */
    async getAppStatus() {
        try {
            const uptime = process.uptime();
            const memoryUsage = process.memoryUsage();

            return {
                status: 'online',
                uptime: {
                    seconds: Math.floor(uptime),
                    formatted: this.formatUptime(uptime)
                },
                memory: {
                    rss: Math.round(memoryUsage.rss / 1024 / 1024),
                    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                    external: Math.round(memoryUsage.external / 1024 / 1024)
                },
                pid: process.pid,
                version: process.version,
                env: process.env.NODE_ENV || 'development',
                maintenanceMode: this.maintenanceMode
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter status da app: ${error.message}`);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Status do banco de dados
     */
    async getDatabaseStatus() {
        try {
            const startTime = Date.now();

            // Teste de conexão
            await this.dbPool.query('SELECT 1');
            const latency = Date.now() - startTime;

            // Estatísticas do pool
            const poolStats = {
                totalCount: this.dbPool?.totalCount || 0,
                idleCount: this.dbPool?.idleCount || 0,
                waitingCount: this.dbPool?.waitingCount || 0
            };

            // Estatísticas do banco
            const sizeResult = await this.dbPool.query(`
                SELECT pg_database_size(current_database()) as size
            `);

            const connectionsResult = await this.dbPool.query(`
                SELECT count(*) as connections
                FROM pg_stat_activity
                WHERE datname = current_database()
            `);

            const statsResult = await this.dbPool.query(`
                SELECT
                    sum(n_tup_ins) as inserts,
                    sum(n_tup_upd) as updates,
                    sum(n_tup_del) as deletes,
                    sum(seq_tup_read) as fetched
                FROM pg_stat_user_tables
            `);

            return {
                status: 'online',
                latency: `${latency}ms`,
                pool: poolStats,
                size: Math.round(sizeResult.rows[0].size / 1024 / 1024),
                connections: parseInt(connectionsResult.rows[0].connections),
                operations: statsResult.rows[0]
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter status do DB: ${error.message}`);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Status do Redis
     */
    async getRedisStatus() {
        try {
            const startTime = Date.now();
            await this.redisClient.ping();
            const latency = Date.now() - startTime;

            const info = await this.redisClient.info();
            const dbSize = await this.redisClient.dbsize();

            // Parser info do Redis
            const infoLines = info.split('\r\n');
            const infoObj = {};
            infoLines.forEach(line => {
                if (line && !line.startsWith('#')) {
                    const [key, value] = line.split(':');
                    if (key && value) {
                        infoObj[key] = value;
                    }
                }
            });

            return {
                status: 'online',
                latency: `${latency}ms`,
                version: infoObj.redis_version,
                keys: dbSize,
                memory: {
                    used: Math.round(parseInt(infoObj.used_memory) / 1024 / 1024),
                    peak: Math.round(parseInt(infoObj.used_memory_peak) / 1024 / 1024)
                },
                clients: parseInt(infoObj.connected_clients),
                uptime: parseInt(infoObj.uptime_in_seconds)
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter status do Redis: ${error.message}`);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Status do Telegram Bot
     */
    async getTelegramStatus() {
        try {
            const startTime = Date.now();
            const me = await this.bot.telegram.getMe();
            const latency = Date.now() - startTime;

            const webhookInfo = await this.bot.telegram.getWebhookInfo();

            return {
                status: 'online',
                latency: `${latency}ms`,
                bot: {
                    id: me.id,
                    username: me.username,
                    firstName: me.first_name
                },
                webhook: {
                    url: webhookInfo.url || 'Not set',
                    hasCustomCertificate: webhookInfo.has_custom_certificate,
                    pendingUpdateCount: webhookInfo.pending_update_count,
                    lastErrorDate: webhookInfo.last_error_date,
                    lastErrorMessage: webhookInfo.last_error_message
                }
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter status do Telegram: ${error.message}`);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Status do servidor
     */
    async getServerStatus() {
        try {
            const cpus = os.cpus();
            const totalMemory = os.totalmem();
            const freeMemory = os.freemem();
            const usedMemory = totalMemory - freeMemory;

            // Calcular média de CPU
            let totalIdle = 0;
            let totalTick = 0;

            cpus.forEach(cpu => {
                for (const type in cpu.times) {
                    totalTick += cpu.times[type];
                }
                totalIdle += cpu.times.idle;
            });

            const avgCpuUsage = 100 - Math.floor(totalIdle / totalTick * 100);

            return {
                status: 'online',
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                cpus: cpus.length,
                cpuUsage: `${avgCpuUsage}%`,
                memory: {
                    total: Math.round(totalMemory / 1024 / 1024 / 1024 * 10) / 10,
                    used: Math.round(usedMemory / 1024 / 1024 / 1024 * 10) / 10,
                    free: Math.round(freeMemory / 1024 / 1024 / 1024 * 10) / 10,
                    percentage: Math.round(usedMemory / totalMemory * 100)
                },
                loadAvg: os.loadavg().map(l => Math.round(l * 100) / 100),
                uptime: this.formatUptime(os.uptime())
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter status do servidor: ${error.message}`);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Status das APIs externas
     */
    async getApisStatus() {
        const apis = {
            depix: await this.checkDepixApi(),
            telegram: { status: 'online' } // Já verificado acima
        };

        return apis;
    }

    /**
     * Verifica API do DePix
     */
    async checkDepixApi() {
        try {
            const axios = require('axios');
            const config = require('../core/config');

            const startTime = Date.now();
            const response = await axios.get(
                `${config.depix.apiBaseUrl}/health`,
                {
                    timeout: 5000,
                    validateStatus: () => true
                }
            );
            const latency = Date.now() - startTime;

            return {
                status: response.status === 200 ? 'online' : 'degraded',
                latency: `${latency}ms`,
                statusCode: response.status
            };
        } catch (error) {
            return {
                status: 'offline',
                error: error.message
            };
        }
    }

    /**
     * Calcula saúde geral do sistema
     */
    calculateOverallHealth(status) {
        const components = [
            status.app?.status,
            status.database?.status,
            status.redis?.status,
            status.telegram?.status,
            status.server?.status
        ];

        const onlineCount = components.filter(s => s === 'online').length;
        const errorCount = components.filter(s => s === 'error').length;

        if (errorCount > 0) return 'critical';
        if (onlineCount === components.length) return 'healthy';
        return 'degraded';
    }

    /**
     * Limpa cache do Redis
     */
    async clearCache(pattern = '*') {
        try {
            const keys = await this.redisClient.keys(pattern);
            if (keys.length > 0) {
                await this.redisClient.del(...keys);
            }
            logger.info(`[SystemManagement] ${keys.length} chaves removidas do cache`);
            return keys.length;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao limpar cache: ${error.message}`);
            throw error;
        }
    }

    /**
     * Ativa/desativa modo de manutenção
     */
    async setMaintenanceMode(enabled, message = null) {
        this.maintenanceMode = enabled;

        if (enabled) {
            await this.redisClient.set('maintenance_mode', JSON.stringify({
                enabled: true,
                message: message || 'Sistema em manutenção. Voltaremos em breve.',
                enabledAt: new Date()
            }));
        } else {
            await this.redisClient.del('maintenance_mode');
        }

        logger.info(`[SystemManagement] Modo manutenção ${enabled ? 'ativado' : 'desativado'}`);
        return this.maintenanceMode;
    }

    /**
     * Obtém logs recentes
     */
    async getRecentLogs(lines = 100, level = null) {
        try {
            // First try to get logs from the audit log table
            let query = `
                SELECT
                    created_at as timestamp,
                    action_type,
                    action_description as message,
                    admin_username,
                    CASE
                        WHEN action_type LIKE 'error%' THEN 'error'
                        WHEN action_type LIKE 'warning%' THEN 'warn'
                        ELSE 'info'
                    END as level
                FROM admin_audit_log
            `;

            const params = [];
            if (level) {
                query += ` WHERE action_type LIKE $1`;
                params.push(`${level}%`);
            }

            query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
            params.push(lines);

            const result = await this.dbPool.query(query, params);

            // Format logs for display
            return result.rows.map(row => ({
                timestamp: new Date(row.timestamp).toISOString().replace('T', ' ').slice(0, 19),
                level: row.level,
                message: `[${row.action_type}] ${row.message}${row.admin_username ? ` (por @${row.admin_username})` : ''}`
            }));

        } catch (error) {
            logger.error(`[SystemManagement] Erro ao buscar logs: ${error.message}`);

            // Return some default logs if database query fails
            return [
                {
                    timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
                    level: 'info',
                    message: 'Sistema operacional'
                }
            ];
        }
    }

    /**
     * Obtém métricas de performance
     */
    async getPerformanceMetrics() {
        const metrics = {
            requests: await this.getRequestMetrics(),
            broadcasts: await this.getBroadcastMetrics(),
            transactions: await this.getTransactionMetrics(),
            errors: await this.getErrorMetrics()
        };

        return metrics;
    }

    /**
     * Métricas de requisições
     */
    async getRequestMetrics() {
        // Buscar do Redis se houver contador
        const total = await this.redisClient.get('metrics:requests:total') || 0;
        const today = await this.redisClient.get('metrics:requests:today') || 0;

        return {
            total: parseInt(total),
            today: parseInt(today)
        };
    }

    /**
     * Métricas de broadcasts
     */
    async getBroadcastMetrics() {
        const result = await this.dbPool.query(`
            SELECT
                COUNT(*) as total,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as today,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as week
            FROM admin_audit_log
            WHERE action_type IN ('broadcast_sent', 'broadcast_scheduled')
        `);

        return result.rows[0];
    }

    /**
     * Métricas de transações
     */
    async getTransactionMetrics() {
        const result = await this.dbPool.query(`
            SELECT
                COUNT(*) as total,
                COUNT(CASE WHEN payment_status = 'CONFIRMED' THEN 1 END) as confirmed,
                COUNT(CASE WHEN payment_status = 'PENDING' THEN 1 END) as pending,
                COUNT(CASE WHEN payment_status = 'EXPIRED' THEN 1 END) as expired,
                SUM(requested_brl_amount) as total_volume,
                AVG(requested_brl_amount) as avg_amount
            FROM pix_transactions
            WHERE created_at > NOW() - INTERVAL '30 days'
        `);

        return result.rows[0];
    }

    /**
     * Métricas de erros
     */
    async getErrorMetrics() {
        const errors24h = await this.redisClient.get('metrics:errors:24h') || 0;
        const errors7d = await this.redisClient.get('metrics:errors:7d') || 0;

        return {
            last24Hours: parseInt(errors24h),
            last7Days: parseInt(errors7d)
        };
    }

    /**
     * Cria backup do banco de dados
     */
    async createBackup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupDir = path.join(process.cwd(), 'backups');
            const backupPath = path.join(backupDir, `backup-${timestamp}.sql`);

            // Criar diretório se não existir
            await fs.mkdir(backupDir, { recursive: true });

            // Extrair informações de conexão do DATABASE_URL
            const { DATABASE_URL } = process.env;
            let command;

            if (DATABASE_URL.startsWith('postgresql://')) {
                // Parse DATABASE_URL
                const url = new URL(DATABASE_URL);
                const host = url.hostname;
                const port = url.port || 5432;
                const database = url.pathname.slice(1);
                const username = url.username;
                const password = url.password;

                // Construir comando pg_dump com parâmetros
                command = `PGPASSWORD="${password}" pg_dump -h ${host} -p ${port} -U ${username} -d ${database} -f ${backupPath}`;
            } else {
                // Usar DATABASE_URL diretamente
                command = `pg_dump "${DATABASE_URL}" -f ${backupPath}`;
            }

            // Executar backup
            await execAsync(command);

            // Verificar se o arquivo foi criado
            const backupStats = await fs.stat(backupPath);
            if (backupStats.size === 0) {
                throw new Error('Backup criado mas está vazio');
            }

            // Comprimir backup
            await execAsync(`gzip -f ${backupPath}`);

            const compressedPath = `${backupPath}.gz`;
            const stats = await fs.stat(compressedPath);

            // Salvar informações do backup no Redis
            await this.redisClient.set('backup:last:info', JSON.stringify({
                path: compressedPath,
                size: Math.round(stats.size / 1024 / 1024),
                timestamp: timestamp,
                status: 'Sucesso',
                createdAt: new Date().toISOString()
            }));

            // Limpar backups antigos (manter últimos 30)
            await this.cleanOldBackups(30);

            logger.info(`[SystemManagement] Backup criado: ${compressedPath} (${Math.round(stats.size / 1024 / 1024)}MB)`);

            return {
                path: compressedPath,
                size: stats.size,
                timestamp
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao criar backup: ${error.message}`);

            // Salvar erro no Redis
            await this.redisClient.set('backup:last:info', JSON.stringify({
                status: 'Erro',
                error: error.message,
                timestamp: new Date().toISOString()
            }));

            throw error;
        }
    }

    /**
     * Lista backups disponíveis
     */
    async listBackups() {
        try {
            const backupDir = path.join(process.cwd(), 'backups');

            // Criar diretório se não existir
            await fs.mkdir(backupDir, { recursive: true });

            const files = await fs.readdir(backupDir);
            const backups = [];

            for (const file of files) {
                if (file.endsWith('.gz') || file.endsWith('.sql')) {
                    const filePath = path.join(backupDir, file);
                    const stats = await fs.stat(filePath);
                    backups.push({
                        name: file,
                        path: filePath,
                        size: Math.round(stats.size / 1024 / 1024),
                        sizeBytes: stats.size,
                        created: stats.mtime,
                        age: Math.floor((Date.now() - stats.mtime) / (1000 * 60 * 60 * 24)) // dias
                    });
                }
            }

            return backups.sort((a, b) => b.created - a.created);
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao listar backups: ${error.message}`);
            return [];
        }
    }

    /**
     * Limpa backups antigos
     */
    async cleanOldBackups(keepCount = 30) {
        try {
            const backups = await this.listBackups();

            if (backups.length <= keepCount) {
                return 0; // Nada para limpar
            }

            const toDelete = backups.slice(keepCount);
            let deleted = 0;

            for (const backup of toDelete) {
                try {
                    await fs.unlink(backup.path);
                    deleted++;
                    logger.info(`[SystemManagement] Backup antigo removido: ${backup.name}`);
                } catch (error) {
                    logger.error(`[SystemManagement] Erro ao remover backup ${backup.name}: ${error.message}`);
                }
            }

            return deleted;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao limpar backups antigos: ${error.message}`);
            return 0;
        }
    }

    /**
     * Restaura backup
     */
    async restoreBackup(backupName) {
        try {
            const backupPath = path.join(process.cwd(), 'backups', backupName);

            // Verificar se o backup existe
            await fs.stat(backupPath);

            let sqlPath = backupPath;

            // Descomprimir se necessário
            if (backupPath.endsWith('.gz')) {
                sqlPath = backupPath.replace('.gz', '');
                await execAsync(`gunzip -c ${backupPath} > ${sqlPath}`);
            }

            // Extrair informações de conexão
            const { DATABASE_URL } = process.env;
            let command;

            if (DATABASE_URL.startsWith('postgresql://')) {
                const url = new URL(DATABASE_URL);
                const host = url.hostname;
                const port = url.port || 5432;
                const database = url.pathname.slice(1);
                const username = url.username;
                const password = url.password;

                command = `PGPASSWORD="${password}" psql -h ${host} -p ${port} -U ${username} -d ${database} -f ${sqlPath}`;
            } else {
                command = `psql "${DATABASE_URL}" -f ${sqlPath}`;
            }

            // Executar restauração
            await execAsync(command);

            // Limpar arquivo temporário se foi descomprimido
            if (backupPath.endsWith('.gz')) {
                await fs.unlink(sqlPath);
            }

            logger.info(`[SystemManagement] Backup restaurado: ${backupName}`);
            return true;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao restaurar backup: ${error.message}`);
            throw error;
        }
    }

    /**
     * Otimiza banco de dados
     */
    async optimizeDatabase() {
        try {
            // Executar VACUUM e ANALYZE em todas as tabelas principais
            const tables = [
                'users',
                'pix_transactions',
                'admin_audit_log',
                'broadcast_history'
            ];

            for (const table of tables) {
                logger.info(`[SystemManagement] Otimizando tabela ${table}...`);
                await this.dbPool.query(`VACUUM ANALYZE ${table}`);
            }

            // Reindexar tabelas principais
            for (const table of tables) {
                logger.info(`[SystemManagement] Reindexando tabela ${table}...`);
                await this.dbPool.query(`REINDEX TABLE ${table}`);
            }

            // Limpar conexões idle
            await this.dbPool.query(`
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE datname = current_database()
                AND state = 'idle'
                AND state_change < NOW() - INTERVAL '10 minutes'
            `);

            logger.info(`[SystemManagement] Otimização do banco concluída`);
            return true;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao otimizar banco: ${error.message}`);
            throw error;
        }
    }

    /**
     * Limpa logs antigos
     */
    async cleanOldLogs(daysToKeep = 30) {
        try {
            // Limpar logs de auditoria antigos
            const result = await this.dbPool.query(`
                DELETE FROM admin_audit_log
                WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'
                RETURNING id
            `);

            const deletedCount = result.rowCount;

            // Limpar arquivos de log antigos
            const logDir = path.join(process.cwd(), 'logs');
            try {
                const files = await fs.readdir(logDir);
                const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

                for (const file of files) {
                    if (file.endsWith('.log')) {
                        const filePath = path.join(logDir, file);
                        const stats = await fs.stat(filePath);

                        if (stats.mtime < cutoffTime) {
                            await fs.unlink(filePath);
                            logger.info(`[SystemManagement] Log antigo removido: ${file}`);
                        }
                    }
                }
            } catch (fileError) {
                // Ignorar erro se diretório não existir
            }

            logger.info(`[SystemManagement] ${deletedCount} logs de auditoria removidos`);
            return deletedCount;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao limpar logs: ${error.message}`);
            throw error;
        }
    }

    /**
     * Obtém uso de disco
     */
    async getDiskUsage() {
        try {
            const { stdout } = await execAsync("df -k / | tail -1 | awk '{print $5}'");
            const usage = parseInt(stdout.replace('%', '').trim());
            return usage || 0;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter uso de disco: ${error.message}`);
            return 0;
        }
    }

    /**
     * Formata uptime
     */
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

        return parts.join(' ');
    }

    /**
     * Reinicia serviços
     */
    async restartService(service) {
        try {
            switch (service) {
                case 'redis':
                    // Limpar cache antes de reconectar
                    await this.redisClient.flushdb();
                    logger.info(`[SystemManagement] Cache do Redis limpo`);
                    break;

                case 'database':
                    // Forçar reconexão do pool
                    const oldPool = this.dbPool;
                    // Criar novo pool
                    const { Pool } = require('pg');
                    this.dbPool = new Pool({
                        connectionString: process.env.DATABASE_URL,
                        max: 20,
                        idleTimeoutMillis: 30000,
                        connectionTimeoutMillis: 2000
                    });
                    // Fechar pool antigo
                    await oldPool.end();
                    logger.info(`[SystemManagement] Pool de banco reconectado`);
                    break;

                case 'app':
                    // Tentar reiniciar via PM2 primeiro
                    try {
                        await execAsync('pm2 restart atlas-bridge');
                    } catch (pm2Error) {
                        // Se PM2 não estiver disponível, usar nodemon
                        try {
                            await execAsync('touch app.js'); // Trigger nodemon reload
                        } catch (nodemonError) {
                            // Como último recurso, agendar reinicialização
                            logger.info(`[SystemManagement] Agendando reinicialização da aplicação...`);
                            setTimeout(() => {
                                process.exit(0); // Supervisor reiniciará o processo
                            }, 1000);
                        }
                    }
                    break;

                case 'telegram':
                    // Reiniciar bot do Telegram
                    if (this.bot) {
                        await this.bot.telegram.deleteWebhook();
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        await this.bot.telegram.setWebhook(process.env.APP_BASE_URL + '/webhooks/telegram');
                        logger.info(`[SystemManagement] Webhook do Telegram reiniciado`);
                    }
                    break;

                default:
                    throw new Error(`Serviço desconhecido: ${service}`);
            }

            logger.info(`[SystemManagement] Serviço ${service} reiniciado com sucesso`);
            return true;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao reiniciar ${service}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Obtém métricas do sistema
     */
    async getSystemMetrics() {
        try {
            const cpuUsage = process.cpuUsage();
            const memoryUsage = process.memoryUsage();
            const os = require('os');

            // Métricas reais de requisições do Redis
            const requestsTotal = await this.redisClient.get('metrics:requests:total') || 0;
            const requestsToday = await this.redisClient.get('metrics:requests:today') || 0;
            const avgResponseTime = await this.redisClient.get('metrics:response_time:avg') || 0;

            // Métricas reais de erros
            const errors24h = await this.redisClient.get('metrics:errors:24h') || 0;
            const errorsTotal = await this.redisClient.get('metrics:errors:total') || 0;

            // Calcular taxa de erro real
            const errorRate = requestsTotal > 0 ? ((errorsTotal / requestsTotal) * 100).toFixed(2) : '0.00';

            // Métricas reais do banco
            const dbStats = await this.dbPool.query(`
                SELECT
                    COUNT(*) as total_transactions,
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as transactions_today
                FROM pix_transactions
            `);

            // Uso real de disco
            const diskUsage = await this.getDiskUsage();

            // Calcular uso real de CPU
            const cpus = os.cpus();
            let totalIdle = 0;
            let totalTick = 0;
            cpus.forEach(cpu => {
                for (const type in cpu.times) {
                    totalTick += cpu.times[type];
                }
                totalIdle += cpu.times.idle;
            });
            const cpuPercent = (100 - Math.floor(totalIdle / totalTick * 100)).toFixed(2);

            return {
                requests: parseInt(requestsTotal),
                requestsToday: parseInt(requestsToday),
                avgResponseTime: parseFloat(avgResponseTime) || 0,
                errorRate: errorRate,
                errors24h: parseInt(errors24h),
                uptime: this.formatUptime(process.uptime()),
                cpuUsage: cpuPercent,
                memoryUsage: ((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100).toFixed(2),
                diskUsage: diskUsage,
                networkConnections: os.networkInterfaces() ? Object.keys(os.networkInterfaces()).length : 0,
                totalTransactions: dbStats.rows[0].total_transactions,
                transactionsToday: dbStats.rows[0].transactions_today,
                systemUptime: this.formatUptime(os.uptime())
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter métricas: ${error.message}`);
            return {};
        }
    }

    /**
     * Obtém logs recentes do sistema
     */
    async getRecentLogs(limit = 50) {
        try {
            // Buscar logs reais do banco de dados de auditoria
            const result = await this.dbPool.query(`
                SELECT
                    created_at as timestamp,
                    CASE
                        WHEN action_type LIKE '%error%' THEN 'error'
                        WHEN action_type LIKE '%warning%' THEN 'warn'
                        ELSE 'info'
                    END as level,
                    CONCAT(action_type, ': ', action_description) as message,
                    admin_username
                FROM admin_audit_log
                ORDER BY created_at DESC
                LIMIT $1
            `, [limit]);

            // Se não houver logs de auditoria, buscar logs de sistema alternativos
            if (result.rows.length === 0) {
                // Tentar ler do arquivo de log se existir
                const fs = require('fs').promises;
                const path = require('path');
                const logPath = path.join(process.cwd(), 'logs', 'app.log');

                try {
                    const content = await fs.readFile(logPath, 'utf-8');
                    const lines = content.split('\n').filter(line => line.trim());
                    const recentLines = lines.slice(-limit);

                    return recentLines.map(line => {
                        const match = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[(\w+)\] (.+)/);
                        if (match) {
                            return {
                                timestamp: new Date(match[1]).toISOString(),
                                level: match[2].toLowerCase(),
                                message: match[3]
                            };
                        }
                        return {
                            timestamp: new Date().toISOString(),
                            level: 'info',
                            message: line
                        };
                    });
                } catch (fileError) {
                    // Se não conseguir ler arquivo, retornar logs básicos do sistema
                    return [{
                        timestamp: new Date().toISOString(),
                        level: 'info',
                        message: `Sistema operacional: Uptime ${this.formatUptime(os.uptime())}`
                    }];
                }
            }

            return result.rows.map(row => ({
                timestamp: row.timestamp,
                level: row.level,
                message: row.message,
                user: row.admin_username
            }));
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter logs: ${error.message}`);
            return [];
        }
    }

    /**
     * Obtém status de segurança
     */
    async getSecurityStatus() {
        try {
            // Buscar dados reais de segurança do Redis e banco
            const loginAttempts = await this.redisClient.get('security:login:attempts') || 0;
            const successfulLogins = await this.redisClient.get('security:login:successful') || 0;
            const failedLogins = await this.redisClient.get('security:login:failed') || 0;
            const blockedIps = await this.redisClient.smembers('security:blocked:ips');
            const rateLimitExceeded = await this.redisClient.get('security:ratelimit:exceeded') || 0;
            const invalidTokens = await this.redisClient.get('security:tokens:invalid') || 0;

            // Buscar tentativas suspeitas do banco
            const suspiciousResult = await this.dbPool.query(`
                SELECT COUNT(*) as count
                FROM users
                WHERE is_suspicious = true OR suspicious_activity_detected = true
            `);

            // Buscar usuários banidos
            const bannedResult = await this.dbPool.query(`
                SELECT COUNT(*) as count
                FROM users
                WHERE is_banned = true
            `);

            // Verificar configurações de segurança
            const config = require('../core/config');
            const isHttps = config.app.baseUrl && config.app.baseUrl.startsWith('https');
            const hasWebhookSecret = !!config.depix.webhookSecret;

            return {
                loginAttempts: parseInt(loginAttempts),
                successfulLogins: parseInt(successfulLogins),
                failedLogins: parseInt(failedLogins),
                blockedIps: blockedIps.length,
                blockedIpsList: blockedIps.slice(0, 10), // Primeiros 10 IPs
                bannedUsers: parseInt(bannedResult.rows[0].count),
                suspiciousUsers: parseInt(suspiciousResult.rows[0].count),
                rateLimitExceeded: parseInt(rateLimitExceeded),
                invalidTokens: parseInt(invalidTokens),
                // Configurações de segurança
                rateLimitingEnabled: true, // Sempre ativo via middleware
                inputValidationEnabled: true, // Sempre ativo
                httpsOnly: isHttps,
                webhookSecretConfigured: hasWebhookSecret,
                twoFactorEnabled: false, // Ainda não implementado
                maintenanceMode: this.maintenanceMode
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter status de segurança: ${error.message}`);
            return {
                error: error.message,
                loginAttempts: 0,
                successfulLogins: 0,
                failedLogins: 0,
                blockedIps: 0,
                bannedUsers: 0,
                suspiciousUsers: 0,
                rateLimitExceeded: 0,
                invalidTokens: 0,
                rateLimitingEnabled: true,
                inputValidationEnabled: true,
                httpsOnly: false,
                webhookSecretConfigured: false,
                twoFactorEnabled: false,
                maintenanceMode: false
            };
        }
    }

    /**
     * Obtém status de backups
     */
    async getBackupStatus() {
        try {
            // Listar backups reais do diretório
            const backups = await this.listBackups();

            // Buscar informações do último backup do Redis
            const lastBackupInfo = await this.redisClient.get('backup:last:info');
            let lastBackupData = null;
            if (lastBackupInfo) {
                try {
                    lastBackupData = JSON.parse(lastBackupInfo);
                } catch (e) {
                    // Ignorar erro de parse
                }
            }

            // Calcular estatísticas dos backups
            let totalSize = 0;
            let successfulBackups = 0;
            let lastBackup = null;

            if (backups.length > 0) {
                lastBackup = backups[0]; // Já ordenado por data
                totalSize = backups.reduce((sum, b) => sum + b.size, 0);
                successfulBackups = backups.length; // Todos listados são bem-sucedidos
            }

            // Configuração de retenção (padrão 30 dias)
            const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS) || 30;

            // Calcular próximo backup (diário à meia-noite)
            const now = new Date();
            const nextBackup = new Date(now);
            nextBackup.setDate(nextBackup.getDate() + 1);
            nextBackup.setHours(0, 0, 0, 0);

            return {
                lastBackup: lastBackup ? lastBackup.created.toLocaleDateString('pt-BR') : 'Nunca',
                lastBackupTime: lastBackup ? lastBackup.created.toLocaleTimeString('pt-BR') : '',
                lastBackupSize: lastBackup ? `${lastBackup.size} MB` : 'N/A',
                lastBackupFile: lastBackup ? lastBackup.name : 'N/A',
                lastBackupStatus: lastBackupData ? lastBackupData.status : (lastBackup ? 'Sucesso' : 'N/A'),
                nextBackup: nextBackup.toLocaleDateString('pt-BR'),
                nextBackupTime: '00:00',
                nextBackupType: 'Completo',
                totalBackups: backups.length,
                successfulBackups: successfulBackups,
                failedBackups: 0, // Pode ser rastreado via Redis
                totalSize: totalSize > 1024 ? `${(totalSize / 1024).toFixed(2)} GB` : `${totalSize} MB`,
                oldestBackup: backups.length > 0 ? backups[backups.length - 1].created.toLocaleDateString('pt-BR') : 'N/A',
                retentionDays: retentionDays,
                backupDirectory: path.join(process.cwd(), 'backups'),
                autoBackupEnabled: process.env.AUTO_BACKUP_ENABLED === 'true'
            };
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter status de backup: ${error.message}`);
            return {
                error: error.message,
                lastBackup: 'Erro',
                totalBackups: 0,
                successfulBackups: 0,
                totalSize: '0 MB'
            };
        }
    }

    /**
     * Obtém configurações do sistema
     */
    async getSystemConfig() {
        try {
            // Buscar configurações do Redis (cache)
            const cachedConfig = await this.redisClient.get('system:config');
            if (cachedConfig) {
                return JSON.parse(cachedConfig);
            }

            // Buscar do banco de dados
            const result = await this.dbPool.query(`
                SELECT key, value, type
                FROM system_config
                WHERE active = true
            `);

            const config = {
                maintenanceMode: this.maintenanceMode,
                transactionFee: 0,
                dailyLimit: 1000,
                transactionLimit: 500,
                expirationTime: 30,
                minConfirmations: 1,
                requireVerification: false,
                antiSpam: true,
                requireKYC: false,
                blockVPN: false,
                twoFactorAdmin: false,
                autoBackup: false
            };

            // Processar configurações do banco
            for (const row of result.rows) {
                const value = row.type === 'number' ? parseFloat(row.value) :
                             row.type === 'boolean' ? row.value === 'true' :
                             row.value;
                config[row.key] = value;
            }

            // Cachear por 5 minutos
            await this.redisClient.setex('system:config', 300, JSON.stringify(config));

            return config;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao obter configurações: ${error.message}`);

            // Retornar configurações padrão em caso de erro
            return {
                maintenanceMode: false,
                transactionFee: 0,
                dailyLimit: 1000,
                transactionLimit: 500,
                expirationTime: 30,
                minConfirmations: 1,
                requireVerification: false,
                antiSpam: true,
                requireKYC: false,
                blockVPN: false,
                twoFactorAdmin: false,
                autoBackup: false
            };
        }
    }

    /**
     * Atualiza configuração do sistema
     */
    async updateConfig(key, value) {
        try {
            // Verificar se a configuração existe
            const existing = await this.dbPool.query(
                'SELECT id FROM system_config WHERE key = $1',
                [key]
            );

            const type = typeof value === 'number' ? 'number' :
                        typeof value === 'boolean' ? 'boolean' : 'string';

            if (existing.rows.length > 0) {
                // Atualizar configuração existente
                await this.dbPool.query(`
                    UPDATE system_config
                    SET value = $1, type = $2, updated_at = NOW()
                    WHERE key = $3
                `, [String(value), type, key]);
            } else {
                // Criar nova configuração
                await this.dbPool.query(`
                    INSERT INTO system_config (key, value, type, active)
                    VALUES ($1, $2, $3, true)
                `, [key, String(value), type]);
            }

            // Limpar cache
            await this.redisClient.del('system:config');

            logger.info(`[SystemManagement] Configuração ${key} atualizada para ${value}`);
            return true;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao atualizar configuração: ${error.message}`);
            throw error;
        }
    }

    /**
     * Toggle uma configuração booleana
     */
    async toggleConfig(key) {
        try {
            const config = await this.getSystemConfig();
            const currentValue = config[key] || false;
            const newValue = !currentValue;

            await this.updateConfig(key, newValue);

            // Aplicar mudanças imediatas para configurações críticas
            if (key === 'maintenanceMode') {
                this.maintenanceMode = newValue;
            }

            return newValue;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao toggle configuração: ${error.message}`);
            throw error;
        }
    }

    /**
     * Recarrega configurações do sistema
     */
    async reloadConfig() {
        try {
            // Limpar cache
            await this.redisClient.del('system:config');

            // Recarregar configurações
            const config = await this.getSystemConfig();

            // Aplicar configurações críticas
            this.maintenanceMode = config.maintenanceMode;

            logger.info(`[SystemManagement] Configurações recarregadas`);
            return config;
        } catch (error) {
            logger.error(`[SystemManagement] Erro ao recarregar configurações: ${error.message}`);
            throw error;
        }
    }
}

module.exports = SystemManagementService;