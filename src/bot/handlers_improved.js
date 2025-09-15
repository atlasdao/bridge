const { Markup } = require('telegraf');
const config = require('../core/config');
const logger = require('../core/logger');
const depixApiService = require('../services/depixApiService');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const securityService = require('../services/securityService');
const InputValidator = require('../utils/inputValidator');
const LogSanitizer = require('../utils/logSanitizer');
const UserValidation = require('../utils/userValidation');

const secureLogger = LogSanitizer.createSecureLogger();

// Cache de status de usuário para sessão (5 minutos)
const userStatusCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

const isValidLiquidAddress = (address) => {
    const validation = InputValidator.validateLiquidAddress(address);
    if (!validation.valid) {
        logger.info(`[isValidLiquidAddress] Invalid: ${validation.error}`);
    }
    return validation.valid;
};

let awaitingInputForUser = {};

// Helper para auto-deletar mensagens de erro após 5 segundos
const sendErrorMessage = async (ctx, message, autoDelete = true) => {
    const msg = await ctx.reply(`❌ ${message}`);
    if (autoDelete) {
        setTimeout(async () => {
            try {
                await ctx.deleteMessage(msg.message_id);
            } catch (e) {
                // Ignorar se não conseguir deletar
            }
        }, 5000);
    }
    return msg;
};

// Helper para obter status do usuário com cache
const getUserStatusCached = async (dbPool, userId) => {
    const cached = userStatusCache.get(userId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.data;
    }

    const status = await securityService.getUserStatus(dbPool, userId);
    userStatusCache.set(userId, { data: status, timestamp: Date.now() });
    return status;
};

// Helper para criar progress bar visual
const createProgressBar = (percentage, width = 10) => {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
};

// Helper para feedback visual animado
const showLoadingAnimation = async (ctx, messageId, text) => {
    const frames = ['⏳', '⌛'];
    let frame = 0;

    const interval = setInterval(async () => {
        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                messageId,
                undefined,
                `${frames[frame % 2]} ${text}`
            );
            frame++;
        } catch (e) {
            clearInterval(interval);
        }
    }, 500);

    return interval;
};

const registerBotHandlers = (bot, dbPool, expectationMessageQueue, expirationQueue) => {
    const logError = (handlerName, error, ctx) => {
        const userId = ctx?.from?.id || 'N/A';
        logger.error(`Error in ${handlerName} for user ${userId}: ${error.message}`);
        if (error.stack) {
            logger.error(error.stack);
        }
    };

    // Menu principal para usuários validados - SIMPLIFICADO
    const mainMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('💸 Comprar Depix', 'receive_pix_start')],
        [Markup.button.callback('📊 Status', 'user_status')],
        [Markup.button.callback('💼 Carteira', 'my_wallet')],
        [Markup.button.callback('ℹ️ Sobre', 'about_bridge')],
        [Markup.button.url('💬 Comunidade', config.links.communityGroup)]
    ]);

    // Menu para usuários não validados - SIMPLIFICADO
    const unverifiedMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Validar Conta', 'start_validation')],
        [Markup.button.callback('❓ Por quê?', 'why_validate')],
        [Markup.button.callback('💼 Carteira', 'my_wallet')],
        [Markup.button.url('💬 Comunidade', config.links.communityGroup)]
    ]);

    const sendMainMenu = async (ctx, messageText = null) => {
        try {
            const userId = ctx.from?.id;

            // Usar cache para status
            const userStatus = await getUserStatusCached(dbPool, userId);

            let keyboard, message;

            if (!userStatus || !userStatus.liquid_address) {
                // Fluxo linear simplificado para novo usuário
                message = messageText || '👋 Vamos configurar sua carteira em 30 segundos!';
                keyboard = initialConfigKeyboardObj;
            } else if (!userStatus.is_verified) {
                // Mensagem simplificada para não validado
                message = messageText || `🔐 **Conta não validada**\n\n` +
                    `Validação única • R\\$ 1,00\n` +
                    `Desbloqueie todas as funcionalidades`;
                keyboard = unverifiedMenuKeyboardObj;
            } else if (userStatus.is_banned) {
                message = `🚫 Conta banida: ${escapeMarkdownV2(userStatus.ban_reason || 'Violação dos termos')}`;
                keyboard = Markup.inlineKeyboard([
                    [Markup.button.url('📞 Suporte', `https://t.me/${config.links.supportContact.replace('@', '')}`)]
                ]);
            } else {
                // Menu simplificado para validados
                const availableLimit = userStatus.available_today || 0;
                message = messageText || `💰 Limite disponível: R$ ${availableLimit.toFixed(2)}`;
                keyboard = mainMenuKeyboardObj;
            }

            if (ctx.callbackQuery?.message?.message_id) {
                await ctx.editMessageText(message, {
                    reply_markup: keyboard.reply_markup,
                    parse_mode: message.includes('*') ? 'MarkdownV2' : undefined
                });
            } else {
                if (message.includes('*')) {
                    await ctx.replyWithMarkdownV2(message, { reply_markup: keyboard.reply_markup });
                } else {
                    await ctx.reply(message, keyboard);
                }
            }
        } catch (error) {
            logError('sendMainMenu/editOrReply', error, ctx);
            await sendErrorMessage(ctx, 'Ops! Tente novamente.');
        }
    };

    const initialConfigKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Tenho carteira', 'ask_liquid_address')],
        [Markup.button.callback('❌ Criar carteira', 'explain_liquid_wallet')],
        [Markup.button.callback('ℹ️ Sobre', 'about_bridge')]
    ]);

    const clearUserState = (userId) => {
        if (userId) delete awaitingInputForUser[userId];
    };

    // Comando /start - SIMPLIFICADO
    bot.start(async (ctx) => {
        clearUserState(ctx.from.id);
        const telegramUserId = ctx.from.id;
        const telegramUsername = ctx.from.username || null;

        // Verificar username
        const usernameCheck = UserValidation.checkUsername(ctx);
        if (!usernameCheck.valid) {
            await ctx.reply(usernameCheck.error);
            return;
        }

        logger.info(`User ${telegramUserId} (${telegramUsername}) started the bot.`);
        try {
            const { rows } = await dbPool.query('SELECT liquid_address, telegram_username FROM users WHERE telegram_id = $1', [telegramUserId]);
            if (rows.length > 0 && rows[0].liquid_address) {
                await sendMainMenu(ctx);
            } else {
                // Onboarding simplificado
                const initialMessage = `🚀 **Bridge Atlas**\n\n` +
                                      `Compre DePix com PIX\\.\n` +
                                      `100% privado • Você no controle\\.\n\n` +
                                      `Vamos começar?`;
                await ctx.replyWithMarkdownV2(initialMessage, initialConfigKeyboardObj);
                if (rows.length === 0) {
                    await dbPool.query('INSERT INTO users (telegram_id, telegram_username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING', [telegramUserId, telegramUsername || 'N/A']);
                    logger.info(`User ${telegramUserId} (${telegramUsername}) newly registered in DB (no address yet).`);
                }
            }
        } catch (error) {
            logError('/start', error, ctx);
            await sendErrorMessage(ctx, 'Ops! Tente novamente.');
        }
    });

    // Comando /status - ATALHO DIRETO
    bot.command('status', async (ctx) => {
        clearUserState(ctx.from.id);
        const userId = ctx.from.id;
        const userStatus = await getUserStatusCached(dbPool, userId);

        if (!userStatus || !userStatus.is_verified) {
            await ctx.reply('❌ Conta não validada. Use /start');
            return;
        }

        const available = userStatus.available_today || 0;
        const limit = userStatus.daily_limit_brl || 0;
        const percentage = (userStatus.actual_daily_used / limit) * 100;
        const progressBar = createProgressBar(percentage);

        await ctx.reply(
            `💰 R$ ${available.toFixed(2)} disponível\n` +
            `📊 [${progressBar}] ${percentage.toFixed(0)}%\n` +
            `⭐ Nível ${userStatus.reputation_level}/10`
        );
    });

    // Comandos de atalho para valores comuns
    bot.command('50', async (ctx) => {
        await processQuickAmount(ctx, 50);
    });

    bot.command('100', async (ctx) => {
        await processQuickAmount(ctx, 100);
    });

    bot.command('200', async (ctx) => {
        await processQuickAmount(ctx, 200);
    });

    const processQuickAmount = async (ctx, amount) => {
        clearUserState(ctx.from.id);
        const userId = ctx.from.id;

        // Verificações rápidas
        const userStatus = await getUserStatusCached(dbPool, userId);
        if (!userStatus || !userStatus.is_verified) {
            await sendErrorMessage(ctx, 'Conta não validada');
            return;
        }

        if (amount > userStatus.available_today) {
            await sendErrorMessage(ctx, `Limite disponível: R$ ${userStatus.available_today.toFixed(2)}`);
            return;
        }

        // Processar pagamento diretamente
        await processPayment(ctx, amount, userStatus);
    };

    const processPayment = async (ctx, amount, userStatus) => {
        const userId = ctx.from.id;
        const loadingMsg = await ctx.reply('⏳ Gerando QR Code...');

        try {
            // Verificar se pode transacionar
            const canTransact = await securityService.checkUserCanTransact(dbPool, userId, amount);
            if (!canTransact.canTransact) {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    loadingMsg.message_id,
                    undefined,
                    `❌ ${canTransact.reason}`
                );
                return;
            }

            // Gerar PIX
            const userLiquidAddress = userStatus.liquid_address;
            const amountInCents = Math.round(amount * 100);

            const userInfo = {};
            if (userStatus.payer_name && userStatus.payer_cpf_cnpj) {
                userInfo.payerName = userStatus.payer_name;
                userInfo.payerDocument = userStatus.payer_cpf_cnpj;
            }

            const webhookUrl = `${config.app.baseUrl}/webhooks/depix_payment`;
            const pixData = await depixApiService.generatePixForDeposit(amountInCents, userLiquidAddress, webhookUrl, userInfo);
            const { qrCopyPaste, qrImageUrl, id: depixApiEntryId } = pixData;

            // Salvar transação
            const dbResult = await dbPool.query(
                'INSERT INTO pix_transactions (user_id, requested_brl_amount, depix_amount_expected, pix_qr_code_payload, payment_status, depix_api_entry_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING transaction_id',
                [userId, amount, (amount - 0.99), qrCopyPaste, 'PENDING', depixApiEntryId]
            );
            const internalTxId = dbResult.rows[0].transaction_id;

            // Jobs de expiração
            const reminderJobId = `expectation-${depixApiEntryId}`;
            await expectationMessageQueue.add(reminderJobId, { telegramUserId: userId, depixApiEntryId, supportContact: escapeMarkdownV2(config.links.supportContact) }, { delay: 19 * 60 * 1000, removeOnComplete: true, removeOnFail: true, jobId: reminderJobId });

            const expirationJobId = `expiration-${depixApiEntryId}`;
            await expirationQueue.add(expirationJobId, { telegramUserId: userId, depixApiEntryId, requestedBrlAmount: amount }, { delay: 19 * 60 * 1000, removeOnComplete: true, removeOnFail: true, jobId: expirationJobId });

            // QR Code MINIMALISTA
            const caption = `📱 **PIX de R\\$ ${escapeMarkdownV2(amount.toFixed(2))}**\n\n` +
                          `⏱ Expira em 19 minutos`;

            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📋 Copiar código', `copy_pix:${depixApiEntryId}`)],
                [Markup.button.callback('❌ Cancelar', `cancel_qr:${depixApiEntryId}`)]
            ]);

            const qrPhotoMessage = await ctx.replyWithPhoto(qrImageUrl, {
                caption: caption,
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });

            await dbPool.query('UPDATE pix_transactions SET qr_code_message_id = $1 WHERE transaction_id = $2', [qrPhotoMessage.message_id, internalTxId]);

            // Enviar código PIX separadamente para fácil cópia
            await ctx.reply(`\`${qrCopyPaste}\``, { parse_mode: 'MarkdownV2' });

        } catch (error) {
            logError('processPayment', error, ctx);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                loadingMsg.message_id,
                undefined,
                '❌ Ops! Tente novamente.'
            );
        }
    };

    // Auto-detectar endereço Liquid em qualquer mensagem
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        const telegramUserId = ctx.from.id;
        const telegramUsername = ctx.from.username || 'N/A';
        const userState = awaitingInputForUser[telegramUserId];

        if (text.startsWith('/')) {
            clearUserState(telegramUserId);
            return;
        }

        // Auto-detectar endereço Liquid
        if (!userState && text.length > 40 && text.startsWith('lq')) {
            if (isValidLiquidAddress(text)) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Sim', `confirm_address:${text}`)],
                    [Markup.button.callback('❌ Não', 'cancel_address')]
                ]);
                await ctx.reply(
                    `🔍 Detectei uma carteira Liquid!\nUsar este endereço?`,
                    keyboard
                );
                return;
            }
        }

        // Apagar mensagem do usuário para manter chat limpo
        if (userState && !text.startsWith('/')) {
            try {
                await ctx.deleteMessage();
            } catch (e) {
                // Ignorar
            }
        }

        if (userState && userState.type === 'amount') {
            // Processar valor personalizado
            const validation = InputValidator.validateMonetaryAmount(text, {
                minValue: 1,
                maxValue: userState.maxAllowed || 5000,
                maxDecimals: 2
            });

            if (validation.valid) {
                const amount = validation.value;
                const userStatus = await getUserStatusCached(dbPool, telegramUserId);
                await processPayment(ctx, amount, userStatus);
                clearUserState(telegramUserId);
            } else {
                // Validação inline - editar mensagem existente
                if (userState.messageIdToEdit) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        userState.messageIdToEdit,
                        undefined,
                        `❌ Valor inválido. Digite entre R$ 1 e R$ ${userState.maxAllowed}`
                    );
                } else {
                    await sendErrorMessage(ctx, validation.error);
                }
            }
        } else if (userState && (userState.type === 'liquid_address_initial' || userState.type === 'liquid_address_change')) {
            if (isValidLiquidAddress(text)) {
                try {
                    await dbPool.query(
                        'INSERT INTO users (telegram_id, telegram_username, liquid_address, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_id) DO UPDATE SET liquid_address = EXCLUDED.liquid_address, telegram_username = EXCLUDED.telegram_username, updated_at = NOW()',
                        [telegramUserId, telegramUsername, text]
                    );
                    logger.info(`User ${telegramUserId} associated/updated Liquid address: ${text}`);

                    // Mensagem de sucesso simplificada
                    await ctx.reply('✅ Carteira configurada!');
                    clearUserState(telegramUserId);

                    // Ir direto ao menu sem delay
                    await sendMainMenu(ctx);
                } catch (error) {
                    logError('save_address', error, ctx);
                    await sendErrorMessage(ctx, 'Ops! Tente novamente.');
                }
            } else {
                await sendErrorMessage(ctx, 'Endereço inválido. Verifique e tente novamente.');
            }
        }
    });

    // Botão Comprar Depix com valores rápidos
    bot.action('receive_pix_start', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const userId = ctx.from.id;
            const userStatus = await getUserStatusCached(dbPool, userId);

            // Verificações básicas
            if (!userStatus || !userStatus.liquid_address) {
                await ctx.editMessageText('❌ Configure sua carteira primeiro');
                return;
            }

            if (!userStatus.is_verified) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Validar agora', 'start_validation')],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);
                await ctx.editMessageText('🔐 Valide sua conta primeiro', { reply_markup: keyboard.reply_markup });
                return;
            }

            // Verificar transação pendente
            const pendingCheck = await dbPool.query(
                `SELECT depix_api_entry_id FROM pix_transactions
                 WHERE user_id = $1 AND payment_status = $2
                 AND created_at > NOW() - INTERVAL '20 minutes'
                 ORDER BY created_at DESC LIMIT 1`,
                [userId, 'PENDING']
            );

            if (pendingCheck.rows.length > 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancelar anterior', `cancel_and_generate:${pendingCheck.rows[0].depix_api_entry_id}`)],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);
                await ctx.editMessageText('⚠️ Você tem um pagamento pendente', { reply_markup: keyboard.reply_markup });
                return;
            }

            // BOTÕES DE VALORES RÁPIDOS
            const available = userStatus.available_today || 0;
            const maxTransaction = userStatus.max_per_transaction_brl || available;
            const effectiveMax = Math.min(available, maxTransaction);

            const buttons = [];

            // Botão com 100% do disponível (se maior que R$ 1)
            if (effectiveMax >= 1) {
                buttons.push([Markup.button.callback(
                    `💯 R$ ${effectiveMax.toFixed(2)} (máximo)`,
                    `quick_amount:${effectiveMax.toFixed(2)}`
                )]);
            }

            // Botão com 50% do disponível (se maior que R$ 1)
            const halfAmount = effectiveMax / 2;
            if (halfAmount >= 1) {
                buttons.push([Markup.button.callback(
                    `➗ R$ ${halfAmount.toFixed(2)} (50%)`,
                    `quick_amount:${halfAmount.toFixed(2)}`
                )]);
            }

            // Botão valor personalizado
            buttons.push([Markup.button.callback('✏️ Valor personalizado', 'custom_amount')]);
            buttons.push([Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]);

            const keyboard = Markup.inlineKeyboard(buttons);

            const message = `💸 **Comprar Depix**\n━━━━━━━━━━━━\n` +
                          `Disponível: R\\$ ${escapeMarkdownV2(available.toFixed(2))}\n\n` +
                          `Escolha o valor:`;

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });

        } catch (error) {
            logError('receive_pix_start', error, ctx);
            await sendErrorMessage(ctx, 'Ops! Tente novamente.');
        }
    });

    // Processar valor rápido
    bot.action(/^quick_amount:(.+)$/, async (ctx) => {
        const amount = parseFloat(ctx.match[1]);
        await ctx.answerCbQuery();
        const userStatus = await getUserStatusCached(dbPool, ctx.from.id);
        await processPayment(ctx, amount, userStatus);
    });

    // Valor personalizado
    bot.action('custom_amount', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const userStatus = await getUserStatusCached(dbPool, userId);

        const available = userStatus.available_today || 0;
        const message = `Digite o valor (R$ 1 a R$ ${available.toFixed(2)}):`;

        const sentMessage = await ctx.editMessageText(message);
        awaitingInputForUser[userId] = {
            type: 'amount',
            messageIdToEdit: sentMessage.message_id,
            maxAllowed: available
        };
    });

    // Copiar código PIX
    bot.action(/^copy_pix:(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('📋 Código copiado! Cole no seu app de banco.');
    });

    // Minha Carteira - SIMPLIFICADO
    bot.action('my_wallet', async (ctx) => {
        clearUserState(ctx.from.id);
        try {
            await ctx.answerCbQuery();
            const { rows } = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_id = $1', [ctx.from.id]);
            if (rows.length > 0 && rows[0].liquid_address) {
                const address = rows[0].liquid_address;
                const shortAddress = `${address.substring(0, 10)}...${address.substring(address.length - 10)}`;

                const message = `💼 **Carteira**\n━━━━━━━━━\n\`${escapeMarkdownV2(shortAddress)}\``;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('📜 Histórico', 'transaction_history:0')],
                    [Markup.button.callback('🔄 Alterar', 'change_wallet_start')],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);

                await ctx.editMessageText(message, {
                    parse_mode: 'MarkdownV2',
                    reply_markup: keyboard.reply_markup
                });
            } else {
                await ctx.editMessageText('❌ Sem carteira configurada');
            }
        } catch (error) {
            logError('my_wallet', error, ctx);
            await sendErrorMessage(ctx, 'Ops! Tente novamente.');
        }
    });

    // Status - SIMPLIFICADO COM BARRA VISUAL
    bot.action('user_status', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const userId = ctx.from.id;
            const userStatus = await getUserStatusCached(dbPool, userId);

            if (!userStatus || !userStatus.is_verified) {
                await ctx.editMessageText('❌ Conta não validada');
                return;
            }

            const percentUsed = (userStatus.actual_daily_used / userStatus.daily_limit_brl) * 100;
            const progressBar = createProgressBar(percentUsed);

            // Verificar upgrade
            const upgradeCheck = await securityService.checkAndUpgradeReputation(dbPool, userId);

            let nextLevelInfo = '';
            if (upgradeCheck.upgraded) {
                // Notificação proativa de upgrade
                nextLevelInfo = `\n🎉 **Subiu para Nível ${upgradeCheck.new_level}\\!**`;
            } else if (userStatus.reputation_level < 10) {
                const remaining = 100 - percentUsed;
                if (percentUsed >= 100) {
                    nextLevelInfo = `\n📈 **Próximo nível:** Aguarde 24h`;
                } else {
                    nextLevelInfo = `\n📈 **Próximo nível:** Use mais ${remaining.toFixed(0)}%`;
                }
            }

            const message = `📊 **Status**\n━━━━━━━━\n` +
                          `⭐ Nível ${userStatus.reputation_level}/10\n` +
                          `💰 R\\$ ${escapeMarkdownV2(userStatus.available_today.toFixed(2))} disponível\n\n` +
                          `**Uso hoje:**\n` +
                          `\[${progressBar}\] ${percentUsed.toFixed(0)}%` +
                          nextLevelInfo;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });

        } catch (error) {
            logError('user_status', error, ctx);
            await sendErrorMessage(ctx, 'Ops! Tente novamente.');
        }
    });

    // Histórico - APENAS 3 ÚLTIMAS
    bot.action(/^transaction_history(?::(\d+))?$/, async (ctx) => {
        clearUserState(ctx.from.id);
        const showAll = ctx.match[1] === '1';

        try {
            await ctx.answerCbQuery();

            const limit = showAll ? 10 : 3;
            const { rows: transactions } = await dbPool.query(
                `SELECT requested_brl_amount, payment_status, created_at
                 FROM pix_transactions WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT $2`,
                [ctx.from.id, limit]
            );

            let message = `📜 **Histórico**\n━━━━━━━━\n`;

            if (transactions.length === 0) {
                message += 'Nenhuma transação';
            } else {
                transactions.forEach(tx => {
                    const date = new Date(tx.created_at).toLocaleString('pt-BR', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    const status = tx.payment_status === 'PAID' ? '✅' : '⏳';
                    message += `${status} ${escapeMarkdownV2(date)} • R\\$ ${escapeMarkdownV2(tx.requested_brl_amount.toFixed(2))}\n`;
                });
            }

            const buttons = [];
            if (!showAll && transactions.length === 3) {
                buttons.push([Markup.button.callback('📊 Ver todas', 'transaction_history:1')]);
            }
            buttons.push([Markup.button.callback('⬅️ Voltar', 'my_wallet')]);

            const keyboard = Markup.inlineKeyboard(buttons);

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });

        } catch (error) {
            logError('transaction_history', error, ctx);
            await sendErrorMessage(ctx, 'Ops! Tente novamente.');
        }
    });

    // Por que validar - SIMPLIFICADO
    bot.action('why_validate', async (ctx) => {
        await ctx.answerCbQuery();

        const message = `❓ **Por que validar?**\n\n` +
                       `✅ Segurança anti\\-fraude\n` +
                       `🔐 Seus dados ficam privados\n` +
                       `💰 Libera até R\\$ 6\\.020/dia\n` +
                       `⚡ Processo único de R\\$ 1\n\n` +
                       `_Você mantém controle total_`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Validar agora', 'start_validation')],
            [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
        ]);

        await ctx.editMessageText(message, {
            parse_mode: 'MarkdownV2',
            reply_markup: keyboard.reply_markup
        });
    });

    // Sobre - SIMPLIFICADO mas mantendo doação
    bot.action('about_bridge', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const aboutMessage = `ℹ️ **Bridge Atlas**\n━━━━━━━━━\n\n` +
                               `🔐 100% privado e soberano\n` +
                               `⚡ Taxa: R\\$0,99 por transação\n` +
                               `🌐 Código aberto no GitHub\n\n` +
                               `💝 **Doações \\(DePix/L\\-BTC\\):**\n` +
                               `\`VJLBCUaw6GL8AuyjsrwpwTYNCUfUxPVTfxxffNTEZMKEjSwamWL6YqUUWLvz89ts1scTDKYoTF8oruMX\``;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
            ]);

            await ctx.editMessageText(aboutMessage, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });
        } catch (error) {
            logError('about_bridge', error, ctx);
            await sendErrorMessage(ctx, 'Ops! Tente novamente.');
        }
    });

    // Voltar ao menu - SEM CONFIRMAÇÃO
    bot.action('back_to_main_menu', async (ctx) => {
        clearUserState(ctx.from.id);
        await ctx.answerCbQuery();
        await sendMainMenu(ctx);
    });

    // Validação simplificada
    bot.action('start_validation', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const userId = ctx.from.id;
            const userStatus = await getUserStatusCached(dbPool, userId);

            if (userStatus && userStatus.is_verified) {
                await ctx.editMessageText('✅ Conta já validada!');
                setTimeout(() => sendMainMenu(ctx), 1500);
                return;
            }

            // Gerar QR de validação simplificado
            const loadingMsg = await ctx.editMessageText('⏳ Gerando validação...');

            // [Código de geração do QR de validação aqui...]
            // Simplificar similar ao QR de pagamento

        } catch (error) {
            logError('start_validation', error, ctx);
            await sendErrorMessage(ctx, 'Ops! Tente novamente.');
        }
    });

    // Outros handlers...
    // [Incluir demais handlers necessários]

    bot.catch((err, ctx) => {
        logError('Global error', err, ctx);
        sendErrorMessage(ctx, 'Ops! Tente novamente.');
    });
};

module.exports = registerBotHandlers;