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

// ===== HELPERS E UTILITÁRIOS =====

// Cache de status do usuário para melhorar performance
const userStatusCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Helper para obter status com cache
const getUserStatusCached = async (dbPool, userId) => {
    const cached = userStatusCache.get(userId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.data;
    }

    const status = await securityService.getUserStatus(dbPool, userId);
    if (status) {
        userStatusCache.set(userId, {
            data: status,
            timestamp: Date.now()
        });
    }
    return status;
};

// Helper para criar barra de progresso visual
const createProgressBar = (percentage, width = 10) => {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
};

// Helper para auto-deletar mensagens de erro
const sendTempMessage = async (ctx, message, timeout = 5000) => {
    const msg = await ctx.reply(message);
    setTimeout(async () => {
        try {
            await ctx.deleteMessage(msg.message_id);
        } catch (e) {
            // Ignorar se não conseguir deletar
        }
    }, timeout);
    return msg;
};

// Validador de endereço Liquid
const isValidLiquidAddress = (address) => {
    const validation = InputValidator.validateLiquidAddress(address);
    if (!validation.valid) {
        logger.info(`[isValidLiquidAddress] Invalid: ${validation.error}`);
    }
    return validation.valid;
};

let awaitingInputForUser = {};

// ===== FUNÇÃO PRINCIPAL =====
const registerBotHandlers = (bot, dbPool, expectationMessageQueue, expirationQueue) => {
    const logError = (handlerName, error, ctx) => {
        const userId = ctx?.from?.id || 'N/A';
        logger.error(`Error in ${handlerName} for user ${userId}: ${error.message}`);
        if (error.stack) {
            logger.error(error.stack);
        }
    };

    // ===== MENUS SIMPLIFICADOS =====

    // Menu principal para usuários validados
    const mainMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('💸 Comprar Depix', 'receive_pix_start')],
        [Markup.button.callback('📊 Status', 'user_status')],
        [Markup.button.callback('💼 Carteira', 'my_wallet')],
        [Markup.button.callback('ℹ️ Sobre', 'about_bridge')],
        [Markup.button.url('💬 Comunidade', config.links.communityGroup)]
    ]);

    // Menu para usuários não validados
    const unverifiedMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Validar Conta', 'start_validation')],
        [Markup.button.callback('❓ Por quê?', 'why_validate')],
        [Markup.button.callback('💼 Carteira', 'my_wallet')],
        [Markup.button.url('💬 Comunidade', config.links.communityGroup)]
    ]);

    // Menu inicial simplificado
    const initialConfigKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Tenho carteira', 'ask_liquid_address')],
        [Markup.button.callback('❌ Criar carteira', 'explain_liquid_wallet')],
        [Markup.button.callback('ℹ️ Sobre', 'about_bridge')]
    ]);

    // Função para enviar menu principal com lógica simplificada
    const sendMainMenu = async (ctx, messageText = null) => {
        try {
            const userId = ctx.from?.id;
            const userStatus = await getUserStatusCached(dbPool, userId);

            let keyboard, message;

            if (!userStatus || !userStatus.liquid_address) {
                message = messageText || '👋 Vamos configurar sua carteira!';
                keyboard = initialConfigKeyboardObj;
            } else if (!userStatus.is_verified) {
                message = messageText || `🔐 Validação única • R$ 1,00\nDesbloqueie todas as funcionalidades`;
                keyboard = unverifiedMenuKeyboardObj;
            } else if (userStatus.is_banned) {
                message = `🚫 Conta banida: ${userStatus.ban_reason || 'Violação dos termos'}`;
                keyboard = Markup.inlineKeyboard([
                    [Markup.button.url('📞 Suporte', `https://t.me/${config.links.supportContact.replace('@', '')}`)]
                ]);
            } else {
                const available = userStatus.available_today || 0;
                message = messageText || `💰 Limite disponível: R$ ${available.toFixed(2)}`;
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
            logError('sendMainMenu', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    };

    const clearUserState = (userId) => {
        if (userId) delete awaitingInputForUser[userId];
    };

    // ===== COMANDOS PRINCIPAIS =====

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
            const { rows } = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_id = $1', [telegramUserId]);

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
                    await dbPool.query(
                        'INSERT INTO users (telegram_id, telegram_username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
                        [telegramUserId, telegramUsername || 'N/A']
                    );
                    logger.info(`User ${telegramUserId} newly registered`);
                }
            }
        } catch (error) {
            logError('/start', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Comando /status - ATALHO DIRETO
    bot.command('status', async (ctx) => {
        clearUserState(ctx.from.id);
        const userId = ctx.from.id;
        const userStatus = await getUserStatusCached(dbPool, userId);

        if (!userStatus || !userStatus.is_verified) {
            await sendTempMessage(ctx, '❌ Conta não validada');
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
    ['50', '100', '200', '500'].forEach(amount => {
        bot.command(amount, async (ctx) => {
            clearUserState(ctx.from.id);
            const userId = ctx.from.id;
            const userStatus = await getUserStatusCached(dbPool, userId);

            if (!userStatus || !userStatus.is_verified) {
                await sendTempMessage(ctx, '❌ Conta não validada');
                return;
            }

            const value = parseFloat(amount);
            if (value > userStatus.available_today) {
                await sendTempMessage(ctx, `❌ Limite disponível: R$ ${userStatus.available_today.toFixed(2)}`);
                return;
            }

            await processPayment(ctx, value, userStatus, dbPool, expectationMessageQueue, expirationQueue);
        });
    });

    // ===== PROCESSAMENTO DE PAGAMENTO =====

    const processPayment = async (ctx, amount, userStatus, dbPool, expectationQueue, expirationQueue) => {
        const userId = ctx.from.id;
        const loadingMsg = await ctx.reply('⏳ Gerando QR Code...');

        try {
            // Verificar limites
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
            const pixData = await depixApiService.generatePixForDeposit(
                amountInCents,
                userLiquidAddress,
                webhookUrl,
                userInfo
            );

            // Salvar transação
            const dbResult = await dbPool.query(
                'INSERT INTO pix_transactions (user_id, requested_brl_amount, depix_amount_expected, pix_qr_code_payload, payment_status, depix_api_entry_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING transaction_id',
                [userId, amount, (amount - 0.99), pixData.qrCopyPaste, 'PENDING', pixData.id]
            );
            const internalTxId = dbResult.rows[0].transaction_id;

            // Jobs de expiração
            const reminderJobId = `expectation-${pixData.id}`;
            await expectationQueue.add(reminderJobId, {
                telegramUserId: userId,
                depixApiEntryId: pixData.id,
                supportContact: escapeMarkdownV2(config.links.supportContact)
            }, {
                delay: 19 * 60 * 1000,
                removeOnComplete: true,
                removeOnFail: true,
                jobId: reminderJobId
            });

            const expirationJobId = `expiration-${pixData.id}`;
            await expirationQueue.add(expirationJobId, {
                telegramUserId: userId,
                depixApiEntryId: pixData.id,
                requestedBrlAmount: amount
            }, {
                delay: 19 * 60 * 1000,
                removeOnComplete: true,
                removeOnFail: true,
                jobId: expirationJobId
            });

            // QR Code MINIMALISTA
            const caption = `📱 **PIX de R\\$ ${escapeMarkdownV2(amount.toFixed(2))}**\n` +
                          `⏱ Expira em 19 minutos`;

            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📋 Copiar código', `show_pix_code:${pixData.id}`)],
                [Markup.button.callback('❌ Cancelar', `cancel_qr:${pixData.id}`)]
            ]);

            const qrPhotoMessage = await ctx.replyWithPhoto(pixData.qrImageUrl, {
                caption: caption,
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });

            await dbPool.query(
                'UPDATE pix_transactions SET qr_code_message_id = $1 WHERE transaction_id = $2',
                [qrPhotoMessage.message_id, internalTxId]
            );

            // Guardar código PIX para botão copiar
            awaitingInputForUser[`pix_${pixData.id}`] = pixData.qrCopyPaste;

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

    // ===== HANDLERS DE TEXTO =====

    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        const telegramUserId = ctx.from.id;
        const telegramUsername = ctx.from.username || 'N/A';
        const userState = awaitingInputForUser[telegramUserId];

        if (text.startsWith('/')) {
            clearUserState(telegramUserId);
            return;
        }

        // AUTO-DETECTAR ENDEREÇO LIQUID
        if (!userState && text.length > 40 && text.startsWith('lq')) {
            if (isValidLiquidAddress(text)) {
                const keyboard = Markup.inlineKeyboard([
                    [
                        Markup.button.callback('✅ Sim', `confirm_address:${telegramUserId}`),
                        Markup.button.callback('❌ Não', 'cancel_address')
                    ]
                ]);

                // Guardar endereço temporariamente
                awaitingInputForUser[`temp_address_${telegramUserId}`] = text;

                await ctx.reply(
                    `🔍 Detectei uma carteira Liquid!\n\nUsar este endereço?`,
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

        // Processar entrada de valor
        if (userState && userState.type === 'amount') {
            const validation = InputValidator.validateMonetaryAmount(text, {
                minValue: 1,
                maxValue: userState.maxAllowed || 5000,
                maxDecimals: 2
            });

            if (validation.valid) {
                const amount = validation.value;
                const userStatus = await getUserStatusCached(dbPool, telegramUserId);
                await processPayment(ctx, amount, userStatus, dbPool, expectationMessageQueue, expirationQueue);
                clearUserState(telegramUserId);
            } else {
                // Validação inline
                if (userState.messageIdToEdit) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        userState.messageIdToEdit,
                        undefined,
                        `❌ Digite entre R$ 1 e R$ ${userState.maxAllowed.toFixed(2)}`
                    );
                } else {
                    await sendTempMessage(ctx, `❌ Digite entre R$ 1 e R$ ${userState.maxAllowed.toFixed(2)}`);
                }
            }
        }
        // Processar endereço Liquid
        else if (userState && (userState.type === 'liquid_address_initial' || userState.type === 'liquid_address_change')) {
            if (isValidLiquidAddress(text)) {
                try {
                    await dbPool.query(
                        'INSERT INTO users (telegram_id, telegram_username, liquid_address, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_id) DO UPDATE SET liquid_address = EXCLUDED.liquid_address, telegram_username = EXCLUDED.telegram_username, updated_at = NOW()',
                        [telegramUserId, telegramUsername, text]
                    );

                    logger.info(`User ${telegramUserId} set Liquid address`);

                    await ctx.reply('✅ Carteira configurada!');
                    clearUserState(telegramUserId);

                    // Invalidar cache
                    userStatusCache.delete(telegramUserId);

                    await sendMainMenu(ctx);
                } catch (error) {
                    logError('save_address', error, ctx);
                    await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
                }
            } else {
                await sendTempMessage(ctx, '❌ Endereço inválido');
            }
        }
    });

    // ===== ACTIONS =====

    // Confirmar endereço auto-detectado
    bot.action(/^confirm_address:(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const userId = parseInt(ctx.match[1]);

        if (userId !== ctx.from.id) {
            await ctx.answerCbQuery('❌ Ação inválida', true);
            return;
        }

        const address = awaitingInputForUser[`temp_address_${userId}`];
        if (address) {
            try {
                await dbPool.query(
                    'INSERT INTO users (telegram_id, telegram_username, liquid_address, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_id) DO UPDATE SET liquid_address = EXCLUDED.liquid_address, telegram_username = EXCLUDED.telegram_username, updated_at = NOW()',
                    [userId, ctx.from.username || 'N/A', address]
                );

                delete awaitingInputForUser[`temp_address_${userId}`];
                userStatusCache.delete(userId);

                await ctx.editMessageText('✅ Carteira configurada!');
                await sendMainMenu(ctx);
            } catch (error) {
                logError('confirm_address', error, ctx);
                await ctx.editMessageText('❌ Ops! Tente novamente.');
            }
        }
    });

    // Cancelar endereço auto-detectado
    bot.action('cancel_address', async (ctx) => {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        delete awaitingInputForUser[`temp_address_${userId}`];
        await ctx.deleteMessage();
    });

    // Comprar Depix - COM BOTÕES DE VALORES RÁPIDOS
    bot.action('receive_pix_start', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const userId = ctx.from.id;
            const userStatus = await getUserStatusCached(dbPool, userId);

            // Verificações
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
                 WHERE user_id = $1 AND payment_status = 'PENDING'
                 AND created_at > NOW() - INTERVAL '20 minutes'
                 ORDER BY created_at DESC LIMIT 1`,
                [userId]
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

            // Botão com 100% do disponível
            if (effectiveMax >= 1) {
                buttons.push([Markup.button.callback(
                    `💯 R$ ${effectiveMax.toFixed(2)}`,
                    `quick_amount:${effectiveMax.toFixed(2)}`
                )]);
            }

            // Botão com 50% do disponível
            const halfAmount = effectiveMax / 2;
            if (halfAmount >= 1) {
                buttons.push([Markup.button.callback(
                    `➗ R$ ${halfAmount.toFixed(2)}`,
                    `quick_amount:${halfAmount.toFixed(2)}`
                )]);
            }

            // Valor personalizado
            buttons.push([Markup.button.callback('✏️ Outro valor', 'custom_amount')]);
            buttons.push([Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]);

            const keyboard = Markup.inlineKeyboard(buttons);

            const message = `💸 **Comprar Depix**\n━━━━━━━━━━\n` +
                          `Disponível: R\\$ ${escapeMarkdownV2(available.toFixed(2))}\n\n` +
                          `Escolha o valor:`;

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });

        } catch (error) {
            logError('receive_pix_start', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Processar valor rápido
    bot.action(/^quick_amount:(.+)$/, async (ctx) => {
        const amount = parseFloat(ctx.match[1]);
        await ctx.answerCbQuery();
        const userStatus = await getUserStatusCached(dbPool, ctx.from.id);
        await processPayment(ctx, amount, userStatus, dbPool, expectationMessageQueue, expirationQueue);
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

    // Mostrar código PIX
    bot.action(/^show_pix_code:(.+)$/, async (ctx) => {
        const pixId = ctx.match[1];
        const pixCode = awaitingInputForUser[`pix_${pixId}`];

        if (pixCode) {
            await ctx.answerCbQuery();
            await ctx.reply(`\`${pixCode}\``, { parse_mode: 'MarkdownV2' });
        } else {
            await ctx.answerCbQuery('❌ Código não encontrado', true);
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
                // Notificação proativa
                nextLevelInfo = `\n🎉 **Nível ${upgradeCheck.new_level}\\!**`;
                userStatusCache.delete(userId); // Limpar cache após upgrade
            } else if (userStatus.reputation_level < 10) {
                if (percentUsed >= 100) {
                    nextLevelInfo = `\n📈 Aguarde 24h para subir de nível`;
                } else {
                    const remaining = 100 - percentUsed;
                    nextLevelInfo = `\n📈 Use mais ${remaining.toFixed(0)}%`;
                }
            }

            const message = `📊 **Status**\n━━━━━━━\n` +
                          `⭐ Nível ${userStatus.reputation_level}/10\n` +
                          `💰 R\\$ ${escapeMarkdownV2(userStatus.available_today.toFixed(2))} disponível\n\n` +
                          `**Hoje:**\n` +
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
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Carteira - SIMPLIFICADO
    bot.action('my_wallet', async (ctx) => {
        clearUserState(ctx.from.id);
        try {
            await ctx.answerCbQuery();
            const { rows } = await dbPool.query(
                'SELECT liquid_address FROM users WHERE telegram_id = $1',
                [ctx.from.id]
            );

            if (rows.length > 0 && rows[0].liquid_address) {
                const address = rows[0].liquid_address;
                const shortAddress = `${address.substring(0, 10)}...${address.substring(address.length - 10)}`;

                const message = `💼 **Carteira**\n━━━━━━━\n\`${escapeMarkdownV2(shortAddress)}\``;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('📜 Histórico', 'transaction_history')],
                    [Markup.button.callback('🔄 Alterar', 'change_wallet_start')],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);

                await ctx.editMessageText(message, {
                    parse_mode: 'MarkdownV2',
                    reply_markup: keyboard.reply_markup
                });
            } else {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Adicionar carteira', 'ask_liquid_address')],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);
                await ctx.editMessageText('❌ Sem carteira configurada', {
                    reply_markup: keyboard.reply_markup
                });
            }
        } catch (error) {
            logError('my_wallet', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Histórico - APENAS 3 ÚLTIMAS
    bot.action('transaction_history', async (ctx) => {
        clearUserState(ctx.from.id);
        try {
            await ctx.answerCbQuery();

            const { rows: transactions } = await dbPool.query(
                `SELECT requested_brl_amount, payment_status, created_at
                 FROM pix_transactions WHERE user_id = $1
                 ORDER BY created_at DESC LIMIT 3`,
                [ctx.from.id]
            );

            let message = `📜 **Histórico**\n━━━━━━━\n`;

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
                    const status = tx.payment_status === 'PAID' ? '✅' :
                                 tx.payment_status === 'PENDING' ? '⏳' : '❌';
                    message += `${status} ${escapeMarkdownV2(date)} • R\\$ ${escapeMarkdownV2(tx.requested_brl_amount.toFixed(2))}\n`;
                });
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar', 'my_wallet')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });

        } catch (error) {
            logError('transaction_history', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Por que validar - SIMPLIFICADO
    bot.action('why_validate', async (ctx) => {
        await ctx.answerCbQuery();

        const message = `❓ **Por que validar?**\n\n` +
                       `✅ Anti\\-fraude\n` +
                       `🔐 Seus dados privados\n` +
                       `💰 Até R\\$ 6\\.020/dia\n` +
                       `⚡ R\\$ 1 único\n\n` +
                       `_Você mantém controle total_`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Validar', 'start_validation')],
            [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
        ]);

        await ctx.editMessageText(message, {
            parse_mode: 'MarkdownV2',
            reply_markup: keyboard.reply_markup
        });
    });

    // Sobre - SIMPLIFICADO
    bot.action('about_bridge', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const aboutMessage = `ℹ️ **Bridge Atlas**\n━━━━━━━\n\n` +
                               `🔐 100% privado\n` +
                               `⚡ Taxa: R\\$0,99\n` +
                               `🌐 Código aberto\n\n` +
                               `💝 **Doações:**\n` +
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
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Voltar ao menu - SEM CONFIRMAÇÃO
    bot.action('back_to_main_menu', async (ctx) => {
        clearUserState(ctx.from.id);
        await ctx.answerCbQuery();
        await sendMainMenu(ctx);
    });

    // Adicionar endereço Liquid
    bot.action('ask_liquid_address', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            const message = 'Cole seu endereço Liquid:';
            const sentMessage = await ctx.editMessageText(message);
            awaitingInputForUser[ctx.from.id] = {
                type: 'liquid_address_initial',
                messageIdToEdit: sentMessage.message_id
            };
            await ctx.answerCbQuery();
        } catch (error) {
            logError('ask_liquid_address', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Alterar carteira
    bot.action('change_wallet_start', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const message = 'Cole o novo endereço:';
            const sentMessage = await ctx.editMessageText(message);
            awaitingInputForUser[ctx.from.id] = {
                type: 'liquid_address_change',
                messageIdToEdit: sentMessage.message_id
            };
        } catch (error) {
            logError('change_wallet_start', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Explicar carteira Liquid
    bot.action('explain_liquid_wallet', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const message = `📱 **Criar Carteira**\n\n` +
                          `Recomendamos:\n` +
                          `• **Aqua Wallet** \\(iOS/Android\\)\n` +
                          `• **SideSwap** \\(Desktop/Mobile\\)\n\n` +
                          `Após criar, volte com seu endereço\\!`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar', 'back_to_start_config')],
                [Markup.button.url('💬 Ajuda', config.links.communityGroup)]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });
        } catch (error) {
            logError('explain_liquid_wallet', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Voltar à configuração inicial
    bot.action('back_to_start_config', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();
            const messageText = `Você já tem uma carteira Liquid?`;
            await ctx.editMessageText(messageText, {
                reply_markup: initialConfigKeyboardObj.reply_markup
            });
        } catch (error) {
            logError('back_to_start_config', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Validação - SIMPLIFICADA
    bot.action('start_validation', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const userId = ctx.from.id;
            const userStatus = await getUserStatusCached(dbPool, userId);

            if (userStatus && userStatus.is_verified) {
                await ctx.editMessageText('✅ Já validada!');
                setTimeout(() => sendMainMenu(ctx), 1500);
                return;
            }

            // Verificar validação pendente
            const pendingCheck = await dbPool.query(
                `SELECT depix_api_entry_id FROM verification_transactions
                 WHERE telegram_user_id = $1 AND verification_status = 'PENDING'
                 AND created_at > NOW() - INTERVAL '11 minutes'
                 LIMIT 1`,
                [userId]
            );

            if (pendingCheck.rows.length > 0) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancelar', `cancel_verification:${pendingCheck.rows[0].depix_api_entry_id}`)],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);
                await ctx.editMessageText('⏳ Validação pendente', {
                    reply_markup: keyboard.reply_markup
                });
                return;
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Continuar', 'confirm_validation')],
                [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
            ]);

            await ctx.editMessageText(
                `🔐 **Validação**\n\n` +
                `• R\\$ 1,00 único\n` +
                `• Libera até R\\$ 6\\.020/dia\n` +
                `• 100% privado\n\n` +
                `Continuar?`,
                {
                    parse_mode: 'MarkdownV2',
                    reply_markup: keyboard.reply_markup
                }
            );

        } catch (error) {
            logError('start_validation', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Confirmar validação
    bot.action('confirm_validation', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const userId = ctx.from.id;

            // Verificar carteira
            const userCheck = await dbPool.query(
                'SELECT liquid_address FROM users WHERE telegram_id = $1',
                [userId]
            );

            if (!userCheck.rows[0]?.liquid_address) {
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);
                await ctx.editMessageText('❌ Configure carteira primeiro', {
                    reply_markup: keyboard.reply_markup
                });
                return;
            }

            const liquidAddress = userCheck.rows[0].liquid_address;

            // Gerar QR de validação
            await ctx.editMessageText('⏳ Gerando validação...');

            const webhookUrl = `${config.app.baseUrl}/webhooks/depix_payment`;
            const pixData = await depixApiService.generatePixForDeposit(100, liquidAddress, webhookUrl, {});

            // Salvar transação de verificação
            const verificationResult = await securityService.createVerificationTransaction(
                dbPool,
                userId,
                pixData.qrCopyPaste,
                pixData.id
            );

            if (!verificationResult.success) {
                await ctx.editMessageText('❌ Erro. Tente novamente.');
                return;
            }

            // QR minimalista
            const qrMessage = await ctx.replyWithPhoto(pixData.qrImageUrl, {
                caption: `🔐 **Validação**\n\n` +
                        `💵 R\\$ 1,00\n` +
                        `⏱ 10 minutos\n\n` +
                        `\`${escapeMarkdownV2(pixData.qrCopyPaste)}\``,
                parse_mode: 'MarkdownV2'
            });

            // Atualizar message ID
            await dbPool.query(
                'UPDATE verification_transactions SET qr_code_message_id = $1 WHERE verification_id = $2',
                [qrMessage.message_id, verificationResult.verificationId]
            );

            // Job de expiração
            await expirationQueue.add(
                `verification-expiration-${pixData.id}`,
                { qrId: pixData.id, userId: userId, isVerification: true },
                { delay: 10 * 60 * 1000 }
            );

        } catch (error) {
            logError('confirm_validation', error, ctx);
            await sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });

    // Cancelar verificação
    bot.action(/^cancel_verification:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const depixApiEntryId = ctx.match[1];
            const userId = ctx.from.id;

            await dbPool.query(
                'UPDATE verification_transactions SET verification_status = $1 WHERE depix_api_entry_id = $2 AND telegram_user_id = $3',
                ['CANCELLED', depixApiEntryId, userId]
            );

            await ctx.editMessageText('✅ Cancelado');
            await sendMainMenu(ctx);

        } catch (error) {
            logError('cancel_verification', error, ctx);
            await ctx.answerCbQuery('❌ Erro', true);
        }
    });

    // Cancelar QR
    bot.action(/^cancel_qr:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const qrId = ctx.match[1];
            const userId = ctx.from.id;

            await dbPool.query(
                'UPDATE pix_transactions SET payment_status = $1 WHERE depix_api_entry_id = $2 AND user_id = $3',
                ['CANCELLED', qrId, userId]
            );

            await ctx.deleteMessage();
            await ctx.reply('✅ Cancelado');

        } catch (error) {
            logError('cancel_qr', error, ctx);
            await ctx.answerCbQuery('❌ Erro', true);
        }
    });

    // Cancelar e gerar novo
    bot.action(/^cancel_and_generate:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const qrId = ctx.match[1];
            const userId = ctx.from.id;

            await dbPool.query(
                'UPDATE pix_transactions SET payment_status = $1 WHERE depix_api_entry_id = $2 AND user_id = $3',
                ['CANCELLED', qrId, userId]
            );

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💸 Novo QR', 'receive_pix_start')],
                [Markup.button.callback('⬅️ Menu', 'back_to_main_menu')]
            ]);

            await ctx.editMessageText('✅ Cancelado', {
                reply_markup: keyboard.reply_markup
            });

        } catch (error) {
            logError('cancel_and_generate', error, ctx);
            await ctx.answerCbQuery('❌ Erro', true);
        }
    });

    // Handler global de erros
    bot.catch((err, ctx) => {
        logError('Global error', err, ctx);
        if (!err.message?.includes("query is too old") && !err.message?.includes("message is not modified")) {
            sendTempMessage(ctx, '❌ Ops! Tente novamente.');
        }
    });
};

module.exports = registerBotHandlers;