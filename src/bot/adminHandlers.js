const { Markup } = require('telegraf');
const logger = require('../core/logger');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const BroadcastService = require('../services/broadcastService');

// IDs dos admins autorizados (adicione os IDs reais aqui)
const ADMIN_IDS = process.env.ADMIN_TELEGRAM_IDS ?
    process.env.ADMIN_TELEGRAM_IDS.split(',').map(id => parseInt(id.trim())) :
    [];

logger.info(`[AdminHandlers] Admin IDs configurados: ${ADMIN_IDS.join(', ')}`);

/**
 * Verifica se usuário é admin
 */
const isAdmin = (userId) => {
    return ADMIN_IDS.includes(userId);
};

/**
 * Middleware para verificar admin
 */
const adminOnly = (ctx, next) => {
    const userId = ctx.from.id;
    logger.info(`[AdminOnly] Verificando admin para user ${userId}`);

    if (!isAdmin(userId)) {
        logger.info(`[AdminOnly] Acesso negado para user ${userId} - não é admin`);
        return ctx.reply('⛔ Comando restrito a administradores.');
    }

    logger.info(`[AdminOnly] Acesso permitido para admin ${userId}`);
    return next();
};

/**
 * Registra comandos administrativos
 */
const registerAdminHandlers = (bot, dbPool) => {
    const broadcastService = new BroadcastService(bot, dbPool);

    // Estado do broadcast (para multi-step)
    const broadcastState = new Map();

    // Comando /admin - Menu principal
    bot.command('admin', (ctx) => {
        const userId = ctx.from.id;
        logger.info(`[Admin] Comando /admin recebido de user ${userId}`);

        if (!isAdmin(userId)) {
            logger.info(`[Admin] Negado para ${userId} - não é admin`);
            return ctx.reply('⛔ Comando restrito a administradores.');
        }

        logger.info(`[Admin] Mostrando menu para admin ${userId}`);

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📢 Broadcast', 'admin_broadcast')],
            [Markup.button.callback('📊 Estatísticas', 'admin_stats')],
            [Markup.button.callback('👥 Usuários', 'admin_users')],
            [Markup.button.callback('🔧 Sistema', 'admin_system')]
        ]);

        ctx.reply(
            '🔧 *Painel Administrativo*\n\n' +
            'Selecione uma opção:',
            {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            }
        );
    });

    // Menu de Broadcast
    bot.action('admin_broadcast', adminOnly, (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📝 Nova Mensagem', 'broadcast_new')],
            [Markup.button.callback('🎯 Segmentado', 'broadcast_segmented')],
            [Markup.button.callback('🧪 Teste', 'broadcast_test')],
            [Markup.button.callback('⏰ Agendar', 'broadcast_schedule')],
            [Markup.button.callback('◀️ Voltar', 'admin_main')]
        ]);

        ctx.editMessageText(
            '📢 *Broadcast*\n\n' +
            'Escolha o tipo de broadcast:',
            {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            }
        );
    });

    // Novo Broadcast
    bot.action('broadcast_new', adminOnly, async (ctx) => {
        broadcastState.set(ctx.from.id, { type: 'simple' });

        await ctx.editMessageText(
            '📝 *Novo Broadcast*\n\n' +
            'Envie a mensagem que deseja transmitir para todos os usuários.\n\n' +
            '⚠️ Use /cancel para cancelar',
            { parse_mode: 'Markdown' }
        );
    });

    // Broadcast Segmentado
    bot.action('broadcast_segmented', adminOnly, async (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Apenas Verificados', 'seg_verified')],
            [Markup.button.callback('💰 Por Volume', 'seg_volume')],
            [Markup.button.callback('⭐ Por Reputação', 'seg_reputation')],
            [Markup.button.callback('📅 Ativos Recentes', 'seg_active')],
            [Markup.button.callback('◀️ Voltar', 'admin_broadcast')]
        ]);

        await ctx.editMessageText(
            '🎯 *Broadcast Segmentado*\n\n' +
            'Selecione o filtro de segmentação:',
            {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            }
        );
    });

    // Filtro: Apenas Verificados
    bot.action('seg_verified', adminOnly, async (ctx) => {
        broadcastState.set(ctx.from.id, {
            type: 'segmented',
            filter: 'verified'
        });

        await ctx.editMessageText(
            '✅ *Broadcast para Usuários Verificados*\n\n' +
            'Envie a mensagem para transmitir apenas para usuários verificados.\n\n' +
            '⚠️ Use /cancel para cancelar',
            { parse_mode: 'Markdown' }
        );
    });

    // Teste de Broadcast
    bot.action('broadcast_test', adminOnly, async (ctx) => {
        broadcastState.set(ctx.from.id, {
            type: 'test'
        });

        await ctx.editMessageText(
            '🧪 *Teste de Broadcast*\n\n' +
            'Envie a mensagem de teste.\n' +
            'Será enviada apenas para administradores.\n\n' +
            '⚠️ Use /cancel para cancelar',
            { parse_mode: 'Markdown' }
        );
    });

    // Processar mensagem de broadcast
    bot.on('text', async (ctx, next) => {
        if (!isAdmin(ctx.from.id)) return next();

        const state = broadcastState.get(ctx.from.id);
        if (!state) return next();

        // Se for comando de cancelar
        if (ctx.message.text === '/cancel') {
            broadcastState.delete(ctx.from.id);
            return ctx.reply('❌ Broadcast cancelado.');
        }

        const message = escapeMarkdownV2(ctx.message.text);

        try {
            let result;

            // Adicionar botões padrão ao broadcast
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.url('💬 Comunidade', process.env.COMMUNITY_GROUP_LINK || 'https://t.me/atlasdao')]
            ]);

            switch (state.type) {
                case 'simple':
                    await ctx.reply('📤 Iniciando broadcast...');
                    result = await broadcastService.sendBroadcast(message, {
                        keyboard: keyboard.reply_markup
                    });
                    break;

                case 'segmented':
                    if (state.filter === 'verified') {
                        await ctx.reply('📤 Iniciando broadcast para usuários verificados...');
                        result = await broadcastService.sendBroadcast(message, {
                            onlyVerified: true,
                            keyboard: keyboard.reply_markup
                        });
                    }
                    break;

                case 'test':
                    await ctx.reply('🧪 Enviando teste...');
                    result = await broadcastService.sendTestBroadcast(message, ADMIN_IDS);
                    break;
            }

            // Relatório do broadcast
            const report =
                `✅ *Broadcast Concluído*\n\n` +
                `📊 *Estatísticas:*\n` +
                `├ Total: ${result.total || result.sent + result.failed}\n` +
                `├ ✅ Enviados: ${result.sent}\n` +
                `├ ❌ Falhas: ${result.failed}\n` +
                `${result.blocked ? `└ 🚫 Bloqueados: ${result.blocked}` : ''}`;

            await ctx.reply(report, { parse_mode: 'Markdown' });

            broadcastState.delete(ctx.from.id);

        } catch (error) {
            logger.error(`[AdminBroadcast] Erro: ${error.message}`);
            await ctx.reply(
                '❌ Erro ao enviar broadcast.\n' +
                `Detalhes: ${error.message}`
            );
            broadcastState.delete(ctx.from.id);
        }

        return next();
    });

    // Estatísticas
    bot.action('admin_stats', adminOnly, async (ctx) => {
        try {
            const stats = await dbPool.query(`
                SELECT
                    COUNT(*) as total_users,
                    COUNT(CASE WHEN is_verified = true THEN 1 END) as verified_users,
                    COUNT(CASE WHEN liquid_address IS NOT NULL THEN 1 END) as with_wallet,
                    COUNT(CASE WHEN is_banned = true THEN 1 END) as banned_users,
                    SUM(total_volume_brl) as total_volume,
                    AVG(reputation_level) as avg_reputation
                FROM users
            `);

            const s = stats.rows[0];

            const message =
                `📊 *Estatísticas do Sistema*\n\n` +
                `👥 *Usuários:*\n` +
                `├ Total: ${s.total_users}\n` +
                `├ Verificados: ${s.verified_users}\n` +
                `├ Com Carteira: ${s.with_wallet}\n` +
                `└ Banidos: ${s.banned_users}\n\n` +
                `💰 *Volume:*\n` +
                `├ Total: R$ ${parseFloat(s.total_volume || 0).toFixed(2)}\n` +
                `└ Reputação Média: ${parseFloat(s.avg_reputation || 0).toFixed(1)}`;

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('◀️ Voltar', 'admin_main')]
                ]).reply_markup
            });

        } catch (error) {
            logger.error(`[AdminStats] Erro: ${error.message}`);
            await ctx.reply('❌ Erro ao buscar estatísticas.');
        }
    });

    // Voltar ao menu principal
    bot.action('admin_main', adminOnly, (ctx) => {
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📢 Broadcast', 'admin_broadcast')],
            [Markup.button.callback('📊 Estatísticas', 'admin_stats')],
            [Markup.button.callback('👥 Usuários', 'admin_users')],
            [Markup.button.callback('🔧 Sistema', 'admin_system')]
        ]);

        ctx.editMessageText(
            '🔧 *Painel Administrativo*\n\n' +
            'Selecione uma opção:',
            {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            }
        );
    });

    // Comando /cancel
    bot.command('cancel', (ctx) => {
        if (broadcastState.has(ctx.from.id)) {
            broadcastState.delete(ctx.from.id);
            ctx.reply('❌ Operação cancelada.');
        }
    });

    logger.info('[AdminHandlers] Comandos administrativos registrados');
};

module.exports = {
    registerAdminHandlers,
    isAdmin,
    adminOnly
};