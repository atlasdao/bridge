const { Markup } = require('telegraf');
const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const BroadcastService = require('../services/broadcastService');
const AuditService = require('../services/auditService');
const UserManagementService = require('../services/userManagementService');
const SystemManagementService = require('../services/systemManagementService');
const WithdrawalService = require('../services/withdrawalService');
const BountyService = require('../services/bountyService');
const config = require('../core/config');

// IDs dos admins autorizados
const ADMIN_IDS = process.env.ADMIN_TELEGRAM_IDS ?
    process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => parseInt(id.trim())) :
    [];

logger.info(`[AdminCommands] Admin IDs configurados: ${ADMIN_IDS.join(', ')}`);

/**
 * Verifica se usuário é admin
 */
const isAdmin = (userId) => {
    const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
    return ADMIN_IDS.includes(userIdNum);
};

/**
 * Registra comandos administrativos completos
 */
const registerAdminCommands = (bot, dbPool, redisClient) => {
    // Inicializar serviços
    const broadcastService = new BroadcastService(bot, dbPool);
    const auditService = new AuditService(dbPool);
    const userManagementService = new UserManagementService(dbPool, auditService);
    const systemManagementService = new SystemManagementService(dbPool, redisClient, bot);
    const bountyService = new BountyService(dbPool, bot);

    // Estado das operações ativas
    const activeStates = new Map();

    // Middleware para verificar admin em callbacks
    const requireAdmin = async (ctx, next) => {
        if (!isAdmin(ctx.from.id)) {
            await ctx.answerCbQuery('⛔ Acesso negado');
            return;
        }
        return next();
    };

    // ========================================
    // COMANDO PRINCIPAL /admin
    // ========================================
    bot.command('admin', async (ctx) => {
        try {
            const userId = ctx.from.id;

            if (!isAdmin(userId)) {
                logger.info(`[Admin] Acesso negado para ${userId}`);
                return ctx.reply('⛔ Comando restrito a administradores.');
            }

            // Registrar ação de login
            await auditService.logAdminAction({
                adminId: userId,
                adminUsername: ctx.from.username,
                actionType: AuditService.ActionTypes.ADMIN_LOGIN,
                actionDescription: 'Admin acessou painel administrativo'
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📢 Broadcast', 'adm_broadcast')],
                [Markup.button.callback('👥 Usuários', 'adm_users')],
                [Markup.button.callback('💰 Saques (DePix)', 'adm_withdrawals')],
                [Markup.button.callback('💸 Fazer Saque (teste)', 'withdrawal_start')],
                [Markup.button.callback('💝 Contribuições', 'adm_contributions')],
                [Markup.button.callback('🎯 Projetos', 'adm_bounties')],
                [Markup.button.callback('🔧 Sistema', 'adm_system')],
                [Markup.button.callback('📊 Estatísticas', 'adm_stats')],
                [Markup.button.callback('📜 Auditoria', 'adm_audit')]
            ]);

            await ctx.reply(
                '🔧 *Painel Administrativo*\n\n' +
                'Bem-vindo ao sistema de administração do Atlas Bridge.\n\n' +
                'Selecione uma opção:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Admin] Erro no comando: ${error.message}`);
            await ctx.reply('❌ Erro ao abrir painel administrativo.');
        }
    });

    // ========================================
    // MENU DE BROADCAST
    // ========================================
    bot.action('adm_broadcast', requireAdmin, async (ctx) => {
        try {
            const stats = await broadcastService.getBroadcastStats();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📝 Nova Mensagem', 'bcast_new')],
                [Markup.button.callback('🎯 Segmentado', 'bcast_segmented')],
                [Markup.button.callback('🧪 Teste', 'bcast_test')],
                [Markup.button.callback('📊 Estatísticas', 'bcast_stats')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            await ctx.editMessageText(
                `📢 *Broadcast*\n\n` +
                `📊 *Resumo:*\n` +
                `├ Usuários ativos: ${stats.active_users}\n` +
                `├ Bloqueados: ${stats.blocked_users}\n` +
                `└ Verificados: ${stats.verified_users}\n\n` +
                `Escolha o tipo de broadcast:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Broadcast] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao abrir menu');
        }
    });

    // ========================================
    // MENU DE USUÁRIOS
    // ========================================
    bot.action('adm_users', requireAdmin, async (ctx) => {
        try {
            const stats = await userManagementService.getUserStats();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔍 Buscar Usuário', 'user_search')],
                [Markup.button.callback('🔨 Banir Rápido', 'user_quick_ban')],
                [Markup.button.callback('📋 Listar Todos', 'user_list')],
                [Markup.button.callback('⚠️ Suspeitos', 'user_suspicious')],
                [Markup.button.callback('🚫 Banidos', 'user_banned')],
                [Markup.button.callback('✅ Verificados', 'user_verified')],
                [Markup.button.callback('📤 Exportar Dados', 'user_export')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            await ctx.editMessageText(
                `👥 *Gerenciamento de Usuários*\n\n` +
                `📊 *Estatísticas:*\n` +
                `├ Total: ${stats.total_users}\n` +
                `├ Verificados: ${stats.verified_users}\n` +
                `├ Banidos: ${stats.banned_users}\n` +
                `├ Com carteira: ${stats.with_wallet}\n` +
                `├ Bloquearam bot: ${stats.bot_blocked}\n` +
                `├ Novos hoje: ${stats.new_today}\n` +
                `├ Ativos (7d): ${stats.active_week}\n` +
                `└ Volume total: R$ ${parseFloat(stats.total_volume || 0).toFixed(2)}\n\n` +
                `Selecione uma opção:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Users] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar usuários');
        }
    });

    // Listar usuários com paginação
    bot.action(/user_list_(\d+)/, requireAdmin, async (ctx) => {
        try {
            const page = parseInt(ctx.match[1]);
            const limit = 10;
            const offset = page * limit;

            const result = await userManagementService.searchUsers({
                limit,
                offset,
                sortBy: 'created_at',
                sortOrder: 'DESC'
            });

            let message = `👥 *Lista de Usuários (Página ${page + 1})*\n\n`;

            for (const user of result.users) {
                const status = user.is_banned ? '🚫' :
                              user.is_verified ? '✅' : '⚪';
                const wallet = user.liquid_address ? '💰' : '';

                message += `${status} ${user.telegram_user_id} - @${user.telegram_username || 'sem_username'} ${wallet}\n`;
                message += `├ Nome: ${user.telegram_full_name || 'N/A'}\n`;
                message += `├ Rep: ${user.reputation_level} | Vol: R$ ${user.total_volume_brl}\n`;
                message += `└ Desde: ${new Date(user.created_at).toLocaleDateString('pt-BR')}\n\n`;
            }

            const totalPages = Math.ceil(result.total / limit);
            const buttons = [];

            // Navegação
            const navButtons = [];
            if (page > 0) {
                navButtons.push(Markup.button.callback('⬅️', `user_list_${page - 1}`));
            }
            navButtons.push(Markup.button.callback(`${page + 1}/${totalPages}`, 'noop'));
            if (page < totalPages - 1) {
                navButtons.push(Markup.button.callback('➡️', `user_list_${page + 1}`));
            }
            buttons.push(navButtons);

            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_users')]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[User List] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao listar usuários');
        }
    });

    bot.action('user_list', requireAdmin, async (ctx) => {
        // Redirecionar para primeira página
        ctx.match = ['user_list_0', '0'];
        return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'user_list_0' } });
    });

    // Buscar usuário específico
    bot.action('user_search', requireAdmin, async (ctx) => {
        try {
            activeStates.set(ctx.from.id, { action: 'user_search' });

            await ctx.editMessageText(
                '🔍 *Buscar Usuário*\n\n' +
                'Envie o ID, username ou nome do usuário que deseja buscar.\n\n' +
                'Exemplos:\n' +
                '• ID: 123456789\n' +
                '• Username: @usuario\n' +
                '• Nome: João Silva\n\n' +
                'Use /cancel para cancelar',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[User Search] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para Banir Rápido
    bot.action('user_quick_ban', requireAdmin, async (ctx) => {
        try {
            activeStates.set(ctx.from.id, { action: 'user_quick_ban' });

            await ctx.editMessageText(
                '🔨 *Banir Usuário Rápido*\n\n' +
                'Digite qualquer um dos identificadores abaixo:\n\n' +
                '• **Telegram ID:** 123456789\n' +
                '• **Username:** @usuario\n' +
                '• **Wallet Liquid:** bc1q...\n' +
                '• **CPF:** 123.456.789-00\n\n' +
                'O sistema buscará automaticamente o usuário.\n\n' +
                'Use /cancel para cancelar',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[User Quick Ban] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // ========================================
    // MENU DE SISTEMA
    // ========================================
    bot.action('adm_system', requireAdmin, async (ctx) => {
        try {
            const status = await systemManagementService.getSystemStatus();
            const healthIcon = status.health === 'healthy' ? '🟢' :
                              status.health === 'degraded' ? '🟡' : '🔴';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📊 Status Completo', 'sys_status')],
                [Markup.button.callback('🔄 Limpar Cache', 'sys_cache')],
                [Markup.button.callback('📈 Métricas', 'sys_metrics')],
                [Markup.button.callback('📜 Logs', 'sys_logs')],
                [Markup.button.callback('💬 Msg Pós-Compra', 'sys_post_purchase')],
                [Markup.button.callback('🛡️ Segurança', 'sys_security')],
                [Markup.button.callback('🔧 Manutenção', 'sys_maintenance')],
                [Markup.button.callback('💾 Backups', 'sys_backup')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            await ctx.editMessageText(
                `🔧 *Gerenciamento do Sistema*\n\n` +
                `${healthIcon} *Status:* ${status.health}\n\n` +
                `🖥️ *Aplicação:*\n` +
                `├ Uptime: ${status.app.uptime.formatted}\n` +
                `├ Memória: ${status.app.memory.heapUsed}MB / ${status.app.memory.heapTotal}MB\n` +
                `└ Ambiente: ${status.app.env}\n\n` +
                `🗄️ *Banco de Dados:*\n` +
                `├ Status: ${status.database.status}\n` +
                `└ Latência: ${status.database.latency}\n\n` +
                `📡 *Redis:*\n` +
                `├ Status: ${status.redis.status}\n` +
                `└ Latência: ${status.redis.latency}\n\n` +
                `Selecione uma opção:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin System] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar status');
        }
    });

    // Status completo do sistema
    bot.action('sys_status', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('📊 Carregando status...');

            const status = await systemManagementService.getSystemStatus();

            let message = '📊 *Status Completo do Sistema*\n\n';

            // App status
            message += '🖥️ *Aplicação:*\n';
            message += `├ PID: ${status.app.pid}\n`;
            message += `├ Node: ${status.app.version}\n`;
            message += `├ Uptime: ${status.app.uptime.formatted}\n`;
            message += `├ Memória RSS: ${status.app.memory.rss}MB\n`;
            message += `├ Heap: ${status.app.memory.heapUsed}/${status.app.memory.heapTotal}MB\n`;
            message += `└ Ambiente: ${status.app.env}\n\n`;

            // Database status
            message += '🗄️ *Banco de Dados:*\n';
            message += `├ Status: ${status.database.status}\n`;
            message += `├ Latência: ${status.database.latency}\n`;
            message += `├ Tamanho: ${status.database.size}MB\n`;
            message += `├ Conexões: ${status.database.connections}\n`;
            message += `└ Pool: ${status.database.pool.idleCount}/${status.database.pool.totalCount}\n\n`;

            // Redis status
            message += '📡 *Redis:*\n';
            message += `├ Status: ${status.redis.status}\n`;
            message += `├ Latência: ${status.redis.latency}\n`;
            message += `├ Versão: ${status.redis.version}\n`;
            message += `├ Chaves: ${status.redis.keys}\n`;
            message += `├ Memória: ${status.redis.memory.used}MB\n`;
            message += `└ Clientes: ${status.redis.clients}\n\n`;

            // Server status
            message += '🖥️ *Servidor:*\n';
            message += `├ Host: ${status.server.hostname}\n`;
            message += `├ OS: ${status.server.platform} ${status.server.arch}\n`;
            message += `├ CPUs: ${status.server.cpus} (${status.server.cpuUsage} uso)\n`;
            message += `├ RAM: ${status.server.memory.used}/${status.server.memory.total}GB (${status.server.memory.percentage}%)\n`;
            message += `├ Load: ${status.server.loadAvg.join(', ')}\n`;
            message += `└ Uptime: ${status.server.uptime}\n`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Atualizar', 'sys_status')],
                [Markup.button.callback('◀️ Voltar', 'adm_system')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
        } catch (error) {
            logger.error(`[System Status] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar status');
        }
    });

    // Limpar cache
    bot.action('sys_cache', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('🔄 Limpando cache...');

            const keysDeleted = await systemManagementService.clearCache();

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: AuditService.ActionTypes.SYSTEM_CACHE_CLEARED,
                actionDescription: `Cache limpo: ${keysDeleted} chaves removidas`
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Voltar', 'adm_system')]
            ]);

            await ctx.editMessageText(
                `✅ *Cache Limpo*\n\n` +
                `🗑️ ${keysDeleted} chaves removidas do Redis\n\n` +
                `O cache foi limpo com sucesso.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
        } catch (error) {
            logger.error(`[System Cache] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao limpar cache');
        }
    });

    // ========================================
    // MENU DE ESTATÍSTICAS
    // ========================================
    bot.action('adm_stats', requireAdmin, async (ctx) => {
        try {
            const userStats = await userManagementService.getUserStats();
            const metrics = await systemManagementService.getPerformanceMetrics();

            const message =
                `📊 *Estatísticas do Sistema*\n\n` +
                `👥 *Usuários:*\n` +
                `├ Total: ${userStats.total_users}\n` +
                `├ Verificados: ${userStats.verified_users}\n` +
                `├ Com Carteira: ${userStats.with_wallet}\n` +
                `├ Banidos: ${userStats.banned_users}\n` +
                `├ Novos (30d): ${userStats.new_month}\n` +
                `└ Ativos (30d): ${userStats.active_month}\n\n` +
                `💰 *Transações:*\n` +
                `├ Total: ${metrics.transactions.total}\n` +
                `├ Confirmadas: ${metrics.transactions.confirmed}\n` +
                `├ Volume: R$ ${parseFloat(metrics.transactions.total_volume || 0).toFixed(2)}\n` +
                `└ Média: R$ ${parseFloat(metrics.transactions.avg_amount || 0).toFixed(2)}\n\n` +
                `📢 *Broadcasts:*\n` +
                `├ Hoje: ${metrics.broadcasts.today}\n` +
                `└ Semana: ${metrics.broadcasts.week}\n\n` +
                `⚠️ *Erros:*\n` +
                `├ Últimas 24h: ${metrics.errors.last24Hours}\n` +
                `└ Últimos 7d: ${metrics.errors.last7Days}`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Atualizar', 'adm_stats')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Stats] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao buscar estatísticas');
        }
    });

    // ========================================
    // MENU DE CONTRIBUIÇÕES
    // ========================================
    bot.action('adm_contributions', requireAdmin, async (ctx) => {
        try {
            // Buscar estatísticas de contribuições
            const statsResult = await dbPool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE contribution_fee > 0) as total_contributors,
                    ROUND(AVG(contribution_fee) FILTER (WHERE contribution_fee > 0), 2) as avg_fee,
                    MAX(contribution_fee) as max_fee,
                    MIN(contribution_fee) FILTER (WHERE contribution_fee > 0) as min_fee
                FROM users
            `);
            const stats = statsResult.rows[0];

            // Distribuição por tier
            const tierResult = await dbPool.query(`
                SELECT
                    contribution_fee,
                    COUNT(*) as count
                FROM users
                WHERE contribution_fee > 0
                GROUP BY contribution_fee
                ORDER BY contribution_fee ASC
            `);

            // Total arrecadado
            const collectedResult = await dbPool.query(`
                SELECT
                    COALESCE(SUM(contribution_amount_brl), 0) as total_collected,
                    COUNT(*) as total_transactions
                FROM pix_transactions
                WHERE contribution_amount_brl > 0
                AND payment_status IN ('CONFIRMED', 'PAID')
            `);
            const collected = collectedResult.rows[0];

            // Taxa média efetiva (considera TODAS as transações a partir de 27/11/2025, incluindo as que não contribuem)
            const effectiveFeeResult = await dbPool.query(`
                SELECT
                    COALESCE(ROUND(AVG(contribution_fee_percent), 2), 0) as avg_effective_fee
                FROM pix_transactions
                WHERE payment_status IN ('CONFIRMED', 'PAID')
                AND created_at >= '2025-11-27'
            `);
            const effectiveFee = effectiveFeeResult.rows[0];

            // Ranking da competição
            const rankingResult = await dbPool.query(`
                SELECT
                    cr.telegram_user_id,
                    u.telegram_username,
                    cr.total_contribution_brl,
                    cr.transaction_count
                FROM contribution_ranking cr
                JOIN users u ON u.telegram_user_id = cr.telegram_user_id
                WHERE cr.competition_id = '2024-11-26_2024-12-26'
                ORDER BY cr.total_contribution_brl DESC
                LIMIT 5
            `);

            let message = `<b>💝 Contribuições</b>\n\n`;
            message += `<b>📊 Resumo Geral:</b>\n`;
            message += `├ Contribuidores ativos: ${stats.total_contributors || 0}\n`;
            message += `├ Taxa média: ${stats.avg_fee || 0}%\n`;
            message += `├ Taxa média efetiva: ${effectiveFee.avg_effective_fee || 0}%\n`;
            message += `├ Taxa máxima: ${stats.max_fee || 0}%\n`;
            message += `└ Taxa mínima: ${stats.min_fee || 0}%\n\n`;

            message += `<b>💰 Arrecadação:</b>\n`;
            message += `├ Total: R$ ${parseFloat(collected.total_collected || 0).toFixed(2)}\n`;
            message += `└ Transações: ${collected.total_transactions || 0}\n\n`;

            if (tierResult.rows.length > 0) {
                message += `<b>📈 Distribuição por Taxa:</b>\n`;
                for (const tier of tierResult.rows) {
                    message += `├ ${tier.contribution_fee}%: ${tier.count} usuário(s)\n`;
                }
                message += `\n`;
            }

            if (rankingResult.rows.length > 0) {
                message += `<b>🏆 Top 5 Competição (26/11-26/12):</b>\n`;
                let pos = 1;
                for (const r of rankingResult.rows) {
                    const medal = pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : `${pos}.`;
                    const username = r.telegram_username ? `@${r.telegram_username}` : `ID: ${r.telegram_user_id}`;
                    message += `${medal} ${username}: R$ ${parseFloat(r.total_contribution_brl).toFixed(2)} (${r.transaction_count} tx)\n`;
                    pos++;
                }
            } else {
                message += `<b>🏆 Top 5 Competição (26/11-26/12):</b>\n`;
                message += `<i>Nenhuma contribuição registrada ainda</i>\n`;
            }

            // Adicionar timestamp para forçar atualização
            const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            message += `\n<i>Atualizado às ${now}</i>`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('👥 Ver Todos', 'contrib_list_0')],
                [Markup.button.callback('🔄 Atualizar', 'adm_contributions')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Contributions] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar contribuições');
        }
    });

    // Lista de contribuidores com paginação
    bot.action(/contrib_list_(\d+)/, requireAdmin, async (ctx) => {
        try {
            const page = parseInt(ctx.match[1]);
            const limit = 10;
            const offset = page * limit;

            // Contar total
            const countResult = await dbPool.query(`
                SELECT COUNT(*) as total FROM users WHERE contribution_fee > 0
            `);
            const total = parseInt(countResult.rows[0].total);
            const totalPages = Math.ceil(total / limit);

            // Buscar página atual
            const result = await dbPool.query(`
                SELECT
                    u.telegram_user_id,
                    u.telegram_username,
                    u.contribution_fee,
                    u.total_volume_brl,
                    COALESCE(SUM(pt.contribution_amount_brl), 0) as total_contributed
                FROM users u
                LEFT JOIN pix_transactions pt ON pt.user_id = u.telegram_user_id
                    AND pt.contribution_amount_brl > 0
                    AND pt.payment_status IN ('CONFIRMED', 'PAID')
                WHERE u.contribution_fee > 0
                GROUP BY u.telegram_user_id, u.telegram_username, u.contribution_fee, u.total_volume_brl
                ORDER BY u.contribution_fee DESC, total_contributed DESC
                LIMIT $1 OFFSET $2
            `, [limit, offset]);

            let message = `<b>👥 Lista de Contribuidores</b>\n`;
            message += `<i>Página ${page + 1}/${totalPages || 1} (${total} total)</i>\n\n`;

            if (result.rows.length === 0) {
                message += `<i>Nenhum contribuidor ativo</i>`;
            } else {
                let idx = offset + 1;
                for (const user of result.rows) {
                    const username = user.telegram_username ? `@${user.telegram_username}` : `ID: ${user.telegram_user_id}`;
                    message += `<b>${idx}.</b> ${username}\n`;
                    message += `   Taxa: ${user.contribution_fee}% | Contrib: R$ ${parseFloat(user.total_contributed).toFixed(2)}\n`;
                    message += `   Volume: R$ ${parseFloat(user.total_volume_brl || 0).toFixed(2)}\n\n`;
                    idx++;
                }
            }

            // Botões de navegação
            const navButtons = [];
            if (page > 0) {
                navButtons.push(Markup.button.callback('⬅️ Anterior', `contrib_list_${page - 1}`));
            }
            if (page < totalPages - 1) {
                navButtons.push(Markup.button.callback('Próxima ➡️', `contrib_list_${page + 1}`));
            }

            const keyboard = Markup.inlineKeyboard([
                navButtons.length > 0 ? navButtons : [],
                [Markup.button.callback('◀️ Voltar', 'adm_contributions')]
            ].filter(row => row.length > 0));

            await ctx.editMessageText(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard.reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Contrib List] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar lista');
        }
    });

    // ========================================
    // MENU DE AUDITORIA
    // ========================================
    bot.action('adm_audit', requireAdmin, async (ctx) => {
        try {
            const stats = await auditService.getAuditStats();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📜 Logs Recentes', 'audit_recent')],
                [Markup.button.callback('🔍 Buscar por Admin', 'audit_by_admin')],
                [Markup.button.callback('📊 Estatísticas', 'audit_stats')],
                [Markup.button.callback('📤 Exportar', 'audit_export')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            await ctx.editMessageText(
                `📜 *Auditoria*\n\n` +
                `📊 *Resumo:*\n` +
                `├ Total de ações: ${stats.total_actions}\n` +
                `├ Admins ativos: ${stats.total_admins}\n` +
                `├ Tipos de ação: ${stats.action_types}\n` +
                `├ Dias com atividade: ${stats.active_days}\n` +
                `└ Última ação: ${stats.last_action ? new Date(stats.last_action).toLocaleString('pt-BR') : 'N/A'}\n\n` +
                `Selecione uma opção:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Audit] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar auditoria');
        }
    });

    // Logs recentes de auditoria
    bot.action('audit_recent', requireAdmin, async (ctx) => {
        try {
            const logs = await auditService.getAuditLogs({ limit: 10 });

            let message = '📜 *Logs de Auditoria Recentes*\n\n';

            for (const log of logs) {
                const date = new Date(log.created_at).toLocaleString('pt-BR');
                message += `🕐 ${date}\n`;
                message += `👤 @${log.admin_username || 'admin'}\n`;
                message += `📌 ${log.action_type}\n`;
                message += `📝 ${log.action_description}\n\n`;
            }

            if (logs.length === 0) {
                message += '_Nenhum log encontrado_';
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Voltar', 'adm_audit')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Audit Recent] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar logs');
        }
    });

    // ========================================
    // VOLTAR AO MENU PRINCIPAL
    // ========================================
    bot.action('adm_main', requireAdmin, async (ctx) => {
        try {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📢 Broadcast', 'adm_broadcast')],
                [Markup.button.callback('👥 Usuários', 'adm_users')],
                [Markup.button.callback('💰 Saques (DePix)', 'adm_withdrawals')],
                [Markup.button.callback('💸 Fazer Saque (teste)', 'withdrawal_start')],
                [Markup.button.callback('💝 Contribuições', 'adm_contributions')],
                [Markup.button.callback('🎯 Projetos', 'adm_bounties')],
                [Markup.button.callback('🔧 Sistema', 'adm_system')],
                [Markup.button.callback('📊 Estatísticas', 'adm_stats')],
                [Markup.button.callback('📜 Auditoria', 'adm_audit')]
            ]);

            await ctx.editMessageText(
                '🔧 *Painel Administrativo*\n\n' +
                'Bem-vindo ao sistema de administração do Atlas Bridge.\n\n' +
                'Selecione uma opção:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Main] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // ========================================
    // PROCESSAR MENSAGENS DE TEXTO (ESTADOS)
    // ========================================
    bot.on('text', async (ctx, next) => {
        if (!isAdmin(ctx.from.id)) return next();

        const state = activeStates.get(ctx.from.id);
        if (!state) return next();

        // Se for comando de cancelar
        if (ctx.message.text === '/cancel') {
            activeStates.delete(ctx.from.id);
            return ctx.reply('❌ Operação cancelada.');
        }

        try {
            switch (state.action) {
                case 'user_search':
                    await handleUserSearch(ctx, state);
                    break;

                case 'user_quick_ban':
                    await handleUserQuickBan(ctx, state);
                    break;

                case 'broadcast_message':
                    await handleBroadcastMessage(ctx, state);
                    break;

                case 'broadcast_segmented':
                    await handleSegmentedBroadcast(ctx, state);
                    break;

                case 'broadcast_test':
                    await handleTestBroadcast(ctx, state);
                    break;

                case 'user_ban_reason':
                    await handleUserBanReason(ctx, state);
                    break;

                case 'edit_post_purchase_message':
                    await handlePostPurchaseMessage(ctx, state);
                    break;

                case 'bounty_create_title':
                    await handleBountyCreateTitle(ctx, state);
                    break;

                case 'bounty_create_desc':
                    await handleBountyCreateDesc(ctx, state);
                    break;

                case 'bounty_vote_pix_amount':
                    await handleBountyVotePixAmount(ctx, state);
                    break;

                default:
                    return next();
            }
        } catch (error) {
            logger.error(`[Admin State Handler] Erro: ${error.message}`);
            await ctx.reply('❌ Erro ao processar comando.');
            activeStates.delete(ctx.from.id);
        }
    });

    // Handler para busca de usuário
    async function handleUserSearch(ctx, state) {
        const searchTerm = ctx.message.text.replace('@', '');

        const result = await userManagementService.searchUsers({
            searchTerm,
            limit: 5
        });

        if (result.users.length === 0) {
            await ctx.reply('❌ Nenhum usuário encontrado.');
            activeStates.delete(ctx.from.id);
            return;
        }

        if (result.users.length === 1) {
            // Mostrar detalhes do usuário
            await showUserDetails(ctx, result.users[0].telegram_user_id);
        } else {
            // Mostrar lista para escolher
            let message = '🔍 Resultados da busca:\n\n';
            const buttons = [];

            for (const user of result.users) {
                message += `${user.telegram_user_id} - @${user.telegram_username || 'sem_username'}\n`;
                buttons.push([Markup.button.callback(
                    `👤 ${user.telegram_username || user.telegram_user_id}`,
                    `user_detail_${user.telegram_user_id}`
                )]);
            }

            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_users')]);

            await ctx.reply(message, {
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
        }

        activeStates.delete(ctx.from.id);
    }

    // Handler para editar mensagem pós-compra
    async function handlePostPurchaseMessage(ctx, state) {
        const newMessage = ctx.message.text.trim();

        if (newMessage.length > 1000) {
            await ctx.reply('❌ Mensagem muito longa! Máximo de 1000 caracteres.');
            return;
        }

        try {
            await dbPool.query(
                "UPDATE system_config SET value = $1, updated_at = NOW() WHERE key = 'post_purchase_message'",
                [newMessage]
            );

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'POST_PURCHASE_UPDATE',
                actionDescription: 'Mensagem pós-compra atualizada',
                targetUserId: null,
                metadata: { newMessage }
            });

            await ctx.reply(
                `✅ *Mensagem Pós-Compra Atualizada!*\n\n` +
                `A nova mensagem será enviada após compras bem-sucedidas.\n\n` +
                `📝 *Nova mensagem:*\n\`\`\`\n${newMessage}\n\`\`\``,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar ao Menu', 'sys_post_purchase')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Update Post Purchase] Erro: ${error.message}`);
            await ctx.reply('❌ Erro ao atualizar mensagem pós-compra.');
        }

        activeStates.delete(ctx.from.id);
    }

    // Handler para banir usuário rapidamente com múltiplos identificadores
    async function handleUserQuickBan(ctx, state) {
        const identifier = ctx.message.text.trim();

        // Detectar tipo de identificador
        let searchCriteria = {};

        // CPF pattern (xxx.xxx.xxx-xx or xxxxxxxxxxx)
        const cpfPattern = /^(\d{3}\.?\d{3}\.?\d{3}-?\d{2})$/;

        // Wallet pattern (starts with bc1, lq1, or ex1)
        const walletPattern = /^(bc1|lq1|ex1)[a-z0-9]{39,}$/i;

        // Telegram username (starts with @)
        const usernamePattern = /^@?[a-zA-Z0-9_]+$/;

        // Telegram ID (numeric)
        const telegramIdPattern = /^\d+$/;

        let user = null;

        if (cpfPattern.test(identifier)) {
            // Search by CPF
            const cleanCPF = identifier.replace(/[.-]/g, '');
            const result = await dbPool.query(
                'SELECT * FROM users WHERE payer_cpf_cnpj = $1 LIMIT 1',
                [cleanCPF]
            );
            user = result.rows[0];
        } else if (walletPattern.test(identifier)) {
            // Search by wallet
            const result = await dbPool.query(
                'SELECT * FROM users WHERE liquid_address = $1 LIMIT 1',
                [identifier]
            );
            user = result.rows[0];
        } else if (telegramIdPattern.test(identifier)) {
            // Search by Telegram ID
            const result = await userManagementService.getUserDetails(parseInt(identifier));
            user = result.user;
        } else if (usernamePattern.test(identifier)) {
            // Search by username
            const username = identifier.replace('@', '');
            const result = await userManagementService.searchUsers({
                searchTerm: username,
                limit: 1
            });
            user = result.users[0];
        } else {
            // Try general search
            const result = await userManagementService.searchUsers({
                searchTerm: identifier,
                limit: 1
            });
            user = result.users[0];
        }

        if (!user) {
            await ctx.reply('❌ Nenhum usuário encontrado com esse identificador.');
            activeStates.delete(ctx.from.id);
            return;
        }

        // Check if already banned
        if (user.is_banned) {
            await ctx.reply(
                `⚠️ Usuário já está banido\n\n` +
                `ID: ${user.telegram_user_id}\n` +
                `Username: @${user.telegram_username || 'sem_username'}\n` +
                `Nome: ${user.telegram_full_name || 'N/A'}\n\n` +
                `Use /admin para gerenciar usuários.`
            );
            activeStates.delete(ctx.from.id);
            return;
        }

        // Show user info and ask for confirmation
        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('🚫 Confirmar Ban', `quick_ban_confirm_${user.telegram_user_id}`),
                Markup.button.callback('❌ Cancelar', 'quick_ban_cancel')
            ]
        ]);

        // Use plain text to avoid Markdown parsing issues
        const message = `🔨 Confirmar Banimento\n\n` +
            `Usuário Encontrado:\n` +
            `├ ID: ${user.telegram_user_id}\n` +
            `├ Username: @${user.telegram_username || 'N/A'}\n` +
            `├ Nome: ${user.telegram_full_name || 'N/A'}\n` +
            `├ CPF: ${user.payer_cpf_cnpj || 'N/A'}\n` +
            `├ Wallet: ${user.liquid_address ? user.liquid_address.substring(0, 20) + '...' : 'N/A'}\n` +
            `├ Volume: R$ ${user.total_volume_brl || 0}\n` +
            `├ Transações: ${user.completed_transactions || 0}\n` +
            `└ Reputação: ${user.reputation_level || 0}\n\n` +
            `⚠️ Deseja confirmar o banimento?`;

        await ctx.reply(message, {
            reply_markup: keyboard.reply_markup
        });

        activeStates.delete(ctx.from.id);
    }

    // Mostrar detalhes do usuário
    async function showUserDetails(ctx, userId) {
        try {
            const details = await userManagementService.getUserDetails(userId);
            const user = details.user;

            const statusIcons = {
                verified: user.is_verified ? '✅' : '❌',
                banned: user.is_banned ? '🚫' : '✅',
                wallet: user.liquid_address ? '💰' : '❌',
                merchant: user.is_merchant ? '🏪' : '❌'
            };

            // Use plain text to avoid Markdown parsing issues
            let message = `👤 Detalhes do Usuário\n\n`;
            message += `Informações Básicas:\n`;
            message += `├ ID: ${user.telegram_user_id}\n`;
            message += `├ EUID: ${user.euid || 'N/A'}\n`;
            message += `├ Username: @${user.telegram_username || 'N/A'}\n`;
            message += `├ Nome: ${user.telegram_full_name || 'N/A'}\n`;
            message += `├ CPF/CNPJ: ${user.payer_cpf_cnpj || 'N/A'}\n`;
            message += `└ Cadastro: ${new Date(user.created_at).toLocaleString('pt-BR')}\n\n`;

            message += `Status:\n`;
            message += `├ Verificado: ${statusIcons.verified}\n`;
            message += `├ Banido: ${statusIcons.banned}\n`;
            message += `├ Carteira: ${statusIcons.wallet}\n`;
            message += `└ Merchant: ${statusIcons.merchant}\n\n`;

            message += `Estatísticas:\n`;
            message += `├ Reputação: ${user.reputation_level}\n`;
            message += `├ Volume: R$ ${user.total_volume_brl}\n`;
            message += `├ Transações: ${user.completed_transactions}\n`;
            message += `├ Limite diário: R$ ${user.daily_limit_brl}\n`;
            message += `└ Usado hoje: R$ ${user.daily_used_brl}\n`;

            if (user.is_banned) {
                message += `\n⚠️ Banimento:\n`;
                message += `├ Motivo: ${user.ban_reason || 'N/A'}\n`;
                message += `├ Por: ${user.banned_by || 'N/A'}\n`;
                message += `└ Data: ${user.banned_at ? new Date(user.banned_at).toLocaleString('pt-BR') : 'N/A'}\n`;
            }

            const buttons = [];

            // Ações disponíveis
            if (!user.is_banned) {
                buttons.push([Markup.button.callback('🚫 Banir', `user_ban_${userId}`)]);
            } else {
                buttons.push([Markup.button.callback('✅ Desbanir', `user_unban_${userId}`)]);
            }

            if (!user.is_verified) {
                buttons.push([Markup.button.callback('✅ Verificar', `user_verify_${userId}`)]);
            }

            buttons.push([
                Markup.button.callback('🔄 Resetar Limites', `user_reset_${userId}`),
                Markup.button.callback('⭐ Alterar Rep', `user_rep_${userId}`)
            ]);

            buttons.push([
                Markup.button.callback('📜 Histórico', `user_history_${userId}`),
                Markup.button.callback('💬 Enviar MSG', `user_message_${userId}`)
            ]);

            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_users')]);

            await ctx.reply(message, {
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });

        } catch (error) {
            logger.error(`[Show User Details] Erro: ${error.message}`);
            await ctx.reply('❌ Erro ao carregar detalhes do usuário.');
        }
    }

    // Handler para detalhes de usuário
    bot.action(/user_detail_(\d+)/, requireAdmin, async (ctx) => {
        const userId = parseInt(ctx.match[1]);
        await showUserDetails(ctx, userId);
        await ctx.answerCbQuery();
    });

    // Handler para banir usuário
    bot.action(/user_ban_(\d+)/, requireAdmin, async (ctx) => {
        const userId = parseInt(ctx.match[1]);

        activeStates.set(ctx.from.id, {
            action: 'user_ban_reason',
            userId
        });

        await ctx.reply(
            '🚫 Banir Usuário\n\n' +
            'Digite o motivo do banimento:\n\n' +
            'Use /cancel para cancelar'
        );
        await ctx.answerCbQuery();
    });

    // Handler para processar motivo de banimento
    async function handleUserBanReason(ctx, state) {
        const reason = ctx.message.text;

        await userManagementService.banUser(
            state.userId,
            ctx.from.id,
            ctx.from.username,
            reason
        );

        await ctx.reply(
            `✅ Usuário ${state.userId} banido com sucesso.\n` +
            `Motivo: ${reason}`
        );

        activeStates.delete(ctx.from.id);
    }

    // Handler para confirmar quick ban
    bot.action(/quick_ban_confirm_(\d+)/, requireAdmin, async (ctx) => {
        try {
            const userId = parseInt(ctx.match[1]);

            // Execute the ban with a default reason
            await userManagementService.banUser(
                userId,
                ctx.from.id,
                ctx.from.username,
                'Banido via Banimento Rápido - Múltiplos Identificadores'
            );

            await ctx.editMessageText(
                `✅ Usuário Banido com Sucesso\n\n` +
                `ID: ${userId}\n` +
                `Banido por: @${ctx.from.username || 'admin'}\n` +
                `Data: ${new Date().toLocaleString('pt-BR')}\n\n` +
                `Use /admin para gerenciar outros usuários.`
            );

            // Log the action
            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: AuditService.ActionTypes.USER_BANNED,
                actionDescription: `Usuário ${userId} banido via Quick Ban`,
                targetUserId: userId
            });

            await ctx.answerCbQuery('✅ Usuário banido com sucesso');
        } catch (error) {
            logger.error(`[Quick Ban Confirm] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao banir usuário');
            await ctx.editMessageText(
                `❌ Erro ao banir usuário: ${error.message}`
            );
        }
    });

    // Handler para cancelar quick ban
    bot.action('quick_ban_cancel', requireAdmin, async (ctx) => {
        await ctx.editMessageText(
            '❌ Banimento cancelado\n\n' +
            'Use /admin para retornar ao painel.'
        );
        await ctx.answerCbQuery('Banimento cancelado');
    });

    // Handler para desbanir usuário
    bot.action(/user_unban_(\d+)/, requireAdmin, async (ctx) => {
        const userId = parseInt(ctx.match[1]);

        await userManagementService.unbanUser(
            userId,
            ctx.from.id,
            ctx.from.username
        );

        await ctx.answerCbQuery('✅ Usuário desbanido');
        await showUserDetails(ctx, userId);
    });

    // Handler para verificar usuário
    bot.action(/user_verify_(\d+)/, requireAdmin, async (ctx) => {
        const userId = parseInt(ctx.match[1]);

        await userManagementService.verifyUser(
            userId,
            ctx.from.id,
            ctx.from.username
        );

        await ctx.answerCbQuery('✅ Usuário verificado');
        await showUserDetails(ctx, userId);
    });

    // Handler para resetar limites
    bot.action(/user_reset_(\d+)/, requireAdmin, async (ctx) => {
        const userId = parseInt(ctx.match[1]);

        await userManagementService.resetUserLimits(
            userId,
            ctx.from.id,
            ctx.from.username
        );

        await ctx.answerCbQuery('✅ Limites resetados');
        await showUserDetails(ctx, userId);
    });

    // ========================================
    // HANDLERS DE BROADCAST
    // ========================================

    // Novo broadcast
    bot.action('bcast_new', requireAdmin, async (ctx) => {
        try {
            activeStates.set(ctx.from.id, {
                action: 'broadcast_message',
                type: 'all'
            });

            await ctx.editMessageText(
                '📝 *Novo Broadcast*\n\n' +
                'Envie a mensagem que deseja transmitir para todos os usuários ativos.\n\n' +
                '⚠️ Use /cancel para cancelar',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Broadcast New] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para processar mensagem de broadcast
    async function handleBroadcastMessage(ctx, state) {
        const message = escapeMarkdownV2(ctx.message.text);

        await ctx.reply('📤 Iniciando broadcast...');

        const result = await broadcastService.sendBroadcast(message, {
            keyboard: Markup.inlineKeyboard([
                [Markup.button.url('💬 Comunidade', process.env.LINK_COMMUNITY_GROUP || 'https://t.me/atlasdao')]
            ]).reply_markup
        });

        // Registrar auditoria
        await auditService.logAdminAction({
            adminId: ctx.from.id,
            adminUsername: ctx.from.username,
            actionType: AuditService.ActionTypes.BROADCAST_SENT,
            actionDescription: `Broadcast enviado para ${result.sent} usuários`,
            metadata: result
        });

        const report =
            `✅ *Broadcast Concluído*\n\n` +
            `📊 *Estatísticas:*\n` +
            `├ Total: ${result.total}\n` +
            `├ ✅ Enviados: ${result.sent}\n` +
            `├ ❌ Falhas: ${result.failed}\n` +
            `├ 🚫 Bloqueados: ${result.blocked}\n` +
            `└ ⚠️ Inválidos: ${result.invalid}`;

        await ctx.reply(report, { parse_mode: 'Markdown' });
        activeStates.delete(ctx.from.id);
    }

    // Handler para broadcast segmentado
    async function handleSegmentedBroadcast(ctx, state) {
        const message = escapeMarkdownV2(ctx.message.text);
        const filters = state.filters || {};

        await ctx.reply('📤 Iniciando broadcast segmentado...');

        // Converter filtros para o formato esperado pelo serviço
        const broadcastFilters = {};

        if (filters.isVerified) {
            broadcastFilters.isVerified = true;
        }
        if (filters.minReputation) {
            broadcastFilters.minReputation = filters.minReputation;
        }
        if (filters.minVolume) {
            broadcastFilters.minVolume = filters.minVolume;
        }
        if (filters.activeDays) {
            broadcastFilters.lastActiveWithinDays = filters.activeDays;
        }
        if (filters.inactiveDays) {
            broadcastFilters.inactiveSinceDays = filters.inactiveDays;
        }

        const result = await broadcastService.sendSegmentedBroadcast(message, broadcastFilters, {
            keyboard: Markup.inlineKeyboard([
                [Markup.button.url('💬 Comunidade', process.env.LINK_COMMUNITY_GROUP || 'https://t.me/atlasdao')]
            ]).reply_markup
        });

        // Registrar auditoria
        await auditService.logAdminAction({
            adminId: ctx.from.id,
            adminUsername: ctx.from.username,
            actionType: AuditService.ActionTypes.BROADCAST_SENT,
            actionDescription: `Broadcast segmentado enviado para ${result.sent} usuários`,
            metadata: { result, filters: broadcastFilters }
        });

        const report =
            `✅ *Broadcast Segmentado Concluído*\n\n` +
            `🎯 *Filtros Aplicados:*\n` +
            (filters.isVerified ? `├ ✅ Apenas verificados\n` : '') +
            (filters.minReputation ? `├ ⭐ Reputação >= ${filters.minReputation}\n` : '') +
            (filters.minVolume ? `├ 💰 Volume >= R$ ${filters.minVolume.toLocaleString('pt-BR')}\n` : '') +
            (filters.activeDays ? `├ 📅 Ativos nos últimos ${filters.activeDays} dias\n` : '') +
            (filters.inactiveDays ? `├ 📅 Inativos há mais de ${filters.inactiveDays} dias\n` : '') +
            `\n📊 *Estatísticas:*\n` +
            `├ Total: ${result.total}\n` +
            `├ ✅ Enviados: ${result.sent}\n` +
            `├ ❌ Falhas: ${result.failed}\n` +
            `├ 🚫 Bloqueados: ${result.blocked}\n` +
            `└ ⚠️ Inválidos: ${result.invalid}`;

        await ctx.reply(report, { parse_mode: 'Markdown' });
        activeStates.delete(ctx.from.id);
    }

    // Handler para broadcast de teste
    async function handleTestBroadcast(ctx, state) {
        const message = escapeMarkdownV2(ctx.message.text);

        await ctx.reply('🧪 Enviando mensagem de teste para administradores...');

        let sent = 0;
        let failed = 0;

        for (const adminId of ADMIN_IDS) {
            try {
                await bot.telegram.sendMessage(adminId,
                    `🧪 *TESTE DE BROADCAST*\n\n${message}\n\n_Esta é uma mensagem de teste enviada apenas para administradores._`,
                    {
                        parse_mode: 'MarkdownV2',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.url('💬 Comunidade', process.env.LINK_COMMUNITY_GROUP || 'https://t.me/atlasdao')]
                        ]).reply_markup
                    }
                );
                sent++;
            } catch (error) {
                logger.error(`[Test Broadcast] Erro ao enviar para admin ${adminId}: ${error.message}`);
                failed++;
            }
        }

        // Registrar auditoria
        await auditService.logAdminAction({
            adminId: ctx.from.id,
            adminUsername: ctx.from.username,
            actionType: 'BROADCAST_TEST',
            actionDescription: `Broadcast de teste enviado para ${sent} admins`,
            metadata: { sent, failed }
        });

        const report =
            `✅ *Teste de Broadcast Concluído*\n\n` +
            `📊 *Estatísticas:*\n` +
            `├ Total de Admins: ${ADMIN_IDS.length}\n` +
            `├ ✅ Enviados: ${sent}\n` +
            `└ ❌ Falhas: ${failed}`;

        await ctx.reply(report, { parse_mode: 'Markdown' });
        activeStates.delete(ctx.from.id);
    }

    // ========================================
    // COMANDO /cancel
    // ========================================
    bot.command('cancel', (ctx) => {
        if (activeStates.has(ctx.from.id)) {
            activeStates.delete(ctx.from.id);
            ctx.reply('❌ Operação cancelada.');
        }
    });

    // Handler para callbacks não implementados
    bot.action('noop', async (ctx) => {
        await ctx.answerCbQuery();
    });

    // ========================================
    // HANDLERS ADICIONAIS FALTANTES
    // ========================================

    // Removed configuration menu - not needed
    /* bot.action('adm_config', requireAdmin, async (ctx) => {
        try {
            // Buscar configurações atuais
            const config = await systemManagementService.getSystemConfig();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💰 Limites e Taxas', 'config_limits')],
                [Markup.button.callback('🛡️ Segurança', 'config_security')],
                [Markup.button.callback('📢 Notificações', 'config_notifications')],
                [Markup.button.callback('👥 Permissões Admin', 'config_permissions')],
                [Markup.button.callback('🤖 Bot Settings', 'config_bot')],
                [Markup.button.callback('🔄 Recarregar Config', 'config_reload')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            await ctx.editMessageText(
                '⚙️ *Configurações do Sistema*\n\n' +
                '📊 *Status Atual:*\n' +
                `├ Modo Manutenção: ${config.maintenanceMode ? '🔴 Ativo' : '🟢 Inativo'}\n` +
                `├ Taxa de Transação: R$ ${config.transactionFee || 0.99}\n` +
                `├ Limite Diário: R$ ${config.dailyLimit || 1000}\n` +
                `├ Limite por Transação: R$ ${config.transactionLimit || 500}\n` +
                `├ Verificação Obrigatória: ${config.requireVerification ? '✅ Sim' : '❌ Não'}\n` +
                `├ Auto Backup: ${config.autoBackup ? '✅ Habilitado' : '❌ Desabilitado'}\n` +
                `├ Rate Limiting: ${config.rateLimitEnabled ? '✅ Ativo' : '❌ Inativo'}\n` +
                `└ Debug Mode: ${config.debugMode ? '✅ Ativo' : '❌ Inativo'}\n\n` +
                'Selecione uma categoria para configurar:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Config] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao abrir configurações');
        }
    });

    // Handler para configuração de limites
    bot.action('config_limits', requireAdmin, async (ctx) => {
        try {
            const config = await systemManagementService.getSystemConfig();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(`Taxa: R$ ${config.transactionFee || 0.99}`, 'set_transaction_fee')],
                [Markup.button.callback(`Limite Diário: R$ ${config.dailyLimit || 1000}`, 'set_daily_limit')],
                [Markup.button.callback(`Limite/Transação: R$ ${config.transactionLimit || 500}`, 'set_transaction_limit')],
                [Markup.button.callback(`Min Reputação: ${config.minReputationLevel || 1}`, 'set_min_reputation')],
                [Markup.button.callback(`Max Reputação: ${config.maxReputationLevel || 10}`, 'set_max_reputation')],
                [Markup.button.callback('◀️ Voltar', 'adm_config')]
            ]);

            await ctx.editMessageText(
                '💰 **Limites e Taxas**\n\n' +
                'Clique em um item para alterar seu valor:\n\n' +
                `• **Taxa de Transação:** R$ ${config.transactionFee || 0.99}\n` +
                `• **Limite Diário Padrão:** R$ ${config.dailyLimit || 1000}\n` +
                `• **Limite por Transação:** R$ ${config.transactionLimit || 500}\n` +
                `• **Nível Mínimo de Reputação:** ${config.minReputationLevel || 1}\n` +
                `• **Nível Máximo de Reputação:** ${config.maxReputationLevel || 10}\n\n` +
                '⚠️ Mudanças são aplicadas imediatamente!',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Config Limits] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao abrir limites');
        }
    });

    // Handler para configuração de segurança
    bot.action('config_security', requireAdmin, async (ctx) => {
        try {
            const config = await systemManagementService.getSystemConfig();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(
                    `${config.requireVerification ? '✅' : '❌'} Verificação Obrigatória`,
                    'toggle_require_verification'
                )],
                [Markup.button.callback(
                    `${config.rateLimitEnabled ? '✅' : '❌'} Rate Limiting`,
                    'toggle_rate_limit'
                )],
                [Markup.button.callback(
                    `${config.antiSpam ? '✅' : '❌'} Anti-Spam`,
                    'toggle_anti_spam'
                )],
                [Markup.button.callback(
                    `${config.requireKYC ? '✅' : '❌'} KYC Obrigatório`,
                    'toggle_require_kyc'
                )],
                [Markup.button.callback(
                    `${config.blockVPN ? '✅' : '❌'} Bloquear VPN`,
                    'toggle_block_vpn'
                )],
                [Markup.button.callback(
                    `${config.twoFactorAdmin ? '✅' : '❌'} 2FA para Admins`,
                    'toggle_2fa_admin'
                )],
                [Markup.button.callback('◀️ Voltar', 'adm_config')]
            ]);

            await ctx.editMessageText(
                '🛡️ **Configurações de Segurança**\n\n' +
                'Clique para ativar/desativar:\n\n' +
                `• **Verificação Obrigatória:** ${config.requireVerification ? '✅ Ativa' : '❌ Inativa'}\n` +
                `• **Rate Limiting:** ${config.rateLimitEnabled ? '✅ Ativo' : '❌ Inativo'}\n` +
                `• **Anti-Spam:** ${config.antiSpam ? '✅ Ativo' : '❌ Inativo'}\n` +
                `• **KYC Obrigatório:** ${config.requireKYC ? '✅ Ativo' : '❌ Inativo'}\n` +
                `• **Bloquear VPN:** ${config.blockVPN ? '✅ Ativo' : '❌ Inativo'}\n` +
                `• **2FA para Admins:** ${config.twoFactorAdmin ? '✅ Ativo' : '❌ Inativo'}\n\n` +
                '⚠️ Mudanças de segurança podem afetar usuários ativos!',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Config Security] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao abrir segurança');
        }
    });

    // Handler para configuração de notificações
    bot.action('config_notifications', requireAdmin, async (ctx) => {
        try {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📧 Notificar Novos Usuários', 'toggle_notify_new_users')],
                [Markup.button.callback('💰 Notificar Transações', 'toggle_notify_transactions')],
                [Markup.button.callback('⚠️ Notificar Erros', 'toggle_notify_errors')],
                [Markup.button.callback('🔒 Notificar Eventos Segurança', 'toggle_notify_security')],
                [Markup.button.callback('◀️ Voltar', 'adm_config')]
            ]);

            await ctx.editMessageText(
                '📢 **Configurações de Notificações**\n\n' +
                'Configure quais eventos devem notificar os administradores:\n\n' +
                'Em desenvolvimento...',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Config Notifications] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para configuração do bot
    bot.action('config_bot', requireAdmin, async (ctx) => {
        try {
            const config = await systemManagementService.getSystemConfig();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(
                    `${config.debugMode ? '✅' : '❌'} Debug Mode`,
                    'toggle_debug_mode'
                )],
                [Markup.button.callback(
                    `${config.autoBackup ? '✅' : '❌'} Auto Backup`,
                    'toggle_auto_backup'
                )],
                [Markup.button.callback('🔄 Resetar Cache', 'reset_cache')],
                [Markup.button.callback('📝 Webhook Secret', 'set_webhook_secret')],
                [Markup.button.callback('◀️ Voltar', 'adm_config')]
            ]);

            await ctx.editMessageText(
                '🤖 **Configurações do Bot**\n\n' +
                `• **Debug Mode:** ${config.debugMode ? '✅ Ativo' : '❌ Inativo'}\n` +
                `• **Auto Backup:** ${config.autoBackup ? '✅ Ativo' : '❌ Inativo'}\n` +
                `• **Webhook Secret:** ${config.webhookSecret ? '✅ Configurado' : '❌ Não configurado'}\n\n` +
                'Clique para modificar:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Config Bot] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para recarregar configurações
    bot.action('config_reload', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('🔄 Recarregando configurações...');

            const config = await systemManagementService.reloadConfig();

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'CONFIG_RELOADED',
                actionDescription: 'Configurações do sistema recarregadas'
            });

            await ctx.editMessageText(
                '✅ **Configurações Recarregadas**\n\n' +
                'As configurações foram recarregadas do banco de dados.\n\n' +
                `• Modo Manutenção: ${config.maintenanceMode ? '🔴 Ativo' : '🟢 Inativo'}\n` +
                `• Configurações carregadas: ${Object.keys(config).length}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'adm_config')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Config Reload] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao recarregar');
        }
    });

    // Handlers para toggle de configurações
    bot.action(/^toggle_(.+)$/, requireAdmin, async (ctx) => {
        const configKey = ctx.match[1];
        try {
            const newValue = await systemManagementService.toggleConfig(configKey);

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'CONFIG_TOGGLED',
                actionDescription: `${configKey} alterado para ${newValue}`
            });

            await ctx.answerCbQuery(`✅ ${configKey}: ${newValue ? 'ATIVADO' : 'DESATIVADO'}`, true);

            // Recarregar a tela atual
            const currentAction = ctx.callbackQuery.message.reply_markup.inline_keyboard
                .flat()
                .find(btn => btn.text.includes('Voltar'))?.callback_data;

            if (currentAction) {
                return bot.handleUpdate({
                    ...ctx.update,
                    callback_query: { ...ctx.callbackQuery, data: currentAction === 'adm_config' ? 'config_security' : 'config_bot' }
                });
            }
        } catch (error) {
            logger.error(`[Toggle Config] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao alterar configuração');
        }
    });

    // Handler para resetar cache
    bot.action('reset_cache', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('🔄 Limpando cache...');

            const keysDeleted = await systemManagementService.clearCache();

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'CACHE_CLEARED',
                actionDescription: `Cache limpo: ${keysDeleted} chaves removidas`
            });

            await ctx.editMessageText(
                `✅ **Cache Limpo**\n\n` +
                `🗑️ ${keysDeleted} chaves removidas do Redis\n\n` +
                `O cache foi limpo com sucesso.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'config_bot')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Reset Cache] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao limpar cache');
        }
    }); */

    // Handler para Broadcast Segmentado
    bot.action('bcast_segmented', requireAdmin, async (ctx) => {
        try {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Apenas Verificados', 'bcast_verified')],
                [Markup.button.callback('🌟 Por Reputação', 'bcast_by_rep')],
                [Markup.button.callback('💰 Por Volume', 'bcast_by_volume')],
                [Markup.button.callback('📅 Por Atividade', 'bcast_by_activity')],
                [Markup.button.callback('◀️ Voltar', 'adm_broadcast')]
            ]);

            await ctx.editMessageText(
                '🎯 *Broadcast Segmentado*\n\n' +
                'Escolha o critério de segmentação:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Broadcast Segmented] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao abrir segmentação');
        }
    });

    // Handler para Broadcast de Teste
    bot.action('bcast_test', requireAdmin, async (ctx) => {
        try {
            activeStates.set(ctx.from.id, { action: 'broadcast_test' });

            await ctx.editMessageText(
                '🧪 *Broadcast de Teste*\n\n' +
                'Esta mensagem será enviada apenas para administradores.\n\n' +
                'Digite a mensagem de teste ou /cancel para cancelar:',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Broadcast Test] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao iniciar teste');
        }
    });

    // Handler para Broadcast Apenas Verificados
    bot.action('bcast_verified', requireAdmin, async (ctx) => {
        try {
            activeStates.set(ctx.from.id, {
                action: 'broadcast_segmented',
                filters: { isVerified: true }
            });

            await ctx.editMessageText(
                '✅ *Broadcast - Apenas Verificados*\n\n' +
                'A mensagem será enviada apenas para usuários verificados.\n\n' +
                'Digite a mensagem ou /cancel para cancelar:',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Broadcast Verified] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao iniciar broadcast');
        }
    });

    // Handler para Broadcast por Reputação
    bot.action('bcast_by_rep', requireAdmin, async (ctx) => {
        try {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⭐ Reputação >= 50', 'seg_rep_50')],
                [Markup.button.callback('⭐ Reputação >= 75', 'seg_rep_75')],
                [Markup.button.callback('⭐ Reputação >= 90', 'seg_rep_90')],
                [Markup.button.callback('🎯 Personalizado', 'seg_rep_custom')],
                [Markup.button.callback('◀️ Voltar', 'bcast_segmented')]
            ]);

            await ctx.editMessageText(
                '🌟 *Broadcast por Reputação*\n\n' +
                'Selecione o nível mínimo de reputação:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Broadcast By Rep] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handlers para níveis de reputação
    bot.action(/^seg_rep_(\d+)$/, requireAdmin, async (ctx) => {
        const minRep = parseInt(ctx.match[1]);
        try {
            activeStates.set(ctx.from.id, {
                action: 'broadcast_segmented',
                filters: { minReputation: minRep }
            });

            await ctx.editMessageText(
                `🌟 *Broadcast - Reputação >= ${minRep}*\n\n` +
                `A mensagem será enviada apenas para usuários com reputação >= ${minRep}.\n\n` +
                'Digite a mensagem ou /cancel para cancelar:',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Seg Rep] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para Broadcast por Volume
    bot.action('bcast_by_volume', requireAdmin, async (ctx) => {
        try {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💰 R$ 1.000+', 'seg_vol_1000')],
                [Markup.button.callback('💰 R$ 5.000+', 'seg_vol_5000')],
                [Markup.button.callback('💰 R$ 10.000+', 'seg_vol_10000')],
                [Markup.button.callback('💰 R$ 50.000+', 'seg_vol_50000')],
                [Markup.button.callback('🎯 Personalizado', 'seg_vol_custom')],
                [Markup.button.callback('◀️ Voltar', 'bcast_segmented')]
            ]);

            await ctx.editMessageText(
                '💰 *Broadcast por Volume de Transações*\n\n' +
                'Selecione o volume mínimo:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Broadcast By Volume] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handlers para volumes
    bot.action(/^seg_vol_(\d+)$/, requireAdmin, async (ctx) => {
        const minVolume = parseInt(ctx.match[1]);
        try {
            activeStates.set(ctx.from.id, {
                action: 'broadcast_segmented',
                filters: { minVolume }
            });

            await ctx.editMessageText(
                `💰 *Broadcast - Volume >= R$ ${minVolume.toLocaleString('pt-BR')}*\n\n` +
                `A mensagem será enviada apenas para usuários com volume >= R$ ${minVolume.toLocaleString('pt-BR')}.\n\n` +
                'Digite a mensagem ou /cancel para cancelar:',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Seg Volume] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para Broadcast por Atividade
    bot.action('bcast_by_activity', requireAdmin, async (ctx) => {
        try {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📅 Últimas 24 horas', 'seg_act_1')],
                [Markup.button.callback('📅 Últimos 7 dias', 'seg_act_7')],
                [Markup.button.callback('📅 Últimos 30 dias', 'seg_act_30')],
                [Markup.button.callback('📅 Últimos 90 dias', 'seg_act_90')],
                [Markup.button.callback('📅 Inativos há 30+ dias', 'seg_act_inactive')],
                [Markup.button.callback('◀️ Voltar', 'bcast_segmented')]
            ]);

            await ctx.editMessageText(
                '📅 *Broadcast por Período de Atividade*\n\n' +
                'Selecione o período:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Broadcast By Activity] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handlers para atividade
    bot.action(/^seg_act_(\w+)$/, requireAdmin, async (ctx) => {
        const period = ctx.match[1];
        try {
            let filters = {};
            let description = '';

            if (period === 'inactive') {
                filters.inactiveDays = 30;
                description = 'Inativos há mais de 30 dias';
            } else {
                const days = parseInt(period);
                filters.activeDays = days;
                description = `Ativos nos últimos ${days} dia${days > 1 ? 's' : ''}`;
            }

            activeStates.set(ctx.from.id, {
                action: 'broadcast_segmented',
                filters
            });

            await ctx.editMessageText(
                `📅 *Broadcast - ${description}*\n\n` +
                `A mensagem será enviada apenas para usuários ${description.toLowerCase()}.\n\n` +
                'Digite a mensagem ou /cancel para cancelar:',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Seg Activity] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para Estatísticas de Broadcast
    bot.action('bcast_stats', requireAdmin, async (ctx) => {
        try {
            const stats = await broadcastService.getBroadcastHistory();

            let message = '📊 *Estatísticas de Broadcast*\n\n';

            if (stats && stats.length > 0) {
                for (const broadcast of stats.slice(0, 5)) {
                    message += `📅 *${new Date(broadcast.created_at).toLocaleDateString('pt-BR')}*\n`;
                    message += `├ Enviados: ${broadcast.sent_count}\n`;
                    message += `├ Falhas: ${broadcast.failed_count}\n`;
                    message += `├ Bloqueados: ${broadcast.blocked_count}\n`;
                    message += `└ Taxa sucesso: ${((broadcast.sent_count / broadcast.total_count) * 100).toFixed(1)}%\n\n`;
                }
            } else {
                message += 'Nenhum broadcast realizado ainda.';
            }

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_broadcast')]
                ]).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Broadcast Stats] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar estatísticas');
        }
    });

    // Handler para Usuários Suspeitos
    bot.action('user_suspicious', requireAdmin, async (ctx) => {
        try {
            const suspicious = await userManagementService.findSuspiciousActivity();

            let message = '⚠️ *Atividade Suspeita*\n\n';

            if (suspicious && suspicious.length > 0) {
                for (const user of suspicious.slice(0, 10)) {
                    message += `🔍 ${user.telegram_user_id} - @${user.telegram_username || 'sem_username'}\n`;
                    message += `├ Motivo: ${user.reason}\n`;
                    message += `├ Volume: R$ ${user.total_volume_brl}\n`;
                    message += `└ Transações: ${user.completed_transactions}\n\n`;
                }
            } else {
                message += 'Nenhuma atividade suspeita detectada.';
            }

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_users')]
                ]).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[User Suspicious] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao buscar suspeitos');
        }
    });

    // Handler para Usuários Banidos
    bot.action('user_banned', requireAdmin, async (ctx) => {
        try {
            const result = await userManagementService.searchUsers({
                isBanned: true,
                limit: 20,
                sortBy: 'updated_at',
                sortOrder: 'DESC'
            });

            let message = '🚫 *Usuários Banidos*\n\n';

            if (result.users && result.users.length > 0) {
                for (const user of result.users) {
                    message += `❌ ${user.telegram_user_id} - @${user.telegram_username || 'sem_username'}\n`;
                    message += `├ Nome: ${user.telegram_full_name || 'N/A'}\n`;
                    message += `├ Motivo: ${user.ban_reason || 'Não especificado'}\n`;
                    message += `└ Data: ${new Date(user.banned_at || user.updated_at).toLocaleDateString('pt-BR')}\n\n`;
                }
            } else {
                message += 'Nenhum usuário banido.';
            }

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_users')]
                ]).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[User Banned] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao listar banidos');
        }
    });

    // Handler para Usuários Verificados
    bot.action('user_verified', requireAdmin, async (ctx) => {
        try {
            const result = await userManagementService.searchUsers({
                isVerified: true,
                limit: 20,
                sortBy: 'total_volume_brl',
                sortOrder: 'DESC'
            });

            let message = '✅ *Usuários Verificados*\n\n';

            if (result.users && result.users.length > 0) {
                for (const user of result.users) {
                    message += `✅ ${user.telegram_user_id} - @${user.telegram_username || 'sem_username'}\n`;
                    message += `├ Nome: ${user.telegram_full_name || 'N/A'}\n`;
                    message += `├ Volume: R$ ${user.total_volume_brl}\n`;
                    message += `├ Reputação: ${user.reputation_level}\n`;
                    message += `└ Transações: ${user.completed_transactions}\n\n`;
                }
            } else {
                message += 'Nenhum usuário verificado.';
            }

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_users')]
                ]).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[User Verified] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao listar verificados');
        }
    });

    // Handler para Exportar Dados de Usuários
    bot.action('user_export', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('📤 Preparando exportação...');

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📄 CSV', 'export_csv')],
                [Markup.button.callback('📊 JSON', 'export_json')],
                [Markup.button.callback('◀️ Voltar', 'adm_users')]
            ]);

            await ctx.editMessageText(
                '📤 *Exportar Dados*\n\n' +
                'Escolha o formato de exportação:\n\n' +
                '• *CSV* - Para análise em planilhas\n' +
                '• *JSON* - Para integração com sistemas\n\n' +
                '⚠️ O arquivo será enviado via mensagem privada.',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
        } catch (error) {
            logger.error(`[User Export] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao preparar exportação');
        }
    });

    // Handler para Métricas do Sistema
    bot.action('sys_metrics', requireAdmin, async (ctx) => {
        try {
            const metrics = await systemManagementService.getSystemMetrics();

            let message = '📈 *Métricas do Sistema*\n\n';
            message += '📊 *Performance (última hora):*\n';
            message += `├ Requisições: ${metrics.requests || 0}\n`;
            message += `├ Tempo médio: ${metrics.avgResponseTime || 'N/A'}ms\n`;
            message += `├ Taxa de erro: ${metrics.errorRate || 0}%\n`;
            message += `└ Uptime: ${metrics.uptime || 'N/A'}\n\n`;

            message += '💾 *Recursos:*\n';
            message += `├ CPU: ${metrics.cpuUsage || 'N/A'}%\n`;
            message += `├ RAM: ${metrics.memoryUsage || 'N/A'}%\n`;
            message += `├ Disco: ${metrics.diskUsage || 'N/A'}%\n`;
            message += `└ Rede: ${metrics.networkUsage || 'N/A'} MB/s\n\n`;

            message += '📈 *Tendências (24h):*\n';
            message += `├ Pico de requisições: ${metrics.peakRequests || 'N/A'}\n`;
            message += `├ Horário de pico: ${metrics.peakTime || 'N/A'}\n`;
            message += `└ Total processado: ${metrics.totalProcessed || 'N/A'}`;

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Atualizar', 'sys_metrics')],
                    [Markup.button.callback('◀️ Voltar', 'adm_system')]
                ]).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[System Metrics] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar métricas');
        }
    });

    // Handler para Logs do Sistema
    bot.action('sys_logs', requireAdmin, async (ctx) => {
        try {
            const logs = await systemManagementService.getRecentLogs(20);

            let message = '📜 *Logs do Sistema*\n\n';

            if (logs && logs.length > 0) {
                for (const log of logs) {
                    const icon = log.level === 'error' ? '🔴' :
                                 log.level === 'warn' ? '🟡' : '🟢';
                    message += `${icon} [${log.timestamp}]\n`;
                    message += `${log.message}\n\n`;
                }
            } else {
                message += 'Nenhum log disponível.';
            }

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Atualizar', 'sys_logs')],
                    [Markup.button.callback('📤 Exportar', 'logs_export')],
                    [Markup.button.callback('◀️ Voltar', 'adm_system')]
                ]).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[System Logs] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar logs');
        }
    });

    // Handler para Post-Purchase Message
    bot.action('sys_post_purchase', requireAdmin, async (ctx) => {
        try {
            // Get current message from database
            const { rows } = await dbPool.query(
                "SELECT value FROM system_config WHERE key = 'post_purchase_message' AND active = true"
            );

            const currentMessage = rows.length > 0 ? rows[0].value : 'Não configurado';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✏️ Editar Mensagem', 'edit_post_purchase')],
                [Markup.button.callback('👁️ Visualizar', 'preview_post_purchase')],
                [Markup.button.callback('🔄 Restaurar Padrão', 'reset_post_purchase')],
                [Markup.button.callback('◀️ Voltar', 'adm_system')]
            ]);

            await ctx.editMessageText(
                `💬 *Mensagem Pós-Compra*\n\n` +
                `Esta mensagem é enviada automaticamente 3 segundos após uma compra bem-sucedida.\n\n` +
                `📝 *Mensagem Atual:*\n\`\`\`\n${currentMessage.substring(0, 500)}${currentMessage.length > 500 ? '...' : ''}\n\`\`\`\n\n` +
                `Use os botões abaixo para gerenciar a mensagem.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Post Purchase Message] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar configuração');
        }
    });

    // Handler para editar post-purchase message
    bot.action('edit_post_purchase', requireAdmin, async (ctx) => {
        activeStates.set(ctx.from.id, {
            action: 'edit_post_purchase_message'
        });

        await ctx.editMessageText(
            `✏️ *Editar Mensagem Pós-Compra*\n\n` +
            `Digite a nova mensagem que será enviada após compras bem-sucedidas.\n\n` +
            `💡 *Dicas:*\n` +
            `• Use \\* para negrito\n` +
            `• Use \\n para quebras de linha\n` +
            `• Máximo de 1000 caracteres\n\n` +
            `Digite /cancel para cancelar`,
            { parse_mode: 'Markdown' }
        );
        await ctx.answerCbQuery('Aguardando nova mensagem...');
    });

    // Handler para preview da mensagem
    bot.action('preview_post_purchase', requireAdmin, async (ctx) => {
        try {
            const { rows } = await dbPool.query(
                "SELECT value FROM system_config WHERE key = 'post_purchase_message' AND active = true"
            );

            const message = rows.length > 0 ? rows[0].value : 'Não configurado';

            // Show the message exactly as it will appear (without markdown parsing issues)
            await ctx.reply(
                `👁️ Preview da Mensagem Pós-Compra:\n\n${message}`,
                {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'sys_post_purchase')]
                    ]).reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Preview Post Purchase] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao visualizar mensagem');
        }
    });

    // Handler para resetar mensagem padrão
    bot.action('reset_post_purchase', requireAdmin, async (ctx) => {
        try {
            const defaultMessage = '🎯 *Sucesso na sua compra!*\n\n' +
                'Aproveite seus DePix! Lembre-se:\n' +
                '• DePix é um Real digital soberano\n' +
                '• Você tem controle total dos seus fundos\n' +
                '• Transações rápidas e privadas na Liquid Network\n\n' +
                'Precisa de ajuda? @atlasDAO_support';

            await dbPool.query(
                "UPDATE system_config SET value = $1, updated_at = NOW() WHERE key = 'post_purchase_message'",
                [defaultMessage]
            );

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'POST_PURCHASE_RESET',
                actionDescription: 'Mensagem pós-compra restaurada ao padrão'
            });

            await ctx.answerCbQuery('✅ Mensagem restaurada ao padrão');

            // Reload the menu
            bot.action('sys_post_purchase').trigger(ctx);
        } catch (error) {
            logger.error(`[Reset Post Purchase] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao resetar mensagem');
        }
    });

    // Handler para Segurança
    bot.action('sys_security', requireAdmin, async (ctx) => {
        try {
            const security = await systemManagementService.getSecurityStatus();

            let message = '🛡️ *Status de Segurança*\n\n';
            message += '🔐 *Autenticação:*\n';
            message += `├ Tentativas de login (24h): ${security.loginAttempts || 0}\n`;
            message += `├ Logins bem-sucedidos: ${security.successfulLogins || 0}\n`;
            message += `├ Logins falhados: ${security.failedLogins || 0}\n`;
            message += `└ IPs bloqueados: ${security.blockedIps || 0}\n\n`;

            message += '⚠️ *Ameaças Detectadas:*\n';
            message += `├ Tentativas de SQL Injection: ${security.sqlInjectionAttempts || 0}\n`;
            message += `├ Requisições suspeitas: ${security.suspiciousRequests || 0}\n`;
            message += `├ Rate limit excedido: ${security.rateLimitExceeded || 0}\n`;
            message += `└ Tokens inválidos: ${security.invalidTokens || 0}\n\n`;

            message += '✅ *Proteções Ativas:*\n';
            message += `├ Rate limiting: ${security.rateLimitingEnabled ? '✓' : '✗'}\n`;
            message += `├ Validação de entrada: ${security.inputValidationEnabled ? '✓' : '✗'}\n`;
            message += `├ HTTPS obrigatório: ${security.httpsOnly ? '✓' : '✗'}\n`;
            message += `└ 2FA para admins: ${security.twoFactorEnabled ? '✓' : '✗'}`;

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Atualizar', 'sys_security')],
                    [Markup.button.callback('◀️ Voltar', 'adm_system')]
                ]).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[System Security] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar segurança');
        }
    });

    // Handler para Manutenção
    bot.action('sys_maintenance', requireAdmin, async (ctx) => {
        try {
            // Get current maintenance status from system
            const config = await systemManagementService.getSystemConfig();
            const isMaintenanceActive = config.maintenanceMode || false;

            // Check Redis for the most current status
            let redisStatus = null;
            try {
                redisStatus = await redisClient.get('maintenance_mode');
                if (redisStatus !== null) {
                    isMaintenanceActive = redisStatus === '1' || redisStatus === 'true';
                }
            } catch (e) {
                // Use database status if Redis fails
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(
                    isMaintenanceActive ? '🟢 DESATIVAR Manutenção' : '🔴 ATIVAR Manutenção',
                    'toggle_maintenance'
                )],
                [Markup.button.callback('🔄 Reiniciar Serviços', 'restart_services')],
                [Markup.button.callback('🗑️ Limpar Logs Antigos', 'clean_logs')],
                [Markup.button.callback('🔧 Otimizar Banco', 'optimize_db')],
                [Markup.button.callback('◀️ Voltar', 'adm_system')]
            ]);

            const statusDetails = isMaintenanceActive ?
                '⚠️ **ATENÇÃO: Sistema em manutenção!**\n\n' +
                '🔴 **STATUS: ATIVO**\n' +
                '• Usuários normais estão BLOQUEADOS\n' +
                '• Apenas admins podem usar o bot\n' +
                '• Todas as transações estão suspensas\n\n' +
                '⚡ Clique em "DESATIVAR" para liberar o sistema'
                :
                '✅ **Sistema operacional normal**\n\n' +
                '🟢 **STATUS: INATIVO**\n' +
                '• Todos os usuários podem usar o bot\n' +
                '• Transações funcionando normalmente\n\n' +
                '⚠️ Clique em "ATIVAR" para bloquear usuários não-admin';

            await ctx.editMessageText(
                '🔧 **Modo de Manutenção**\n\n' +
                statusDetails + '\n\n' +
                '**Outras ações disponíveis:**',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[System Maintenance] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao abrir manutenção');
        }
    });

    // Handler para Backups
    bot.action('sys_backup', requireAdmin, async (ctx) => {
        try {
            const backups = await systemManagementService.getBackupStatus();

            let message = '💾 *Gerenciamento de Backups*\n\n';
            message += '📅 *Último Backup:*\n';
            message += `├ Data: ${backups.lastBackup || 'Nunca'}\n`;
            message += `├ Tamanho: ${backups.lastBackupSize || 'N/A'}\n`;
            message += `└ Status: ${backups.lastBackupStatus || 'N/A'}\n\n`;

            message += '⏰ *Próximo Backup:*\n';
            message += `├ Agendado: ${backups.nextBackup || 'N/A'}\n`;
            message += `└ Tipo: ${backups.nextBackupType || 'N/A'}\n\n`;

            message += '📊 *Estatísticas:*\n';
            message += `├ Total de backups: ${backups.totalBackups || 0}\n`;
            message += `├ Backups bem-sucedidos: ${backups.successfulBackups || 0}\n`;
            message += `├ Espaço usado: ${backups.totalSize || 'N/A'}\n`;
            message += `└ Retenção: ${backups.retentionDays || 30} dias`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💾 Fazer Backup Agora', 'backup_now')],
                [Markup.button.callback('📋 Listar Backups', 'list_backups')],
                [Markup.button.callback('⚙️ Configurar', 'backup_config')],
                [Markup.button.callback('◀️ Voltar', 'adm_system')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[System Backup] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar backups');
        }
    });

    // Handler para Buscar por Admin (Auditoria)
    bot.action('audit_by_admin', requireAdmin, async (ctx) => {
        try {
            activeStates.set(ctx.from.id, { action: 'audit_search_admin' });

            await ctx.editMessageText(
                '🔍 *Buscar Logs por Admin*\n\n' +
                'Digite o ID ou username do admin para buscar suas ações.\n\n' +
                'Use /cancel para cancelar',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Audit By Admin] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para Estatísticas de Auditoria
    bot.action('audit_stats', requireAdmin, async (ctx) => {
        try {
            const stats = await auditService.getAuditStatistics();

            let message = '📊 *Estatísticas de Auditoria*\n\n';
            message += '📈 *Ações por Tipo (30 dias):*\n';

            if (stats.actionCounts) {
                for (const [action, count] of Object.entries(stats.actionCounts)) {
                    message += `├ ${action}: ${count}\n`;
                }
            }

            message += '\n👥 *Ações por Admin:*\n';
            if (stats.adminActions) {
                for (const admin of stats.adminActions) {
                    message += `├ ${admin.username || admin.adminId}: ${admin.actionCount} ações\n`;
                }
            }

            message += '\n📅 *Tendências:*\n';
            message += `├ Ações hoje: ${stats.actionsToday || 0}\n`;
            message += `├ Ações esta semana: ${stats.actionsWeek || 0}\n`;
            message += `└ Ações este mês: ${stats.actionsMonth || 0}`;

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_audit')]
                ]).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Audit Stats] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar estatísticas');
        }
    });

    // Handler para Exportar Auditoria
    bot.action('audit_export', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('📤 Preparando exportação de auditoria...');

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📄 CSV', 'audit_export_csv')],
                [Markup.button.callback('📊 JSON', 'audit_export_json')],
                [Markup.button.callback('◀️ Voltar', 'adm_audit')]
            ]);

            await ctx.editMessageText(
                '📤 *Exportar Logs de Auditoria*\n\n' +
                'Escolha o formato de exportação:\n\n' +
                '• *CSV* - Para análise em planilhas\n' +
                '• *JSON* - Para integração com sistemas\n\n' +
                '⚠️ O arquivo será enviado via mensagem privada.',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Audit Export] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao preparar exportação');
        }
    });

    // Handler para Exportar CSV
    bot.action('audit_export_csv', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('📄 Exportando para CSV...');

            const csv = await auditService.exportLogsToCSV();
            const buffer = Buffer.from(csv, 'utf-8');
            const filename = `audit_logs_${new Date().toISOString().split('T')[0]}.csv`;

            await ctx.replyWithDocument({
                source: buffer,
                filename: filename
            }, {
                caption: '📄 Logs de auditoria exportados em formato CSV'
            });

            // Registrar a exportação
            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: AuditService.ActionTypes.DATA_EXPORTED,
                actionDescription: 'Exportou logs de auditoria (CSV)'
            });
        } catch (error) {
            logger.error(`[Audit Export CSV] Erro: ${error.message}`);
            await ctx.reply('❌ Erro ao exportar logs para CSV');
        }
    });

    // Handler para Exportar JSON
    bot.action('audit_export_json', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('📊 Exportando para JSON...');

            const logs = await auditService.getAuditLogs({ limit: 10000 });
            const json = JSON.stringify(logs, null, 2);
            const buffer = Buffer.from(json, 'utf-8');
            const filename = `audit_logs_${new Date().toISOString().split('T')[0]}.json`;

            await ctx.replyWithDocument({
                source: buffer,
                filename: filename
            }, {
                caption: '📊 Logs de auditoria exportados em formato JSON'
            });

            // Registrar a exportação
            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: AuditService.ActionTypes.DATA_EXPORTED,
                actionDescription: 'Exportou logs de auditoria (JSON)'
            });
        } catch (error) {
            logger.error(`[Audit Export JSON] Erro: ${error.message}`);
            await ctx.reply('❌ Erro ao exportar logs para JSON');
        }
    });

    // ========================================
    // HANDLERS DE MANUTENÇÃO
    // ========================================

    // Toggle modo de manutenção
    bot.action('toggle_maintenance', requireAdmin, async (ctx) => {
        try {
            // Immediate visual feedback
            await ctx.answerCbQuery('⏳ Alterando modo de manutenção...');

            // Update message immediately with processing status
            await ctx.editMessageText(
                '⏳ *Processando alteração...*\n\n' +
                'Alterando configuração do modo de manutenção.\n' +
                'Por favor, aguarde...',
                { parse_mode: 'Markdown' }
            );

            // Get current status from the system
            const config = await systemManagementService.getSystemConfig();
            const currentStatus = config.maintenanceMode || false;
            const newStatus = !currentStatus;

            // Set the new maintenance mode
            const result = await systemManagementService.setMaintenanceMode(newStatus,
                newStatus ? 'Sistema em manutenção. Voltaremos em breve!' : null
            );

            // Also update through the MaintenanceMiddleware to ensure immediate effect
            const { MaintenanceMiddleware } = require('../middleware/maintenanceCheck');
            const maintenanceMiddleware = new MaintenanceMiddleware(redisClient, dbPool);
            await maintenanceMiddleware.setMaintenanceMode(newStatus,
                newStatus ? 'Sistema em manutenção. Voltaremos em breve!' : null
            );

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'SYSTEM_MAINTENANCE_TOGGLE',
                actionDescription: `Modo manutenção ${newStatus ? 'ATIVADO' : 'DESATIVADO'}`
            });

            // Notify all admins about the change
            const adminMessage = `⚠️ **ATENÇÃO ADMINS**\n\nModo de manutenção foi ${newStatus ? 'ATIVADO' : 'DESATIVADO'} por @${ctx.from.username || ctx.from.id}\n\n${newStatus ? '🔴 Sistema bloqueado para usuários não-admin' : '🟢 Sistema liberado para todos os usuários'}`;

            for (const adminId of ADMIN_IDS) {
                try {
                    if (adminId !== ctx.from.id) { // Don't notify the admin who made the change
                        await bot.telegram.sendMessage(adminId, adminMessage, { parse_mode: 'Markdown' });
                    }
                } catch (e) {
                    // Ignore send errors
                }
            }

            // Show success message with clear status
            const successMessage = newStatus ?
                '🔴 *MODO MANUTENÇÃO ATIVADO*\n\n' +
                '• Sistema bloqueado para usuários não-admin\n' +
                '• Apenas administradores podem acessar\n' +
                '• Mensagem exibida aos usuários: "Sistema em manutenção"' :
                '🟢 *MODO MANUTENÇÃO DESATIVADO*\n\n' +
                '• Sistema liberado para todos os usuários\n' +
                '• Acesso normal restaurado\n' +
                '• Todas as funcionalidades disponíveis';

            await ctx.editMessageText(successMessage + '\n\n✅ Alteração realizada com sucesso!', {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Atualizar Menu', 'sys_maintenance')],
                    [Markup.button.callback('◀️ Voltar', 'adm_system')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error(`[Toggle Maintenance] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao alterar modo manutenção');
        }
    });

    // Reiniciar serviços
    bot.action('restart_services', requireAdmin, async (ctx) => {
        try {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📡 Redis', 'restart_redis')],
                [Markup.button.callback('🗄️ Banco de Dados', 'restart_database')],
                [Markup.button.callback('🤖 Telegram Bot', 'restart_telegram')],
                [Markup.button.callback('🔄 Aplicação', 'restart_app')],
                [Markup.button.callback('◀️ Voltar', 'sys_maintenance')]
            ]);

            await ctx.editMessageText(
                '🔄 *Reiniciar Serviços*\n\n' +
                '⚠️ *ATENÇÃO:* Reiniciar serviços pode causar interrupção temporária.\n\n' +
                'Escolha o serviço para reiniciar:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Restart Services] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handlers individuais de restart
    bot.action(/restart_(redis|database|telegram|app)/, requireAdmin, async (ctx) => {
        const service = ctx.match[1];
        try {
            await ctx.answerCbQuery(`🔄 Reiniciando ${service}...`);

            await systemManagementService.restartService(service);

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'SYSTEM_SERVICE_RESTART',
                actionDescription: `Serviço ${service} reiniciado`
            });

            await ctx.editMessageText(
                `✅ *Serviço Reiniciado*\n\n` +
                `O serviço *${service}* foi reiniciado com sucesso.\n\n` +
                `⏱️ Timestamp: ${new Date().toLocaleString('pt-BR')}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'restart_services')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Restart ${service}] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao reiniciar');

            await ctx.editMessageText(
                `❌ *Erro ao Reiniciar*\n\n` +
                `Não foi possível reiniciar o serviço *${service}*.\n\n` +
                `Erro: ${error.message}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'restart_services')]
                    ]).reply_markup
                }
            );
        }
    });

    // Limpar logs antigos
    bot.action('clean_logs', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('🗑️ Limpando logs...');

            const deletedCount = await systemManagementService.cleanOldLogs(30);

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'SYSTEM_LOGS_CLEANED',
                actionDescription: `${deletedCount} logs antigos removidos`
            });

            await ctx.editMessageText(
                `✅ *Logs Limpos*\n\n` +
                `🗑️ ${deletedCount} logs antigos foram removidos.\n\n` +
                `Logs com mais de 30 dias foram excluídos.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'sys_maintenance')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Clean Logs] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao limpar logs');
        }
    });

    // Otimizar banco de dados
    bot.action('optimize_db', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('🔧 Otimizando banco...');

            await ctx.editMessageText(
                '🔧 *Otimização em Progresso*\n\n' +
                '⏳ Executando VACUUM e ANALYZE...\n' +
                'Isso pode levar alguns minutos.',
                { parse_mode: 'Markdown' }
            );

            await systemManagementService.optimizeDatabase();

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'SYSTEM_DATABASE_OPTIMIZED',
                actionDescription: 'Banco de dados otimizado (VACUUM + ANALYZE + REINDEX)'
            });

            await ctx.editMessageText(
                `✅ *Banco de Dados Otimizado*\n\n` +
                `As seguintes operações foram executadas:\n` +
                `• VACUUM e ANALYZE em todas as tabelas\n` +
                `• REINDEX das tabelas principais\n` +
                `• Limpeza de conexões idle\n\n` +
                `O banco está otimizado e performando melhor!`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'sys_maintenance')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Optimize DB] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao otimizar');

            await ctx.editMessageText(
                `❌ *Erro na Otimização*\n\n` +
                `Erro: ${error.message}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'sys_maintenance')]
                    ]).reply_markup
                }
            );
        }
    });

    // ========================================
    // HANDLERS DE BACKUP
    // ========================================

    // Criar backup agora
    bot.action('backup_now', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('💾 Criando backup...');

            await ctx.editMessageText(
                '💾 *Criando Backup*\n\n' +
                '⏳ Gerando dump do banco de dados...\n' +
                'Isso pode levar alguns minutos.',
                { parse_mode: 'Markdown' }
            );

            const backup = await systemManagementService.createBackup();

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'SYSTEM_BACKUP_CREATED',
                actionDescription: `Backup criado: ${backup.timestamp} (${Math.round(backup.size / 1024 / 1024)}MB)`
            });

            await ctx.editMessageText(
                `✅ *Backup Criado com Sucesso*\n\n` +
                `📁 Arquivo: \`${path.basename(backup.path)}\`\n` +
                `📊 Tamanho: ${Math.round(backup.size / 1024 / 1024)} MB\n` +
                `🕐 Timestamp: ${backup.timestamp}\n\n` +
                `O backup foi salvo e comprimido.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'sys_backup')]
                    ]).reply_markup
                }
            );
        } catch (error) {
            logger.error(`[Backup Now] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao criar backup');

            await ctx.editMessageText(
                `❌ *Erro ao Criar Backup*\n\n` +
                `Erro: ${error.message}\n\n` +
                `Verifique as permissões e configurações do banco.`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('◀️ Voltar', 'sys_backup')]
                    ]).reply_markup
                }
            );
        }
    });

    // Listar backups
    bot.action('list_backups', requireAdmin, async (ctx) => {
        try {
            await ctx.answerCbQuery('📋 Carregando backups...');

            const backups = await systemManagementService.listBackups();

            let message = '📋 *Lista de Backups*\n\n';

            if (backups.length === 0) {
                message += '_Nenhum backup encontrado_';
            } else {
                for (const backup of backups.slice(0, 10)) {
                    message += `📁 *${backup.name}*\n`;
                    message += `├ Tamanho: ${backup.size} MB\n`;
                    message += `├ Criado: ${backup.created.toLocaleDateString('pt-BR')} ${backup.created.toLocaleTimeString('pt-BR')}\n`;
                    message += `└ Idade: ${backup.age} dias\n\n`;
                }

                if (backups.length > 10) {
                    message += `_...e mais ${backups.length - 10} backups_`;
                }
            }

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'sys_backup')]
                ]).reply_markup
            });
        } catch (error) {
            logger.error(`[List Backups] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao listar backups');
        }
    });

    // Configurar backups
    bot.action('backup_config', requireAdmin, async (ctx) => {
        try {
            // Get current backup configuration
            const config = await systemManagementService.getSystemConfig();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(
                    `${config.autoBackup ? '✅' : '❌'} Backup Automático`,
                    'toggle_auto_backup'
                )],
                [Markup.button.callback('📅 Configurar Agendamento', 'set_backup_schedule')],
                [Markup.button.callback('📦 Período de Retenção: 30 dias', 'set_retention_period')],
                [Markup.button.callback('🔄 Executar Backup Agora', 'backup_now')],
                [Markup.button.callback('◀️ Voltar', 'sys_backup')]
            ]);

            await ctx.editMessageText(
                '⚙️ *Configuração de Backups*\n\n' +
                `• **Backup Automático:** ${config.autoBackup ? '✅ Ativado' : '❌ Desativado'}\n` +
                `• **Último Backup:** ${config.lastBackup ? new Date(config.lastBackup).toLocaleDateString('pt-BR') : 'Nunca'}\n` +
                `• **Próximo Backup:** ${config.nextBackup ? new Date(config.nextBackup).toLocaleDateString('pt-BR') : 'Não agendado'}\n` +
                `• **Retenção:** 30 dias\n` +
                `• **Local:** ./backups/\n\n` +
                'Clique nas opções abaixo para configurar:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Backup Config] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar configurações');
        }
    });

    // Handler para toggle de backup automático
    bot.action('toggle_auto_backup', requireAdmin, async (ctx) => {
        try {
            const newValue = await systemManagementService.toggleConfig('autoBackup');

            await auditService.logAdminAction({
                adminId: ctx.from.id,
                adminUsername: ctx.from.username,
                actionType: 'CONFIG_TOGGLED',
                actionDescription: `Backup automático ${newValue ? 'ativado' : 'desativado'}`
            });

            await ctx.answerCbQuery(`✅ Backup automático ${newValue ? 'ativado' : 'desativado'}`);

            // Refresh the backup config screen
            return bot.handleUpdate({
                ...ctx.update,
                callback_query: { ...ctx.callbackQuery, data: 'backup_config' }
            });
        } catch (error) {
            logger.error(`[Toggle Auto Backup] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao alterar configuração');
        }
    });

    // Handler para configurar agendamento de backup
    bot.action('set_backup_schedule', requireAdmin, async (ctx) => {
        try {
            await ctx.editMessageText(
                '📅 *Configurar Agendamento de Backup*\n\n' +
                'Escolha a frequência dos backups automáticos:\n\n' +
                '• Diário: Todo dia às 3:00 AM\n' +
                '• Semanal: Toda segunda-feira às 3:00 AM\n' +
                '• Mensal: Todo dia 1 às 3:00 AM',
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('📅 Diário', 'schedule_daily')],
                        [Markup.button.callback('📅 Semanal', 'schedule_weekly')],
                        [Markup.button.callback('📅 Mensal', 'schedule_monthly')],
                        [Markup.button.callback('◀️ Voltar', 'backup_config')]
                    ]).reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Set Backup Schedule] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler para definir período de retenção
    bot.action('set_retention_period', requireAdmin, async (ctx) => {
        try {
            await ctx.editMessageText(
                '📦 *Período de Retenção de Backups*\n\n' +
                'Escolha por quanto tempo manter os backups:\n\n' +
                'Backups mais antigos serão removidos automaticamente.',
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('7 dias', 'retention_7')],
                        [Markup.button.callback('15 dias', 'retention_15')],
                        [Markup.button.callback('30 dias', 'retention_30')],
                        [Markup.button.callback('60 dias', 'retention_60')],
                        [Markup.button.callback('90 dias', 'retention_90')],
                        [Markup.button.callback('◀️ Voltar', 'backup_config')]
                    ]).reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Set Retention Period] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // ========================================
    // MENU DE SAQUES (DePix → PIX)
    // ========================================

    // Inicializar serviço de saques
    const withdrawalService = new WithdrawalService(dbPool, bot);

    // Menu principal de saques
    bot.action('adm_withdrawals', requireAdmin, async (ctx) => {
        try {
            const statsToday = await withdrawalService.getStatsToday();
            const statsMonth = await withdrawalService.getStatsMonth();
            const pending = await withdrawalService.getPendingForProcessing();

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📊 Dashboard Detalhado', 'wd_dashboard')],
                [Markup.button.callback(`🔔 Prontos (${pending.length})`, 'wd_ready')],
                [Markup.button.callback('⏳ Aguardando Pagamento', 'wd_awaiting')],
                [Markup.button.callback('✅ Histórico Processados', 'wd_history')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            // Calcular lucro (2.5% - 1% Eulen = 1.5% + taxa de rede)
            const profitToday = parseFloat(statsToday.total_profit || 0);
            const profitMonth = parseFloat(statsMonth.total_profit || 0);

            await ctx.editMessageText(
                `💰 *Saques DePix → PIX*\n\n` +
                `📊 *Resumo Hoje:*\n` +
                `├ Processados: ${statsToday.completed_count || 0}\n` +
                `├ Volume: R$ ${parseFloat(statsToday.total_volume || 0).toFixed(2)}\n` +
                `├ Taxas: R$ ${parseFloat(statsToday.total_fees || 0).toFixed(2)}\n` +
                `└ Lucro: R$ ${profitToday.toFixed(2)}\n\n` +
                `📅 *Resumo Mês:*\n` +
                `├ Processados: ${statsMonth.completed_count || 0}\n` +
                `├ Volume: R$ ${parseFloat(statsMonth.total_volume || 0).toFixed(2)}\n` +
                `├ Taxas: R$ ${parseFloat(statsMonth.total_fees || 0).toFixed(2)}\n` +
                `└ Lucro: R$ ${profitMonth.toFixed(2)}\n\n` +
                `🔔 *Aguardando Ação:* ${pending.length} saques prontos\n\n` +
                `Selecione uma opção:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Withdrawals] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar menu de saques');
        }
    });

    // Dashboard detalhado
    bot.action('wd_dashboard', requireAdmin, async (ctx) => {
        try {
            const statsToday = await withdrawalService.getStatsToday();
            const statsMonth = await withdrawalService.getStatsMonth();

            // Buscar estatísticas adicionais
            const additionalStats = await dbPool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status = 'AWAITING_PAYMENT') as awaiting_count,
                    COUNT(*) FILTER (WHERE status = 'PAYMENT_DETECTED') as detected_count,
                    COUNT(*) FILTER (WHERE status = 'PROCESSING') as processing_count,
                    COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed_count,
                    COUNT(*) FILTER (WHERE status = 'EXPIRED') as expired_count,
                    COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_count,
                    COUNT(DISTINCT telegram_user_id) FILTER (WHERE status = 'COMPLETED') as unique_users,
                    AVG(requested_pix_amount) FILTER (WHERE status = 'COMPLETED') as avg_amount
                FROM withdrawal_transactions
                WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
            `);
            const stats = additionalStats.rows[0];

            // Lucro detalhado
            // Receita = taxa 2.5% + taxa de rede
            // Custo = 1% Eulen + taxa de rede real
            // Lucro = 1.5% do valor + diferença de taxas de rede
            const revenueToday = parseFloat(statsToday.total_fees || 0);
            const eulenCostToday = parseFloat(statsToday.total_volume || 0) * 0.01;
            const networkCostToday = parseFloat(statsToday.total_network_fees || 0) * 0.7; // Estimativa custo real
            const profitToday = revenueToday - eulenCostToday - networkCostToday;

            const revenueMonth = parseFloat(statsMonth.total_fees || 0);
            const eulenCostMonth = parseFloat(statsMonth.total_volume || 0) * 0.01;
            const networkCostMonth = parseFloat(statsMonth.total_network_fees || 0) * 0.7;
            const profitMonth = revenueMonth - eulenCostMonth - networkCostMonth;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Atualizar', 'wd_dashboard')],
                [Markup.button.callback('◀️ Voltar', 'adm_withdrawals')]
            ]);

            await ctx.editMessageText(
                `📊 *Dashboard de Saques*\n\n` +
                `💵 *Hoje:*\n` +
                `├ Processados: ${statsToday.completed_count || 0}\n` +
                `├ Volume PIX: R$ ${parseFloat(statsToday.total_volume || 0).toFixed(2)}\n` +
                `├ Taxa 2.5%: R$ ${parseFloat(statsToday.total_our_fees || 0).toFixed(2)}\n` +
                `├ Taxa Rede: R$ ${parseFloat(statsToday.total_network_fees || 0).toFixed(2)}\n` +
                `├ Receita Total: R$ ${revenueToday.toFixed(2)}\n` +
                `├ Custo Eulen (1%): R$ ${eulenCostToday.toFixed(2)}\n` +
                `└ *Lucro Líquido:* R$ ${profitToday.toFixed(2)}\n\n` +
                `📅 *Este Mês:*\n` +
                `├ Processados: ${statsMonth.completed_count || 0}\n` +
                `├ Volume PIX: R$ ${parseFloat(statsMonth.total_volume || 0).toFixed(2)}\n` +
                `├ Taxa 2.5%: R$ ${parseFloat(statsMonth.total_our_fees || 0).toFixed(2)}\n` +
                `├ Taxa Rede: R$ ${parseFloat(statsMonth.total_network_fees || 0).toFixed(2)}\n` +
                `├ Receita Total: R$ ${revenueMonth.toFixed(2)}\n` +
                `├ Custo Eulen (1%): R$ ${eulenCostMonth.toFixed(2)}\n` +
                `└ *Lucro Líquido:* R$ ${profitMonth.toFixed(2)}\n\n` +
                `📈 *Status do Mês:*\n` +
                `├ Aguardando: ${stats.awaiting_count || 0}\n` +
                `├ Detectados: ${stats.detected_count || 0}\n` +
                `├ Processando: ${stats.processing_count || 0}\n` +
                `├ Completados: ${stats.completed_count || 0}\n` +
                `├ Expirados: ${stats.expired_count || 0}\n` +
                `├ Cancelados: ${stats.cancelled_count || 0}\n` +
                `├ Usuários únicos: ${stats.unique_users || 0}\n` +
                `└ Ticket médio: R$ ${parseFloat(stats.avg_amount || 0).toFixed(2)}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Withdrawal Dashboard] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar dashboard');
        }
    });

    // Lista de saques prontos para processar
    bot.action('wd_ready', requireAdmin, async (ctx) => {
        try {
            const pending = await withdrawalService.getPendingForProcessing();

            if (pending.length === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Atualizar', 'wd_ready')],
                    [Markup.button.callback('◀️ Voltar', 'adm_withdrawals')]
                ]);

                await ctx.editMessageText(
                    `🔔 *Saques Prontos para Processar*\n\n` +
                    `✅ Nenhum saque pendente no momento!\n\n` +
                    `Quando um usuário enviar DePix, o saque aparecerá aqui automaticamente.`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard.reply_markup
                    }
                );
                await ctx.answerCbQuery();
                return;
            }

            let message = `🔔 *Saques Prontos (${pending.length})*\n\n`;
            const buttons = [];

            for (const wd of pending.slice(0, 10)) {
                const createdAt = new Date(wd.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                message += `💵 *R$ ${parseFloat(wd.requested_pix_amount).toFixed(2)}*\n`;
                message += `├ ID: \`${wd.withdrawal_id.substring(0, 8)}...\`\n`;
                message += `├ PIX: ${wd.pix_key_type}\n`;
                message += `├ Usuário: ${wd.telegram_user_id}\n`;
                message += `└ ${createdAt}\n\n`;

                buttons.push([
                    Markup.button.callback(
                        `💵 R$ ${parseFloat(wd.requested_pix_amount).toFixed(2)} - Ver`,
                        `wd_view:${wd.withdrawal_id}`
                    )
                ]);
            }

            if (pending.length > 10) {
                message += `\n_...e mais ${pending.length - 10} saques_`;
            }

            buttons.push([Markup.button.callback('🔄 Atualizar', 'wd_ready')]);
            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_withdrawals')]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Withdrawal Ready] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar saques');
        }
    });

    // Lista de saques aguardando pagamento
    bot.action('wd_awaiting', requireAdmin, async (ctx) => {
        try {
            const result = await dbPool.query(`
                SELECT w.*, u.telegram_username
                FROM withdrawal_transactions w
                LEFT JOIN users u ON w.telegram_user_id = u.telegram_user_id
                WHERE w.status = 'AWAITING_PAYMENT'
                ORDER BY w.created_at DESC
                LIMIT 20
            `);

            if (result.rows.length === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Atualizar', 'wd_awaiting')],
                    [Markup.button.callback('◀️ Voltar', 'adm_withdrawals')]
                ]);

                await ctx.editMessageText(
                    `⏳ *Aguardando Pagamento*\n\n` +
                    `Nenhum saque aguardando depósito DePix.`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard.reply_markup
                    }
                );
                await ctx.answerCbQuery();
                return;
            }

            let message = `⏳ *Aguardando Pagamento (${result.rows.length})*\n\n`;

            for (const wd of result.rows.slice(0, 10)) {
                const createdAt = new Date(wd.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                const expiresAt = new Date(wd.expires_at);
                const now = new Date();
                const minutesLeft = Math.max(0, Math.floor((expiresAt - now) / 60000));

                message += `💵 R$ ${parseFloat(wd.requested_pix_amount).toFixed(2)}\n`;
                message += `├ @${wd.telegram_username || wd.telegram_user_id}\n`;
                message += `├ DePix: ${parseFloat(wd.total_depix_required).toFixed(2)}\n`;
                message += `├ Expira em: ${minutesLeft} min\n`;
                message += `└ ${createdAt}\n\n`;
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Atualizar', 'wd_awaiting')],
                [Markup.button.callback('◀️ Voltar', 'adm_withdrawals')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Withdrawal Awaiting] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar saques');
        }
    });

    // Histórico de saques processados
    bot.action(/wd_history(?:_(\d+))?/, requireAdmin, async (ctx) => {
        try {
            const page = parseInt(ctx.match[1] || '0');
            const limit = 10;
            const offset = page * limit;

            const result = await dbPool.query(`
                SELECT w.*, u.telegram_username,
                    (SELECT COUNT(*) FROM withdrawal_transactions WHERE status = 'COMPLETED') as total_count
                FROM withdrawal_transactions w
                LEFT JOIN users u ON w.telegram_user_id = u.telegram_user_id
                WHERE w.status = 'COMPLETED'
                ORDER BY w.actual_completion_at DESC
                LIMIT $1 OFFSET $2
            `, [limit, offset]);

            if (result.rows.length === 0 && page === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_withdrawals')]
                ]);

                await ctx.editMessageText(
                    `✅ *Histórico de Saques*\n\n` +
                    `Nenhum saque processado ainda.`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard.reply_markup
                    }
                );
                await ctx.answerCbQuery();
                return;
            }

            const totalCount = parseInt(result.rows[0]?.total_count || 0);
            const totalPages = Math.ceil(totalCount / limit);

            let message = `✅ *Histórico de Saques (Página ${page + 1}/${totalPages || 1})*\n\n`;

            for (const wd of result.rows) {
                const completedAt = new Date(wd.actual_completion_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                message += `💵 R$ ${parseFloat(wd.requested_pix_amount).toFixed(2)}\n`;
                message += `├ @${wd.telegram_username || wd.telegram_user_id}\n`;
                message += `├ PIX: ${wd.pix_key_type}\n`;
                message += `└ ${completedAt}\n\n`;
            }

            const buttons = [];
            const navButtons = [];

            if (page > 0) {
                navButtons.push(Markup.button.callback('⬅️', `wd_history_${page - 1}`));
            }
            navButtons.push(Markup.button.callback(`${page + 1}/${totalPages || 1}`, 'noop'));
            if (page < totalPages - 1) {
                navButtons.push(Markup.button.callback('➡️', `wd_history_${page + 1}`));
            }

            if (navButtons.length > 1) {
                buttons.push(navButtons);
            }
            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_withdrawals')]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Withdrawal History] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar histórico');
        }
    });

    // Ver detalhes de um saque específico
    bot.action(/wd_view:(.+)/, requireAdmin, async (ctx) => {
        try {
            const withdrawalId = ctx.match[1];

            const result = await dbPool.query(`
                SELECT w.*, u.telegram_username, u.telegram_full_name
                FROM withdrawal_transactions w
                LEFT JOIN users u ON w.telegram_user_id = u.telegram_user_id
                WHERE w.withdrawal_id = $1
            `, [withdrawalId]);

            if (result.rows.length === 0) {
                await ctx.answerCbQuery('❌ Saque não encontrado');
                return;
            }

            const wd = result.rows[0];
            const createdAt = new Date(wd.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            const detectedAt = wd.liquid_payment_detected_at ?
                new Date(wd.liquid_payment_detected_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'N/A';

            // Formatar chave PIX para exibição
            let pixKeyDisplay = wd.pix_key_value;
            if (wd.pix_key_type === 'CPF') {
                pixKeyDisplay = wd.pix_key_value; // Já está formatado
            }

            // Comando para Eulen
            const eulenCommand = `/withdraw ${parseFloat(wd.requested_pix_amount).toFixed(2)} ${wd.pix_key_value}`;

            let message = `💰 *Detalhes do Saque*\n\n`;
            message += `📋 *ID:* \`${wd.withdrawal_id}\`\n`;
            message += `📊 *Status:* ${getStatusEmoji(wd.status)} ${wd.status}\n\n`;
            message += `👤 *Usuário:*\n`;
            message += `├ ID: ${wd.telegram_user_id}\n`;
            message += `├ Username: @${wd.telegram_username || 'N/A'}\n`;
            message += `└ Nome: ${wd.telegram_full_name || 'N/A'}\n\n`;
            message += `💵 *Valores:*\n`;
            message += `├ PIX Solicitado: R$ ${parseFloat(wd.requested_pix_amount).toFixed(2)}\n`;
            message += `├ Taxa (2.5%): R$ ${parseFloat(wd.our_fee_amount).toFixed(2)}\n`;
            message += `├ Taxa Rede: R$ ${parseFloat(wd.network_fee_amount).toFixed(2)}\n`;
            message += `└ Total DePix: ${parseFloat(wd.total_depix_required).toFixed(2)}\n\n`;
            message += `🔑 *Chave PIX:*\n`;
            message += `├ Tipo: ${wd.pix_key_type}\n`;
            message += `└ Valor: \`${pixKeyDisplay}\`\n\n`;
            message += `📍 *Endereço Liquid:*\n`;
            message += `\`${wd.deposit_address}\`\n\n`;

            if (wd.liquid_txid) {
                message += `🔗 *TX Liquid:*\n`;
                message += `\`${wd.liquid_txid}\`\n\n`;
            }

            message += `📅 *Datas:*\n`;
            message += `├ Criado: ${createdAt}\n`;
            message += `└ Detectado: ${detectedAt}\n\n`;

            if (wd.status === 'PAYMENT_DETECTED') {
                message += `📋 *Comando Eulen:*\n`;
                message += `\`${eulenCommand}\``;
            }

            const buttons = [];

            if (wd.status === 'PAYMENT_DETECTED') {
                buttons.push([
                    Markup.button.callback('📋 Copiar Comando', `wd_copy:${wd.withdrawal_id}`),
                    Markup.button.callback('✅ Marcar Processado', `wd_complete:${wd.withdrawal_id}`)
                ]);
            }

            buttons.push([Markup.button.callback('◀️ Voltar', 'wd_ready')]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Withdrawal View] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar detalhes');
        }
    });

    // Copiar comando Eulen (envia como mensagem para fácil cópia)
    bot.action(/wd_copy:(.+)/, requireAdmin, async (ctx) => {
        try {
            const withdrawalId = ctx.match[1];

            const result = await dbPool.query(`
                SELECT requested_pix_amount, pix_key_value
                FROM withdrawal_transactions
                WHERE withdrawal_id = $1
            `, [withdrawalId]);

            if (result.rows.length === 0) {
                await ctx.answerCbQuery('❌ Saque não encontrado');
                return;
            }

            const wd = result.rows[0];
            const eulenCommand = `/withdraw ${parseFloat(wd.requested_pix_amount).toFixed(2)} ${wd.pix_key_value}`;

            // Enviar comando como mensagem separada para fácil cópia
            await ctx.reply(
                `📋 Comando para Eulen:\n\n\`${eulenCommand}\``,
                { parse_mode: 'Markdown' }
            );

            await ctx.answerCbQuery('📋 Comando enviado!');
        } catch (error) {
            logger.error(`[Withdrawal Copy] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Marcar saque como processado
    bot.action(/wd_complete:(.+)/, requireAdmin, async (ctx) => {
        try {
            const withdrawalId = ctx.match[1];
            const adminId = ctx.from.id;

            await withdrawalService.markAsProcessed(withdrawalId, adminId);

            // Registrar ação de auditoria
            await auditService.logAdminAction({
                adminId: adminId,
                adminUsername: ctx.from.username,
                actionType: 'WITHDRAWAL_PROCESSED',
                actionDescription: `Saque ${withdrawalId} marcado como processado`
            });

            await ctx.answerCbQuery('✅ Saque marcado como processado!');

            // Atualizar a view para mostrar próximo ou voltar à lista
            const pending = await withdrawalService.getPendingForProcessing();

            if (pending.length > 0) {
                // Mostrar próximo saque
                ctx.match = [`wd_view:${pending[0].withdrawal_id}`, pending[0].withdrawal_id];

                // Recarregar a lista
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback(`Ver próximo (${pending.length} restantes)`, `wd_view:${pending[0].withdrawal_id}`)],
                    [Markup.button.callback('◀️ Voltar à lista', 'wd_ready')]
                ]);

                await ctx.editMessageText(
                    `✅ *Saque Processado!*\n\n` +
                    `O saque foi marcado como concluído.\n\n` +
                    `📊 Restam ${pending.length} saques para processar.`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard.reply_markup
                    }
                );
            } else {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_withdrawals')]
                ]);

                await ctx.editMessageText(
                    `✅ *Saque Processado!*\n\n` +
                    `O saque foi marcado como concluído.\n\n` +
                    `🎉 Todos os saques foram processados!`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard.reply_markup
                    }
                );
            }
        } catch (error) {
            logger.error(`[Withdrawal Complete] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao processar');
        }
    });

    // Helper para emoji de status
    function getStatusEmoji(status) {
        const emojis = {
            'AWAITING_PAYMENT': '⏳',
            'PAYMENT_DETECTED': '🔔',
            'PROCESSING': '⚙️',
            'COMPLETED': '✅',
            'EXPIRED': '⌛',
            'CANCELLED': '❌',
            'FAILED': '💥'
        };
        return emojis[status] || '❓';
    }

    // ========================================
    // MENU DE BOUNTIES
    // ========================================
    bot.action('adm_bounties', requireAdmin, async (ctx) => {
        try {
            const stats = await bountyService.getBountyStats();
            const pendingCount = stats.pending_review?.count || 0;
            const approvedCount = stats.approved?.count || 0;
            const takenCount = stats.taken?.count || 0;
            const inDevCount = stats.in_development?.count || 0;
            const completedCount = stats.completed?.count || 0;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback(`📋 Pendentes (${pendingCount})`, 'bounty_pending')],
                [Markup.button.callback(`✅ Aprovados (${approvedCount})`, 'bounty_approved')],
                [Markup.button.callback(`👷 Claims Pendentes (${takenCount})`, 'bounty_taken')],
                [Markup.button.callback(`🔨 Em Desenvolvimento (${inDevCount})`, 'bounty_in_dev')],
                [Markup.button.callback(`💰 Completados (${completedCount})`, 'bounty_completed')],
                [Markup.button.callback('📊 Estatísticas', 'bounty_stats')],
                [Markup.button.callback('➕ Criar Projeto', 'bounty_create')],
                [Markup.button.callback('◀️ Voltar', 'adm_main')]
            ]);

            const totalBrl = Object.values(stats).reduce((sum, s) => sum + (s.total_brl || 0), 0);
            const totalVotes = Object.values(stats).reduce((sum, s) => sum + (s.vote_count || 0), 0);

            await ctx.editMessageText(
                `🎯 *Projetos & Recompensas*\n\n` +
                `A Atlas é sustentada por contribuições. Aqui você pode apoiar projetos específicos ou assumir trabalhos e ser remunerado por isso.\n\n` +
                `💰 *Contribuir* — Financie projetos que você quer ver prontos\n` +
                `🛠️ *Trabalhar* — Execute projetos e receba a recompensa\n\n` +
                `📊 ${approvedCount} abertos · ${inDevCount} em andamento · R$ ${totalBrl.toFixed(2)} arrecadados`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Admin Bounties] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar menu de bounties');
        }
    });

    // Listar bounties pendentes de aprovação
    bot.action('bounty_pending', requireAdmin, async (ctx) => {
        try {
            const bounties = await bountyService.listBounties('pending_review', 10);

            if (bounties.length === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_bounties')]
                ]);
                await ctx.editMessageText(
                    '📋 *Projetos Pendentes*\n\n' +
                    '✅ Nenhum projeto pendente de aprovação.',
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
                return ctx.answerCbQuery();
            }

            const buttons = bounties.map(b => [
                Markup.button.callback(`📝 ${b.title.substring(0, 30)}...`, `bounty_review:${b.id}`)
            ]);
            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_bounties')]);

            await ctx.editMessageText(
                `📋 *Projetos Pendentes (${bounties.length})*\n\n` +
                `Clique em um projeto para revisar:`,
                { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Pending] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Revisar bounty específico
    bot.action(/^bounty_review:(\d+)$/, requireAdmin, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            const bounty = await bountyService.getBountyById(bountyId);

            if (!bounty) {
                return ctx.answerCbQuery('❌ Bounty não encontrado');
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Aprovar', `bounty_approve:${bountyId}`)],
                [Markup.button.callback('❌ Rejeitar', `bounty_reject:${bountyId}`)],
                [Markup.button.callback('◀️ Voltar', 'bounty_pending')]
            ]);

            const createdAt = new Date(bounty.created_at).toLocaleString('pt-BR');

            const creatorDisplay = bounty.creator_username
                ? `@${escapeMarkdownV2(bounty.creator_username)}`
                : bounty.creator_telegram_id;

            await ctx.editMessageText(
                `📝 *Revisar Bounty \\#${bountyId}*\n\n` +
                `*Título:* ${escapeMarkdownV2(bounty.title)}\n\n` +
                `*Descrição:*\n${escapeMarkdownV2(bounty.short_description)}\n\n` +
                `👤 *Criado por:* ${creatorDisplay}\n` +
                `📅 *Data:* ${escapeMarkdownV2(createdAt)}`,
                { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Review] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro ao carregar bounty');
        }
    });

    // Aprovar bounty
    bot.action(/^bounty_approve:(\d+)$/, requireAdmin, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            await bountyService.approveBounty(bountyId, ctx.from.id);

            await ctx.editMessageText(
                `✅ *Bounty #${bountyId} Aprovado!*\n\n` +
                `O bounty agora está disponível para votação.`,
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery('✅ Aprovado!');
        } catch (error) {
            logger.error(`[Bounty Approve] Erro: ${error.message}`);
            await ctx.answerCbQuery(`❌ ${error.message}`);
        }
    });

    // Rejeitar bounty
    bot.action(/^bounty_reject:(\d+)$/, requireAdmin, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            await bountyService.rejectBounty(bountyId, ctx.from.id, 'Rejeitado pelo admin');

            await ctx.editMessageText(
                `❌ *Bounty #${bountyId} Rejeitado*\n\n` +
                `O criador foi notificado.`,
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery('❌ Rejeitado');
        } catch (error) {
            logger.error(`[Bounty Reject] Erro: ${error.message}`);
            await ctx.answerCbQuery(`❌ ${error.message}`);
        }
    });

    // Listar bounties aprovadas
    bot.action('bounty_approved', requireAdmin, async (ctx) => {
        try {
            const bounties = await bountyService.listBounties('approved', 10);

            if (bounties.length === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_bounties')]
                ]);
                await ctx.editMessageText(
                    '✅ *Projetos Aprovados*\n\n' +
                    'Nenhum projeto aprovado no momento.',
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
                return ctx.answerCbQuery();
            }

            let text = '✅ *Projetos Aprovados*\n\n';
            for (const b of bounties) {
                text += `*\\#${b.ranking || '\\-'}* ${escapeMarkdownV2(b.title.substring(0, 25))}\n`;
                text += `└ R\\$ ${parseFloat(b.total_brl || 0).toFixed(2).replace('.', '\\.')} \\| ${b.vote_count || 0} votos\n\n`;
            }

            const buttons = bounties.map(b => [
                Markup.button.callback(`🗑️ Remover`, `bounty_remove:${b.id}`)
            ]);
            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_bounties')]);

            await ctx.editMessageText(text, {
                parse_mode: 'MarkdownV2',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Approved] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Remover bounty
    bot.action(/^bounty_remove:(\d+)$/, requireAdmin, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            await bountyService.removeBounty(bountyId, ctx.from.id);

            await ctx.answerCbQuery('✅ Bounty removido');
            // Recarregar lista
            await ctx.editMessageText('🗑️ Bounty removido. Voltando...', { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`[Bounty Remove] Erro: ${error.message}`);
            await ctx.answerCbQuery(`❌ ${error.message}`);
        }
    });

    // Listar claims pendentes (status: taken)
    bot.action('bounty_taken', requireAdmin, async (ctx) => {
        try {
            const bounties = await bountyService.listBounties('taken', 10);

            if (bounties.length === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_bounties')]
                ]);
                await ctx.editMessageText(
                    '👷 *Claims Pendentes*\n\n' +
                    'Nenhum claim de desenvolvedor pendente.',
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
                return ctx.answerCbQuery();
            }

            let text = '👷 *Claims Pendentes de Aprovação*\n\n';
            const buttons = [];
            for (const b of bounties) {
                const devDisplay = b.developer_username
                    ? `@${escapeMarkdownV2(b.developer_username)}`
                    : b.developer_telegram_id;
                text += `📝 *${escapeMarkdownV2(b.title.substring(0, 30))}*\n`;
                text += `├ Dev: ${devDisplay}\n`;
                text += `└ Valor: R\\$ ${parseFloat(b.total_brl || 0).toFixed(2).replace('.', '\\.')}\n\n`;
                buttons.push([
                    Markup.button.callback(`✅ Aprovar #${b.id}`, `bounty_approve_dev:${b.id}`),
                    Markup.button.callback(`❌ Recusar`, `bounty_reject_dev:${b.id}`)
                ]);
            }
            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_bounties')]);

            await ctx.editMessageText(text, {
                parse_mode: 'MarkdownV2',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Taken] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Aprovar claim de desenvolvedor
    bot.action(/^bounty_approve_dev:(\d+)$/, requireAdmin, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            await bountyService.approveDevClaim(bountyId, ctx.from.id);
            await ctx.answerCbQuery('✅ Desenvolvedor aprovado!');
            await ctx.editMessageText('✅ Desenvolvedor aprovado para o bounty!', { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`[Bounty Approve Dev] Erro: ${error.message}`);
            await ctx.answerCbQuery(`❌ ${error.message}`);
        }
    });

    // Rejeitar claim de desenvolvedor
    bot.action(/^bounty_reject_dev:(\d+)$/, requireAdmin, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            await bountyService.rejectDevClaim(bountyId, ctx.from.id);
            await ctx.answerCbQuery('❌ Claim recusado');
            await ctx.editMessageText('❌ Claim do desenvolvedor foi recusado. O bounty voltou para status aprovado.', { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`[Bounty Reject Dev] Erro: ${error.message}`);
            await ctx.answerCbQuery(`❌ ${error.message}`);
        }
    });

    // Listar bounties em desenvolvimento
    bot.action('bounty_in_dev', requireAdmin, async (ctx) => {
        try {
            const bounties = await bountyService.listBounties('in_development', 10);

            if (bounties.length === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_bounties')]
                ]);
                await ctx.editMessageText(
                    '🔨 *Em Desenvolvimento*\n\n' +
                    'Nenhum bounty em desenvolvimento.',
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
                return ctx.answerCbQuery();
            }

            let text = '🔨 *Recompensas Em Desenvolvimento*\n\n';
            for (const b of bounties) {
                const startedAt = b.developer_approved_at ? new Date(b.developer_approved_at).toLocaleDateString('pt-BR') : 'N/A';
                const devDisplay = b.developer_username
                    ? `@${escapeMarkdownV2(b.developer_username)}`
                    : b.developer_telegram_id;
                text += `📝 *${escapeMarkdownV2(b.title.substring(0, 30))}*\n`;
                text += `├ Dev: ${devDisplay}\n`;
                text += `├ Início: ${escapeMarkdownV2(startedAt)}\n`;
                text += `└ Valor: R\\$ ${parseFloat(b.total_brl || 0).toFixed(2).replace('.', '\\.')}\n\n`;
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Voltar', 'adm_bounties')]
            ]);

            await ctx.editMessageText(text, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty In Dev] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Listar bounties completadas (aguardando pagamento)
    bot.action('bounty_completed', requireAdmin, async (ctx) => {
        try {
            const bounties = await bountyService.listBounties('completed', 10);

            if (bounties.length === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_bounties')]
                ]);
                await ctx.editMessageText(
                    '💰 *Completadas (Aguardando Pagamento)*\n\n' +
                    'Nenhum bounty aguardando pagamento.',
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
                return ctx.answerCbQuery();
            }

            let text = '💰 *Recompensas Completadas*\n\n';
            const buttons = [];
            for (const b of bounties) {
                const devDisplay = b.developer_username
                    ? `@${escapeMarkdownV2(b.developer_username)}`
                    : b.developer_telegram_id;
                text += `📝 *${escapeMarkdownV2(b.title.substring(0, 30))}*\n`;
                text += `├ Dev: ${devDisplay}\n`;
                text += `└ Valor: R\\$ ${parseFloat(b.total_brl || 0).toFixed(2).replace('.', '\\.')}\n\n`;
                buttons.push([Markup.button.callback(`💵 Marcar como Pago`, `bounty_mark_paid:${b.id}`)]);
            }
            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_bounties')]);

            await ctx.editMessageText(text, {
                parse_mode: 'MarkdownV2',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Completed] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Marcar bounty como pago
    bot.action(/^bounty_mark_paid:(\d+)$/, requireAdmin, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            await bountyService.markAsPaid(bountyId, ctx.from.id);
            await ctx.answerCbQuery('✅ Marcado como pago!');
            await ctx.editMessageText('💵 Bounty marcado como pago! O desenvolvedor foi notificado.', { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`[Bounty Mark Paid] Erro: ${error.message}`);
            await ctx.answerCbQuery(`❌ ${error.message}`);
        }
    });

    // Estatísticas de bounties
    bot.action('bounty_stats', requireAdmin, async (ctx) => {
        try {
            const stats = await bountyService.getBountyStats();

            const totalBounties = Object.values(stats).reduce((sum, s) => sum + (s.count || 0), 0);
            const totalBrl = Object.values(stats).reduce((sum, s) => sum + (s.total_brl || 0), 0);
            const totalVotes = Object.values(stats).reduce((sum, s) => sum + (s.vote_count || 0), 0);

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Voltar', 'adm_bounties')]
            ]);

            await ctx.editMessageText(
                `📊 *Estatísticas de Projetos*\n\n` +
                `*Por Status:*\n` +
                `├ Pendentes: ${stats.pending_review?.count || 0}\n` +
                `├ Aprovadas: ${stats.approved?.count || 0}\n` +
                `├ Taken: ${stats.taken?.count || 0}\n` +
                `├ Em Dev: ${stats.in_development?.count || 0}\n` +
                `├ Completadas: ${stats.completed?.count || 0}\n` +
                `├ Pagas: ${stats.paid?.count || 0}\n` +
                `└ Rejeitadas: ${stats.rejected?.count || 0}\n\n` +
                `*Totais:*\n` +
                `├ Total projetos: ${totalBounties}\n` +
                `├ Total votos: ${totalVotes}\n` +
                `└ Total arrecadado: R$ ${totalBrl.toFixed(2)}`,
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Stats] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Criar bounty (admin)
    bot.action('bounty_create', requireAdmin, async (ctx) => {
        try {
            activeStates.set(ctx.from.id, {
                action: 'bounty_create_title',
                step: 1
            });

            await ctx.editMessageText(
                '➕ *Criar Nova Recompensa*\n\n' +
                '*Passo 1/2:* Digite o título (máx. 40 caracteres):\n\n' +
                '_Envie /cancel para cancelar_',
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Create] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Testar votação (para admin testar o fluxo)
    bot.action('bounty_test_vote', requireAdmin, async (ctx) => {
        try {
            const bounties = await bountyService.listBounties('approved', 5);

            if (bounties.length === 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'adm_bounties')]
                ]);
                await ctx.editMessageText(
                    '🗳️ *Testar Votação*\n\n' +
                    'Nenhum bounty aprovado para testar.',
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
                return ctx.answerCbQuery();
            }

            const buttons = bounties.map(b => [
                Markup.button.callback(`#${b.id}: ${b.title.substring(0, 25)}...`, `bounty_vote_select:${b.id}`)
            ]);
            buttons.push([Markup.button.callback('◀️ Voltar', 'adm_bounties')]);

            await ctx.editMessageText(
                '🗳️ *Testar Votação*\n\n' +
                'Selecione um bounty para votar:',
                { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Test Vote] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Selecionar bounty - menu principal com opções Contribuir ou Trabalhar
    bot.action(/^bounty_vote_select:(\d+)$/, requireAdmin, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            const bounty = await bountyService.getBountyById(bountyId);

            if (!bounty || bounty.status !== 'approved') {
                return ctx.answerCbQuery('❌ Projeto não disponível');
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💰 Quero Contribuir', `bounty_contribute:${bountyId}`)],
                [Markup.button.callback('🛠️ Quero Trabalhar', `bounty_work:${bountyId}`)],
                [Markup.button.callback('◀️ Voltar', 'bounty_test_vote')]
            ]);

            await ctx.editMessageText(
                `🎯 *Projeto \\#${bountyId}*\n\n` +
                `*${escapeMarkdownV2(bounty.title)}*\n\n` +
                `${escapeMarkdownV2(bounty.short_description)}\n\n` +
                `💰 *Recompensa atual:* R\\$ ${parseFloat(bounty.total_brl || 0).toFixed(2).replace('.', '\\.')}\n` +
                `📊 *Contribuições:* ${bounty.vote_count || 0}\n\n` +
                `Escolha como deseja participar:`,
                { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logger.error(`[Bounty Select] Erro: ${error.message}`);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // ========================================
    // BOUNTY HANDLERS MOVIDOS PARA handlers.js
    // (bounty_contribute, bounty_work, bounty_claim, bounty_vote_pix, bounty_vote_liquid)
    // Agora qualquer usuário pode contribuir/trabalhar em projetos
    // ========================================

    // ========================================
    // BOUNTY TEXT HANDLERS
    // ========================================

    // Handler para título do bounty (step 1)
    async function handleBountyCreateTitle(ctx, state) {
        const title = ctx.message.text.trim();

        if (title.length < 5) {
            await ctx.reply('❌ Título muito curto. Mínimo de 5 caracteres.');
            return;
        }

        if (title.length > 40) {
            await ctx.reply('❌ Título muito longo. Máximo de 40 caracteres.');
            return;
        }

        // Salvar título e passar para próximo passo
        activeStates.set(ctx.from.id, {
            action: 'bounty_create_desc',
            title: title
        });

        await ctx.reply(
            `✅ Título salvo: *${title}*\n\n` +
            `📝 *Passo 2/2:* Digite a descrição (até 2000 caracteres):\n\n` +
            `_Explique o que precisa ser desenvolvido._\n\n` +
            `_Envie /cancel para cancelar_`,
            { parse_mode: 'Markdown' }
        );
    }

    // Handler para descrição do bounty (step 2) - cria o bounty
    async function handleBountyCreateDesc(ctx, state) {
        const description = ctx.message.text.trim();

        if (description.length < 10) {
            await ctx.reply('❌ Descrição muito curta. Mínimo de 10 caracteres.');
            return;
        }

        if (description.length > 2000) {
            await ctx.reply('❌ Descrição muito longa. Máximo de 2000 caracteres.');
            return;
        }

        try {
            // Criar o bounty
            const bounty = await bountyService.createBounty({
                title: state.title,
                description: description,
                createdByTelegramId: ctx.from.id,
                createdByUsername: ctx.from.username
            });

            const statusEmoji = bounty.status === 'pending_review' ? '⏳' : '✅';
            const statusText = bounty.status === 'pending_review' ? 'Pendente de Aprovação' : 'Aprovado';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📋 Ver Detalhes', `bounty_review:${bounty.id}`)],
                [Markup.button.callback('◀️ Menu Projetos', 'adm_bounties')]
            ]);

            await ctx.reply(
                `✅ *Recompensa Criada!*\n\n` +
                `📌 *Título:* ${bounty.title}\n` +
                `📝 *Descrição:* ${bounty.short_description.substring(0, 100)}${bounty.short_description.length > 100 ? '...' : ''}\n` +
                `📊 *Status:* ${statusEmoji} ${statusText}\n` +
                `🆔 *ID:* ${bounty.id}\n\n` +
                `_Recompensa criada com sucesso!_`,
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            logger.error(`[Bounty Create] Erro: ${error.message}`);
            await ctx.reply(`❌ Erro ao criar recompensa: ${error.message}`);
        }

        activeStates.delete(ctx.from.id);
    }

    // Handler para valor PIX do voto
    async function handleBountyVotePixAmount(ctx, state) {
        const text = ctx.message.text.trim().replace(',', '.');
        const amount = parseFloat(text);

        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Valor inválido. Digite um número válido (ex: 50 ou 100.50)');
            return;
        }

        if (amount < config.bounties.minPixAmountBrl) {
            await ctx.reply(`❌ Valor mínimo é R$ ${config.bounties.minPixAmountBrl.toFixed(2)}`);
            return;
        }

        if (amount > config.bounties.maxPixAmountBrl) {
            await ctx.reply(`❌ Valor máximo é R$ ${config.bounties.maxPixAmountBrl.toFixed(2)}`);
            return;
        }

        try {
            const result = await bountyService.createPixPayment(
                state.bountyId,
                ctx.from.id,
                ctx.from.username,
                amount
            );

            const { payment, pixData } = result;
            const qrCode = pixData.qrCode;
            const qrCodeImage = pixData.qrCodeImage;
            const expiresAt = pixData.expiresAt;

            // Formatar data de expiração
            const expireDate = new Date(expiresAt);
            const expireStr = expireDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('◀️ Voltar', `bounty_contribute:${state.bountyId}`)]
            ]);

            // Enviar QR code como imagem se disponível
            if (qrCodeImage && qrCodeImage.startsWith('data:image')) {
                const base64Data = qrCodeImage.replace(/^data:image\/\w+;base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');

                await ctx.replyWithPhoto(
                    { source: imageBuffer },
                    {
                        caption: `💳 *Contribuição PIX*\n\n` +
                            `*Valor:* R$ ${amount.toFixed(2)}\n` +
                            `*Expira:* ${expireStr}`,
                        parse_mode: 'Markdown'
                    }
                );

                await ctx.reply(
                    `\`${qrCode}\`\n\n` +
                    `_Toque para copiar e cole no app do banco_`,
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
            } else {
                // Fallback sem imagem
                await ctx.reply(
                    `💳 *Contribuição PIX*\n\n` +
                    `*Valor:* R$ ${amount.toFixed(2)}\n` +
                    `*Expira:* ${expireStr}\n\n` +
                    `\`${qrCode}\`\n\n` +
                    `_Toque para copiar e cole no app do banco_`,
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
            }
        } catch (error) {
            logger.error(`[Bounty PIX Amount] Erro: ${error.message}`);
            await ctx.reply(`❌ Erro ao gerar PIX: ${error.message}`);
        }

        activeStates.delete(ctx.from.id);
    }

    logger.info('[AdminCommands] Sistema administrativo completo registrado com todos os handlers');
};

module.exports = {
    registerAdminCommands,
    isAdmin
};