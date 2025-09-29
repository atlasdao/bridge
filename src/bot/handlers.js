const { Markup } = require('telegraf');
const config = require('../core/config');
const logger = require('../core/logger');
const depixApiService = require('../services/depixApiService');
const depixMonitor = require('../services/depixMonitor');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const securityService = require('../services/securityService');
const { generateCustomQRCode } = require('../services/qrCodeGenerator');
const uxService = require('../services/userExperienceService');

const isValidLiquidAddress = (address) => {
    // Basic Liquid address validation
    if (!address || typeof address !== 'string') {
        logger.info(`[isValidLiquidAddress] Invalid: not a string`);
        return false;
    }
    if (address.length < 34 || address.length > 74) {
        logger.info(`[isValidLiquidAddress] Invalid: wrong length`);
        return false;
    }
    return true;
};

const validateMonetaryAmount = (value, options = {}) => {
    const { minValue = 0, maxValue = Number.MAX_VALUE, maxDecimals = 2 } = options;

    // Remove any currency symbols and spaces
    const cleanValue = String(value).replace(/[R$\s]/g, '').replace(',', '.');

    // Check if it's a valid number
    const numValue = parseFloat(cleanValue);
    if (isNaN(numValue)) {
        return { valid: false, error: 'Valor inválido. Use apenas números.' };
    }

    // Check decimal places
    const decimalPart = cleanValue.split('.')[1];
    if (decimalPart && decimalPart.length > maxDecimals) {
        return { valid: false, error: `Máximo de ${maxDecimals} casas decimais permitidas.` };
    }

    // Check range
    if (numValue < minValue) {
        return { valid: false, error: `Valor mínimo é R$ ${minValue.toFixed(2)}` };
    }

    if (numValue > maxValue) {
        return { valid: false, error: `Valor máximo é R$ ${maxValue.toFixed(2)}` };
    }

    return { valid: true, value: numValue };
};

let awaitingInputForUser = {}; 

const registerBotHandlers = (bot, dbPool, expectationMessageQueue, expirationQueue) => {
    const logError = (handlerName, error, ctx) => {
        const userId = ctx?.from?.id || 'N/A';
        logger.error(`Error in ${handlerName} for user ${userId}: ${error.message}`);
        if (error.stack) {
            logger.error(error.stack);
        }
    };

    // Helper function to send auto-deleting error messages
    const sendTempError = async (ctx, message = 'Ops! Tente novamente.', timeout = 5000) => {
        try {
            const msg = await ctx.reply(message);
            setTimeout(async () => {
                try {
                    await ctx.deleteMessage(msg.message_id);
                } catch (e) {
                    // Message may already be deleted
                }
            }, timeout);
        } catch (e) {
            logger.error('Failed to send temp error:', e);
        }
    };

    // Menu principal para usuários validados
    const mainMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('💸 Comprar Depix Liquid', 'receive_pix_start')],
        [Markup.button.callback('📊 Meu Status', 'user_status')],
        [Markup.button.callback('💼 Minha Carteira', 'my_wallet')],
        [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
        [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
    ]);

    // Menu para usuários não validados (só aparece após cadastrar wallet)
    const unverifiedMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Validar Minha Conta', 'start_validation')],
        [Markup.button.callback('ℹ️ Por que validar?', 'why_validate')],
        [Markup.button.callback('💼 Minha Carteira', 'my_wallet')],
        [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
    ]);

    // Menu de configuração inicial
    const initialConfigKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Já tenho uma carteira Liquid', 'ask_liquid_address')],
        [Markup.button.callback('❌ Ainda não tenho uma carteira Liquid', 'explain_liquid_wallet')],
        [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
        [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
    ]);

    const sendMainMenu = async (ctx, messageText = null) => {
        try {
            const userId = ctx.from?.id;
            
            // Verificar se o usuário está validado
            const userStatus = await securityService.getUserStatus(dbPool, userId);
            
            let keyboard, message;
            
            if (!userStatus || !userStatus.liquid_address) {
                // Usuário sem wallet cadastrada - redirecionar para configuração inicial
                message = messageText || 'Você precisa configurar sua carteira primeiro.';
                keyboard = initialConfigKeyboardObj;
            } else if (!userStatus.is_verified) {
                // Usuário com wallet mas não validado
                message = messageText || `🔐 **Conta não validada**\n\n` +
                    `Para usar o Bridge e realizar transações, você precisa validar sua conta primeiro\\.\n\n` +
                    `A validação é rápida e serve para confirmar que você não é um robô\\.\n\n` +
                    `Após validar, você terá acesso a todas as funcionalidades com limite inicial de R\\$ 50/dia\\.`;
                keyboard = unverifiedMenuKeyboardObj;
            } else if (userStatus.is_banned) {
                // Usuário banido
                message = `🚫 **Conta Banida**\n\n` +
                    `Sua conta foi banida do sistema\\.\n` +
                    `Motivo: ${escapeMarkdownV2(userStatus.ban_reason || 'Violação dos termos de uso')}\n\n` +
                    `Entre em contato com o suporte: ${escapeMarkdownV2(config.links.supportContact)}`;
                keyboard = Markup.inlineKeyboard([
                    [Markup.button.url('📞 Contatar Suporte', `https://t.me/${config.links.supportContact.replace('@', '')}`)]
                ]);
            } else {
                // Usuário validado - menu completo
                message = messageText || `✅ Bem-vindo de volta!\n\nO que você gostaria de fazer hoje?`;
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
            if (!ctx.headersSent) await sendTempError(ctx);
        }
    };

    const clearUserState = (userId) => {
        if (userId) delete awaitingInputForUser[userId];
    };

    const setUserState = (userId, state) => {
        if (userId) awaitingInputForUser[userId] = state;
    };
    
    bot.start(async (ctx) => {
        clearUserState(ctx.from.id);
        const telegramUserId = ctx.from.id;
        const telegramUsername = ctx.from.username || null;
        const firstName = ctx.from.first_name || null;
        const lastName = ctx.from.last_name || null;
        const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;

        // Verificar blacklist unificada ANTES de criar o usuário
        try {
            const blacklistCheck = await securityService.checkBlacklist(dbPool, {
                telegram_id: telegramUserId,
                telegram_username: telegramUsername,
                full_name: fullName
            });

            if (blacklistCheck.isBanned) {
                let message = `🚫 **Acesso Negado**\n\n` +
                    `Sua conta está bloqueada de usar este serviço\\.\n\n` +
                    `Motivo: ${escapeMarkdownV2(blacklistCheck.reason || 'Violação dos termos de uso')}`;

                // Se for ban temporário, mostrar quando expira
                if (blacklistCheck.banType === 'temporary' && blacklistCheck.expiresAt) {
                    const expiresDate = new Date(blacklistCheck.expiresAt);
                    message += `\n\nBloqueio expira em: ${escapeMarkdownV2(expiresDate.toLocaleDateString('pt-BR'))}`;
                }

                message += `\n\nSe você acredita que isso é um erro, entre em contato com o suporte: ${escapeMarkdownV2(config.links.supportContact)}`;

                await ctx.reply(message, { parse_mode: 'MarkdownV2' });
                logger.warn(`Blocked user attempted to start bot - Username: ${telegramUsername}, ID: ${telegramUserId}, Reason: ${blacklistCheck.reason}, Matched field: ${blacklistCheck.matchedField}`);
                return;
            }
        } catch (error) {
            logger.error('Error checking blacklist:', error);
            // Continuar mesmo se houver erro na verificação da blacklist
        }

        // Verificar se tem username
        if (!telegramUsername) {
            await ctx.reply('❌ Você precisa ter um username no Telegram para usar este bot.\n\n' +
                           'Para adicionar um username:\n' +
                           '1. Vá em Configurações\n' +
                           '2. Toque em "Nome de usuário"\n' +
                           '3. Escolha um nome único\n' +
                           '4. Depois volte e digite /start novamente');
            return;
        }

        logger.info(`User ${telegramUserId} (${telegramUsername}) started the bot.`);
        try {
            const { rows } = await dbPool.query(`
                SELECT liquid_address, telegram_username, total_transactions, reputation_level
                FROM users WHERE telegram_user_id = $1
            `, [telegramUserId]);

            if (rows.length > 0 && rows[0].liquid_address) {
                // Returning user - show personalized welcome with progress
                const user = rows[0];
                let welcomeMsg = `Bem-vindo de volta! 🎯\n`;

                if (user.total_transactions > 0) {
                    welcomeMsg += `📊 Transações: ${user.total_transactions}\n`;
                }
                if (user.reputation_level > 1) {
                    welcomeMsg += `⭐ Nível ${user.reputation_level}\n`;
                }
                welcomeMsg += `\nO que você gostaria de fazer hoje?`;

                await sendMainMenu(ctx, welcomeMsg);
            } else {
                const initialMessage = `🌟 **Bridge Atlas**\n\n` +
                                      `Configure sua carteira Liquid para começar\\.`;
                await ctx.replyWithMarkdownV2(initialMessage, initialConfigKeyboardObj);
                if (rows.length === 0) {
                    await dbPool.query('INSERT INTO users (telegram_user_id, telegram_id, telegram_username) VALUES ($1, $2, $3) ON CONFLICT (telegram_user_id) DO UPDATE SET telegram_username = EXCLUDED.telegram_username, telegram_id = EXCLUDED.telegram_id', [telegramUserId, telegramUserId, telegramUsername || 'N/A']);
                    logger.info(`User ${telegramUserId} (${telegramUsername}) newly registered in DB (no address yet).`);
                } else if ((rows[0] && !rows[0].telegram_username && telegramUsername !== 'N/A') || (rows[0]?.telegram_username !== telegramUsername)) {
                    await dbPool.query('UPDATE users SET telegram_username = $1, updated_at = NOW() WHERE telegram_user_id = $2', [telegramUsername, telegramUserId]);
                    logger.info(`User ${telegramUserId} username updated to ${telegramUsername}.`);
                }
            }
        } catch (error) {
            logError('/start', error, ctx);
            try { await sendTempError(ctx); } catch (e) { logError('/start fallback reply', e, ctx); }
        }
    });

    // Quick shortcuts for common actions
    // Comando /qr para gerar QR code com qualquer valor
    bot.command('qr', async (ctx) => {
        try {
            const telegramUserId = ctx.from.id;
            clearUserState(telegramUserId);

            // Extrair o valor do comando (ex: /qr 50 -> 50)
            const commandText = ctx.message.text.trim();
            const parts = commandText.split(' ');

            if (parts.length < 2) {
                await ctx.reply('❌ Use: /qr valor\nExemplo: /qr 50');
                await sendMainMenu(ctx);
                return;
            }

            const value = parts[1].replace(',', '.');

            // Verificar se o usuário pode fazer transações
            const userCheck = await dbPool.query(
                'SELECT * FROM users WHERE telegram_user_id = $1',
                [telegramUserId]
            );

            if (userCheck.rows.length === 0 || !userCheck.rows[0].is_verified) {
                await ctx.reply('❌ Você precisa validar sua conta primeiro. Use /start');
                return;
            }

            // Validar se é um número válido
            const numValue = parseFloat(value);
            if (isNaN(numValue) || numValue <= 0) {
                await ctx.reply('❌ Valor inválido. Use: /qr valor\nExemplo: /qr 50');
                return;
            }

            // Processar como valor direto
            setUserState(telegramUserId, { type: 'amount' });
            ctx.message.text = value;
            // Reprocessar a mensagem
            const updateId = Date.now();
            await bot.handleUpdate({
                update_id: updateId,
                message: {
                    ...ctx.message,
                    text: value,
                    from: ctx.from,
                    chat: ctx.chat,
                    date: Math.floor(Date.now() / 1000)
                }
            });
        } catch (error) {
            logError('command_qr', error, ctx);
            await sendTempError(ctx);
        }
    });



    bot.command('status', async (ctx) => {
        // Enhanced status check with progress indicators
        try {
            const telegramUserId = ctx.from.id;
            const progress = await uxService.getUserProgress(dbPool, telegramUserId);

            if (!progress) {
                await ctx.reply('❌ Conta não encontrada. Use /start para começar.');
                return;
            }

            const { rows } = await dbPool.query(
                'SELECT is_verified FROM users WHERE telegram_user_id = $1',
                [telegramUserId]
            );

            if (rows.length === 0 || !rows[0].is_verified) {
                await ctx.reply('❌ Conta não verificada. Use /start para começar.');
                return;
            }

            const available = progress.dailyLimit - progress.dailyUsed;

            // Create enhanced status message
            let statusMessage = `📊 **Status Completo**\n\n`;

            // Level and XP progress
            statusMessage += `⭐ **Nível ${progress.level}**\n`;
            statusMessage += `${progress.levelProgressBar} ${progress.levelProgress.toFixed(0)}%\n`;
            statusMessage += `XP: ${progress.xp} / ${progress.xpNeeded}\n\n`;

            // Daily usage
            statusMessage += `💰 **Limite Diário**\n`;
            statusMessage += `${progress.dailyProgressBar} ${progress.dailyProgress.toFixed(0)}%\n`;
            statusMessage += `Disponível: R$ ${available.toFixed(2)}\n`;
            statusMessage += `Usado hoje: R$ ${progress.dailyUsed.toFixed(2)}\n\n`;

            // Stats
            statusMessage += `📈 **Estatísticas**\n`;
            statusMessage += `Transações: ${progress.totalTransactions}\n`;
            if (progress.streak > 0) {
                statusMessage += `🔥 Sequência: ${progress.streak} dias\n`;
            }

            await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            logError('status_command', error, ctx);
            await sendTempError(ctx);
        }
    });

    bot.action('ask_liquid_address', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            const message = 'Por favor, digite ou cole o **endereço público da sua carteira Liquid** onde você deseja receber seus DePix\\.';
            const sentMessage = ctx.callbackQuery?.message ? await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' }) : await ctx.replyWithMarkdownV2(message);
            setUserState(ctx.from.id, { type: 'liquid_address_initial', messageIdToEdit: sentMessage?.message_id || null });
            await ctx.answerCbQuery();
        } catch (error) { 
            logError('ask_liquid_address', error, ctx); 
            if (!ctx.answered) { try { await ctx.answerCbQuery('Ops! Tente novamente.'); } catch(e){} }
            await ctx.replyWithMarkdownV2('Por favor, digite ou cole o **endereço público da sua carteira Liquid**\\.');
        }
    });

    bot.action('explain_liquid_wallet', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();
            const supportContactEscaped = escapeMarkdownV2(config.links.supportContact);
            const message = `Sem problemas\\! É fácil criar uma\\. O DePix opera na Liquid Network, uma rede lateral \\(sidechain\\) do Bitcoin\\.\n\nRecomendamos usar a **SideSwap** que é compatível com Liquid:\n\\- **Para desktop e mobile:** Acesse [sideswap\\.io](https://sideswap.io)\n\\- **Disponível para:** iOS, Android, Windows, Mac e Linux\n\nApós criar sua carteira, você terá um endereço Liquid\\. Volte aqui e selecione '${escapeMarkdownV2('[✅ Já tenho uma carteira Liquid]')}' para associá\\-lo ao bot\\.\n\nSe precisar de ajuda ou tiver dúvidas, contate nosso suporte: ${supportContactEscaped}`;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar à Configuração', 'back_to_start_config')],
                [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
                [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
            ]);
            if (ctx.callbackQuery?.message) await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup, disable_web_page_preview: true });
            else await ctx.replyWithMarkdownV2(message, keyboard);
        } catch (error) { 
            logError('explain_liquid_wallet', error, ctx); 
            await sendTempError(ctx);
        }
    });

    bot.action('back_to_start_config', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            await ctx.answerCbQuery();
            const messageText = `Para receber seus DePix, precisamos saber o endereço da sua carteira Liquid. Você já tem uma?`;
            if (ctx.callbackQuery?.message) await ctx.editMessageText(messageText, { reply_markup: initialConfigKeyboardObj.reply_markup });
            else await ctx.reply(messageText, initialConfigKeyboardObj);
        } catch (error) { 
            logError('back_to_start_config', error, ctx); 
            await ctx.reply(`Para receber seus DePix, precisamos saber o endereço da sua carteira Liquid. Você já tem uma?`, initialConfigKeyboardObj);
        }
    });

    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        const telegramUserId = ctx.from.id;
        const telegramUsername = ctx.from.username || 'N/A';
        const userState = awaitingInputForUser[telegramUserId];

        if (text.startsWith('/')) { clearUserState(telegramUserId); return; }
        logger.info(`Text input from User ${telegramUserId}: "${text}" in state: ${JSON.stringify(userState)}`);
        
        // Apagar mensagem do usuário para manter o chat limpo (exceto comandos)
        if (userState && !text.startsWith('/')) {
            try {
                await ctx.deleteMessage();
            } catch (e) {
                // Ignorar erro se não conseguir apagar
            }
        }

        if (userState && userState.type === 'amount') {
            // Validação de segurança - limitar tentativas muito rápidas
            const now = Date.now();
            if (userState.lastAttempt && (now - userState.lastAttempt) < 1000) {
                await ctx.reply('⚠️ Aguarde um momento antes de tentar novamente.');
                return;
            }
            userState.lastAttempt = now;
            
            // Usar validação robusta de valores monetários
            const userStatusCheck = await securityService.getUserStatus(dbPool, telegramUserId);
            const maxAllowed = Math.min(
                userStatusCheck?.available_today || 50,
                userStatusCheck?.max_per_transaction_brl || 5000
            );

            // Validate monetary amount
            const validation = validateMonetaryAmount(text, {
                minValue: 1,
                maxValue: maxAllowed,
                maxDecimals: 2
            });

            if (validation.valid) {
                const amount = validation.value;
                logger.info(`Received amount ${amount} for deposit from user ${telegramUserId}`);
                let messageIdToUpdate = userState.messageIdToEdit;

                try {
                    let sentMsg;
                    const progressBar = uxService.formatProgressBar(20);
                    const progressMessage = `Verificando limites ${progressBar}`;

                    if (messageIdToUpdate) {
                        try {
                            sentMsg = await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, progressMessage);
                        } catch (e) {
                            // Se falhar ao editar (mensagem não existe mais), enviar nova
                            sentMsg = await ctx.reply(progressMessage);
                        }
                    } else {
                        sentMsg = await ctx.reply(progressMessage);
                    }
                    messageIdToUpdate = sentMsg.message_id;
                    
                    // Verificar se o usuário pode fazer a transação com base nos limites
                    const canTransact = await securityService.checkUserCanTransact(dbPool, telegramUserId, amount);
                    if (!canTransact.canTransact) {
                        clearUserState(telegramUserId);

                        // Verificar se usuário tem QRs pendentes
                        const pendingCheck = await dbPool.query(
                            'SELECT COUNT(*) as count FROM pix_transactions WHERE user_id = $1 AND payment_status = $2 AND created_at >= CURRENT_DATE',
                            [telegramUserId, 'PENDING']
                        );
                        const hasPendingQRs = parseInt(pendingCheck.rows[0].count) > 0;

                        // Decidir quais botões mostrar baseado na situação
                        const buttons = [];

                        // Se tem limite disponível, mostrar botão para gerar QR
                        if (canTransact.availableLimit >= 1) {
                            buttons.push([Markup.button.callback(
                                `💰 Gerar QR Code de R$ ${canTransact.availableLimit.toFixed(2)}`,
                                `generate_max_qr:${canTransact.availableLimit}`
                            )]);
                        }

                        // Se tem QRs pendentes, mostrar botão para apagar
                        if (hasPendingQRs) {
                            buttons.push([Markup.button.callback('🗑️ Apagar QR codes gerados', 'delete_pending_qrs')]);
                        }

                        // Se há botões para mostrar, criar keyboard
                        if (buttons.length > 0) {
                            const keyboard = Markup.inlineKeyboard(buttons);
                            await ctx.telegram.editMessageText(
                                ctx.chat.id,
                                messageIdToUpdate,
                                undefined,
                                `❌ ${canTransact.reason}`,
                                { reply_markup: keyboard.reply_markup }
                            );
                        } else {
                            // Sem botões, só mensagem
                            await ctx.telegram.editMessageText(
                                ctx.chat.id,
                                messageIdToUpdate,
                                undefined,
                                `❌ ${canTransact.reason}`
                            );
                        }
                        return;
                    }
                    
                    const progressBar2 = uxService.formatProgressBar(40);
                    await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, `Verificando DePix ${progressBar2}`);

                    // Verificar status mas não bloquear se offline
                    const depixOnline = await depixMonitor.getStatus();
                    if (!depixOnline) {
                        logger.warn('DePix appears offline but attempting to generate QR code anyway');
                    }

                    const progressBar3 = uxService.formatProgressBar(60);
                    await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, `Gerando QR Code ${progressBar3}`);
                                        
                    const userResult = await dbPool.query(
                        'SELECT liquid_address, payer_name, payer_cpf_cnpj FROM users WHERE telegram_user_id = $1',
                        [telegramUserId]
                    );
                    if (!userResult.rows.length || !userResult.rows[0].liquid_address) {
                        clearUserState(telegramUserId);
                        await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Sua carteira Liquid não foi encontrada. Use /start para configurar.');
                        return;
                    }

                    const userLiquidAddress = userResult.rows[0].liquid_address;
                    const amountInCents = Math.round(amount * 100);
                    const progressBar4 = uxService.formatProgressBar(80);
                    await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, `Finalizando ${progressBar4}`);

                    // Incluir dados do pagador se disponíveis (usuário verificado)
                    const userInfo = {};
                    if (userResult.rows[0].payer_name && userResult.rows[0].payer_cpf_cnpj) {
                        userInfo.payerName = userResult.rows[0].payer_name;
                        userInfo.payerDocument = userResult.rows[0].payer_cpf_cnpj;
                    }

                    const webhookUrl = `${config.app.baseUrl}/webhooks/depix_payment`;
                    const pixData = await depixApiService.generatePixForDeposit(amountInCents, userLiquidAddress, webhookUrl, userInfo);
                    const { qrCopyPaste, qrImageUrl, id: depixApiEntryId } = pixData;
                    
                    const dbResult = await dbPool.query( 'INSERT INTO pix_transactions (user_id, requested_brl_amount, depix_amount_expected, pix_qr_code_payload, payment_status, depix_api_entry_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING transaction_id', [telegramUserId, amount, (amount - 0.99), qrCopyPaste, 'PENDING', depixApiEntryId]);
                    const internalTxId = dbResult.rows[0].transaction_id;
                    logger.info(`Transaction ${internalTxId} for BRL ${amount.toFixed(2)} saved. DePix API ID: ${depixApiEntryId}`);

                    const reminderJobId = `expectation-${depixApiEntryId}`;
                    await expectationMessageQueue.add(reminderJobId, { telegramUserId, depixApiEntryId, supportContact: escapeMarkdownV2(config.links.supportContact) }, { delay: 19 * 60 * 1000, removeOnComplete: true, removeOnFail: true, jobId: reminderJobId });
                    
                    const expirationJobId = `expiration-${depixApiEntryId}`;
                    await expirationQueue.add(expirationJobId, { telegramUserId, depixApiEntryId, requestedBrlAmount: amount }, { delay: 19 * 60 * 1000, removeOnComplete: true, removeOnFail: true, jobId: expirationJobId });
                    logger.info(`Jobs added: Reminder (${reminderJobId}) and Expiration (${expirationJobId}) for user ${telegramUserId}`);

                    let caption = `💸 **PIX \\- R\\$ ${escapeMarkdownV2(amount.toFixed(2))}**\n\n`;
                    caption += `📱 Escaneie com seu banco\n`;
                    caption += `⏱️ Validade: 19 minutos\n\n`;
                    caption += `**PIX Copia e Cola:**\n`;
                    caption += `\`${escapeMarkdownV2(qrCopyPaste)}\``;
                    
                    await ctx.telegram.deleteMessage(ctx.chat.id, messageIdToUpdate);
                    
                    // Adicionar botão de cancelar
                    const keyboard = Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Cancelar', `cancel_qr:${depixApiEntryId}`)]
                    ]);

                    // Gerar QR code personalizado com logo Atlas
                    let qrPhotoMessage;
                    try {
                        const customQRBuffer = await generateCustomQRCode(qrCopyPaste, amount);
                        qrPhotoMessage = await ctx.replyWithPhoto(
                            { source: customQRBuffer },
                            {
                                caption: caption,
                                parse_mode: 'MarkdownV2',
                                reply_markup: keyboard.reply_markup
                            }
                        );
                        logger.info('QR code personalizado com logo Atlas enviado com sucesso');
                    } catch (qrError) {
                        logger.error('Erro ao gerar QR personalizado, usando QR do DePix:', qrError);
                        // Fallback para QR original do DePix
                        qrPhotoMessage = await ctx.replyWithPhoto(qrImageUrl, {
                            caption: caption,
                            parse_mode: 'MarkdownV2',
                            reply_markup: keyboard.reply_markup
                        });
                    }

                    await dbPool.query('UPDATE pix_transactions SET qr_code_message_id = $1 WHERE transaction_id = $2', [qrPhotoMessage.message_id, internalTxId]);
                    clearUserState(telegramUserId);

                } catch (apiError) {
                    clearUserState(telegramUserId);
                    logError('generate_pix_api_call_or_ping', apiError, ctx);
                    // Se falhou ao gerar o QR, mostrar mensagem de instabilidade
                    const errorReply = 'O serviço DePix parece estar instável. Tente novamente mais tarde.';
                    if (messageIdToUpdate) await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, errorReply);
                    else await ctx.reply(errorReply);
                }
            } else { 
                await ctx.replyWithMarkdownV2(`Valor inválido\\. Por favor, envie um valor entre R\\$ 1\\.00 e R\\$ ${escapeMarkdownV2(maxAllowed.toFixed(2))} \\(ex: \`45.21\`\\)\\.`);
            }
        } else if (userState && (userState.type === 'liquid_address_initial' || userState.type === 'liquid_address_change')) {
            if (isValidLiquidAddress(text)) {
                try {
                    await dbPool.query('INSERT INTO users (telegram_user_id, telegram_id, telegram_username, liquid_address, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (telegram_user_id) DO UPDATE SET liquid_address = EXCLUDED.liquid_address, telegram_username = EXCLUDED.telegram_username, telegram_id = EXCLUDED.telegram_id, updated_at = NOW()', [telegramUserId, telegramUserId, telegramUsername, text]);
                    logger.info(`User ${telegramUserId} associated/updated Liquid address: ${text}`);
                    const successMessage = 'Endereço Liquid associado com sucesso!';
                    let successMsg;
                    if (userState.messageIdToEdit) {
                        successMsg = await ctx.telegram.editMessageText(ctx.chat.id, userState.messageIdToEdit, undefined, successMessage);
                    } else {
                        successMsg = await ctx.reply(successMessage);
                    }
                    // Auto-deletar após 5 segundos
                    setTimeout(async () => {
                        try {
                            await ctx.deleteMessage(successMsg.message_id);
                        } catch (e) {
                            // Message may already be deleted
                        }
                    }, 5000);
                    clearUserState(telegramUserId); 
                    await sendMainMenu(ctx);
                } catch (error) { 
                    logError('text_handler (save_address)', error, ctx); 
                    await sendTempError(ctx);
                }
            } else {
                await ctx.replyWithMarkdownV2(`O endereço fornecido não parece ser uma carteira Liquid válida\\. Verifique o formato e tente novamente\\.`, Markup.inlineKeyboard([[Markup.button.callback('❌ Preciso de Ajuda com Carteira', 'explain_liquid_wallet')]]));
            }
        } else {
            // Estado desconhecido ou não tratado
            clearUserState(telegramUserId);
            await ctx.reply('❌ Comando não reconhecido. Por favor, use /start para começar.');
        }
    });

    bot.action('receive_pix_start', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();

            const userId = ctx.from.id;

            // Verificar username antes de prosseguir
            const username = ctx.from.username;
            if (!username) {
                await ctx.editMessageText('❌ Você precisa ter um username no Telegram para usar este bot.');
                return;
            }

            // Atualizar username se mudou
            await dbPool.query(
                'UPDATE users SET telegram_username = $1, updated_at = NOW() WHERE telegram_user_id = $2 AND telegram_username != $1',
                [username, userId]
            );
            
            // Verificar status completo do usuário
            const userStatus = await securityService.getUserStatus(dbPool, userId);
            
            // Verificar se já tem uma transação pendente (não expirada)
            const pendingCheck = await dbPool.query(
                `SELECT depix_api_entry_id, created_at 
                 FROM pix_transactions 
                 WHERE user_id = $1 
                   AND payment_status = $2 
                   AND created_at > NOW() - INTERVAL '20 minutes'
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [userId, 'PENDING']
            );
            
            if (pendingCheck.rows.length > 0) {
                const pendingTx = pendingCheck.rows[0];
                const message = `⚠️ **Você já tem um QR Code ativo**\n\n` +
                              `Complete ou cancele o pagamento anterior antes de gerar um novo\\.`;
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancelar pagamento anterior', `cancel_and_generate:${pendingTx.depix_api_entry_id}`)],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                return;
            }
            
            // Verificar se tem wallet
            if (!userStatus || !userStatus.liquid_address) {
                const message = "Você precisa associar uma carteira Liquid primeiro\\! Use o botão abaixo ou o comando /start para reconfigurar\\.";
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('✅ Associar Minha Carteira Liquid', 'ask_liquid_address')]]);
                if (ctx.callbackQuery?.message) await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                else await ctx.replyWithMarkdownV2(message, keyboard);
                return;
            }
            
            // Verificar se está banido
            if (userStatus.is_banned) {
                const message = `🚫 **Conta Banida**\n\n` +
                              `Sua conta está banida e não pode realizar transações\\.\n` +
                              `Motivo: ${escapeMarkdownV2(userStatus.ban_reason || 'Violação dos termos')}\n\n` +
                              `Entre em contato com o suporte: ${escapeMarkdownV2(config.links.supportContact)}`;
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]]);
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                return;
            }
            
            // Verificar se está validado
            if (!userStatus.is_verified) {
                const message = `🔐 **Conta não validada**\n\n` +
                              `Você precisa validar sua conta antes de realizar transações\\.\n\n` +
                              `A validação é rápida e custa apenas R\\$ 1,00\\.\n` +
                              `Você receberá 0,01 DEPIX de recompensa\\!`;
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Validar Agora', 'start_validation')],
                    [Markup.button.callback('❓ Por que validar?', 'why_validate')],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                return;
            }
            // Obter o limite disponível do usuário
            const dailyLimit = userStatus.daily_limit_brl || 50;
            const usedToday = userStatus.actual_daily_used || 0;
            const availableLimit = Math.max(0, dailyLimit - usedToday);
            const maxTransaction = userStatus.max_per_transaction_brl || availableLimit;
            const effectiveMax = Math.min(availableLimit, maxTransaction);
            
            // Criar botões de valores rápidos
            const buttons = [];

            // Botão de 100% do disponível
            if (effectiveMax >= 1) {
                buttons.push([Markup.button.callback(
                    `Gerar R$ ${effectiveMax.toFixed(2)}`,
                    `quick_amount:${effectiveMax.toFixed(2)}`
                )]);
            }

            // Botão de 50% do disponível
            const halfValue = effectiveMax / 2;
            if (halfValue >= 1) {
                buttons.push([Markup.button.callback(
                    `Gerar R$ ${halfValue.toFixed(2)}`,
                    `quick_amount:${halfValue.toFixed(2)}`
                )]);
            }

            // Botão de valor personalizado
            buttons.push([Markup.button.callback('✏️ Valor Personalizado', 'custom_amount')]);
            buttons.push([Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]);

            const keyboard = Markup.inlineKeyboard(buttons);

            const amountRequestMessage = `💵 **Escolha o valor:**\n\n` +
                                       `Disponível: R\\$ ${escapeMarkdownV2(availableLimit.toFixed(2))}\n` +
                                       `Taxa: R\\$ 0,99\n\n` +
                                       `💡 **Dica:** Gere QR codes rápido com /qr valor \\(ex: /qr 50\\)\\.\n\n` +
                                       `Selecione um valor ou digite personalizado:`;

            if (ctx.callbackQuery?.message) {
                await ctx.editMessageText(amountRequestMessage, {
                    parse_mode: 'MarkdownV2',
                    reply_markup: keyboard.reply_markup
                });
            } else {
                await ctx.replyWithMarkdownV2(amountRequestMessage, keyboard);
            }
        } catch (error) { 
            logError('receive_pix_start', error, ctx); 
            await sendTempError(ctx);
        }
    });

    // Handler para botões de valores rápidos
    bot.action(/^quick_amount:(.+)$/, async (ctx) => {
        try {
            const amount = ctx.match[1];
            const telegramUserId = ctx.from.id;

            await ctx.answerCbQuery();
            clearUserState(telegramUserId);

            // Mostrar mensagem de processamento com animação
            let loadingMessage;
            try {
                loadingMessage = await ctx.editMessageText(`⏳ Processando R$ ${amount}...`);
            } catch (e) {
                // Se falhar ao editar, enviar nova mensagem
                loadingMessage = await ctx.reply(`⏳ Processando R$ ${amount}...`);
            }

            // Animação de loading
            const loadingFrames = ['⏳', '⌛', '⏳', '⌛'];
            let frameIndex = 0;
            const animationInterval = setInterval(async () => {
                frameIndex = (frameIndex + 1) % loadingFrames.length;
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        loadingMessage.message_id,
                        undefined,
                        `${loadingFrames[frameIndex]} Processando R$ ${amount}...`
                    );
                } catch (e) {
                    // Parar se falhar (provavelmente mensagem já foi editada)
                    clearInterval(animationInterval);
                }
            }, 500);

            // Parar animação após 3 segundos no máximo
            setTimeout(() => clearInterval(animationInterval), 3000);

            // Definir estado com o messageId para continuar editando
            setUserState(telegramUserId, {
                type: 'amount',
                messageIdToEdit: loadingMessage.message_id
            });

            // Criar mensagem simulada e processar
            const fakeMessage = {
                text: amount,
                from: ctx.from,
                chat: ctx.chat,
                message_id: loadingMessage.message_id, // Usar o ID da mensagem real
                date: Math.floor(Date.now() / 1000)
            };

            // Aguardar um pouco para a animação aparecer
            setTimeout(() => {
                // Processar diretamente no handler de texto
                ctx.message = fakeMessage;
                bot.handleUpdate({
                    update_id: Date.now(),
                    message: fakeMessage
                });
            }, 100);

        } catch (error) {
            logError('quick_amount', error, ctx);
            await sendTempError(ctx);
        }
    });

    // Handler para valor personalizado
    bot.action('custom_amount', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const telegramUserId = ctx.from.id;

            const message = `Digite o valor em reais que deseja receber\\.\n\nExemplo: \`45.21\``;
            const sentMessage = await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' });

            setUserState(telegramUserId, {
                type: 'amount',
                messageIdToEdit: sentMessage?.message_id || null
            });
        } catch (error) {
            logError('custom_amount', error, ctx);
            await sendTempError(ctx);
        }
    });

    bot.action('my_wallet', async (ctx) => {
        clearUserState(ctx.from.id); 
        try {
            await ctx.answerCbQuery();
            const { rows } = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_user_id = $1', [ctx.from.id]);
            if (rows.length > 0 && rows[0].liquid_address) {
                const message = `**Minha Carteira Liquid Associada**\n\nSeu endereço para receber DePix é:\n\`${escapeMarkdownV2(rows[0].liquid_address)}\`\n\n*Lembre\\-se: Você tem total controle sobre esta carteira\\.*`;
                const keyboard = Markup.inlineKeyboard([
                       [Markup.button.callback('🔄 Alterar Carteira', 'change_wallet_start')],
                       [Markup.button.callback('📜 Histórico de Transações', 'transaction_history:0')],
                       [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
                if (ctx.callbackQuery?.message) await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                else await ctx.replyWithMarkdownV2(message, keyboard);
            } else { 
                const message = 'Você ainda não associou uma carteira Liquid\\. Configure uma primeiro\\.';
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('✅ Associar Carteira Liquid', 'ask_liquid_address')]]);
                if (ctx.callbackQuery?.message) await ctx.editMessageText(message, {parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup});
                else await ctx.replyWithMarkdownV2(message, keyboard);}
        } catch (error) { 
            if (error.message.includes("message is not modified")) return;
            logError('my_wallet', error, ctx); 
            await sendTempError(ctx);
        }
    });

    bot.action('change_wallet_start', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const message = 'OK\\! Por favor, envie seu **novo endereço público da carteira Liquid**\\.';
            const sentMessage = ctx.callbackQuery?.message ? await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' }) : await ctx.replyWithMarkdownV2(message);
            setUserState(ctx.from.id, { type: 'liquid_address_change', messageIdToEdit: sentMessage?.message_id || null });
        } catch (error) { 
            logError('change_wallet_start', error, ctx); 
            await sendTempError(ctx);
        }
    });
    
    // Simplified transaction history - only show last 3
    bot.action(/^transaction_history(?::(\d+))?$/, async (ctx) => {
        clearUserState(ctx.from.id);
        try {
            await ctx.answerCbQuery();
            const { rows: transactions } = await dbPool.query(
                `SELECT requested_brl_amount, payment_status, created_at
                 FROM pix_transactions
                 WHERE user_id = $1
                 ORDER BY created_at DESC
                 LIMIT 3`,
                [ctx.from.id]
            );

            let message = `📜 **Últimas Transações**\n\n`;

            if (transactions.length === 0) {
                message += `Nenhuma transação ainda\\.`;
            } else {
                transactions.forEach((tx) => {
                    const date = new Date(tx.created_at).toLocaleDateString('pt-BR');
                    const status = tx.payment_status === 'CONFIRMED' || tx.payment_status === 'PAID' ? '✅' :
                                 tx.payment_status === 'PENDING' ? '⏳' : '❌';
                    const amount = parseFloat(tx.requested_brl_amount);
                    message += `${status} R\\$ ${escapeMarkdownV2(amount.toFixed(2))} \\- ${escapeMarkdownV2(date)}\n`;
                });
            }

            const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar', 'my_wallet')]]);

            if (ctx.callbackQuery?.message) {
                await ctx.editMessageText(message, {
                    parse_mode: 'MarkdownV2',
                    reply_markup: keyboard.reply_markup
                });
            } else {
                await ctx.replyWithMarkdownV2(message, { reply_markup: keyboard.reply_markup });
            }
        } catch (error) {
            if (error.message.includes("message is not modified")) return;
            logError('transaction_history', error, ctx);
            await sendTempError(ctx);
        }
    });
    
    bot.action('back_to_main_menu', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            await ctx.answerCbQuery();
            await sendMainMenu(ctx);
        } catch (error) { 
            logError('back_to_main_menu', error, ctx); 
            await sendTempError(ctx);
        }
    });

    bot.action('about_bridge', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            await ctx.answerCbQuery();
            const aboutMessage = `O **Bridge Bot da Atlas** conecta o Pix brasileiro ao DePix \\(um Real digital soberano e privado\\)\\.\n\n` +
                               `\\- **Soberania Total:** Você tem controle exclusivo sobre suas chaves e fundos\\. O Bridge envia DePix diretamente para sua carteira Liquid\\.\n` +
                               `\\- **Código Aberto:** Nosso código é público e auditável no [GitHub](${escapeMarkdownV2(config.links.githubRepo)})\\.\n` +
                               `\\- **Taxa:** Apenas R\\$0,99 por transação \\(custo da API DePix, que é repassado\\)\\.\n\n` +
                               `A Atlas DAO é uma Organização Autônoma Descentralizada\\. Doações nos ajudam a manter o serviço no ar\\. Endereço para doações \\(DePix/L\\-BTC\\):\n` +
                               `\`VJLBCUaw6GL8AuyjsrwpwTYNCUfUxPVTfxxffNTEZMKEjSwamWL6YqUUWLvz89ts1scTDKYoTF8oruMX\`\n\n` +
                               `Contate o suporte em: ${escapeMarkdownV2(config.links.supportContact)}`;
            const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
            if (ctx.callbackQuery?.message) await ctx.editMessageText(aboutMessage, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup, disable_web_page_preview: true });
            else await ctx.replyWithMarkdownV2(aboutMessage, { reply_markup: keyboard.reply_markup });
        } catch (error) { 
            logError('about_bridge', error, ctx); 
            await sendTempError(ctx);
        }
    });

    bot.action('start_validation', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();
            
            const userId = ctx.from.id;
            
            // Verificar status atual do usuário
            const userStatus = await securityService.getUserStatus(dbPool, userId);
            
            if (userStatus && userStatus.is_verified) {
                const message = `✅ **Sua conta já está validada\\!**\n\n` +
                               `⭐ Nível de Reputação: ${userStatus.reputation_level}\n` +
                               `💰 Limite Diário: R\\$ ${userStatus.daily_limit_brl}\n\n` +
                               `_Sua conta foi validada e você pode realizar transações\\._`;
                
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                return;
            }
            
            // Verificar se há uma validação pendente (não expirada)
            const pendingCheck = await dbPool.query(
                `SELECT depix_api_entry_id, created_at 
                 FROM verification_transactions 
                 WHERE telegram_user_id = $1 
                   AND verification_status = $2 
                   AND created_at > NOW() - INTERVAL '11 minutes'
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [userId, 'PENDING']
            );
            
            if (pendingCheck.rows.length > 0) {
                const pendingVerification = pendingCheck.rows[0];
                const minutesElapsed = Math.floor((Date.now() - new Date(pendingVerification.created_at).getTime()) / 60000);
                const minutesRemaining = 10 - minutesElapsed;
                
                const message = `⏳ **Você já tem uma validação em andamento\\!**\n\n` +
                               `Por favor, complete o pagamento de R\\$ 1,00 primeiro\\.\n\n` +
                               `⏱️ Tempo restante: ${minutesRemaining} minutos\n\n` +
                               `_Se você não conseguiu pagar, cancele e gere um novo QR Code\\._`;
                
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancelar e gerar novo', `cancel_verification:${pendingVerification.depix_api_entry_id}`)],
                    [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
                ]);
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                return;
            }
            
            // Limpar verificações antigas expiradas
            await dbPool.query(
                `UPDATE verification_transactions 
                 SET verification_status = 'EXPIRED', updated_at = NOW() 
                 WHERE telegram_user_id = $1 
                   AND verification_status = 'PENDING' 
                   AND created_at <= NOW() - INTERVAL '11 minutes'`,
                [userId]
            );
            
            const validationMessage = `✅ **Validação Única**\n\n` +
                                     `PIX de R\\$ 1,00 para ativar sua conta\\.\n\n` +
                                     `Deseja continuar?`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Sim, validar minha conta', 'confirm_validation')],
                [Markup.button.callback('❌ Cancelar', 'back_to_main_menu')]
            ]);
            
            if (ctx.callbackQuery?.message) {
                await ctx.editMessageText(validationMessage, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            } else {
                await ctx.replyWithMarkdownV2(validationMessage, { reply_markup: keyboard.reply_markup });
            }
            
        } catch (error) {
            logError('start_validation', error, ctx);
            await sendTempError(ctx);
        }
    });
    
    bot.action('why_validate', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            
            const message = `❓ **Por que validar?**\n\n` +
                          `🤖 **Proteção Anti\\-fraude**\n` +
                          `Confirma que você é uma pessoa real\n\n` +
                          `🔒 **Segurança Total**\n` +
                          `Seus fundos ficam protegidos\n\n` +
                          `📈 **Limites Progressivos**\n` +
                          `R\\$ 50/dia até R\\$ 6\\.020/dia\n\n` +
                          `💰 **Pagamento Único**\n` +
                          `Apenas R\\$ 1,00 \\(para sempre\\)`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Validar Agora', 'start_validation')],
                [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
            ]);
            
            await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            
        } catch (error) {
            logError('why_validate', error, ctx);
            await sendTempError(ctx);
        }
    });

    bot.action('confirm_validation', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const userId = ctx.from.id;
            const username = ctx.from.username || 'N/A';
            
            // Verificar se usuário tem endereço Liquid cadastrado
            const userCheck = await dbPool.query(
                'SELECT liquid_address FROM users WHERE telegram_user_id = $1',
                [userId]
            );
            
            if (userCheck.rows.length === 0 || !userCheck.rows[0].liquid_address) {
                const message = `❌ **Você precisa cadastrar uma carteira Liquid primeiro\\!**\n\n` +
                               `Use o menu "💼 Minha Carteira" para adicionar seu endereço Liquid antes de validar a conta\\.`;
                
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                return;
            }
            
            const liquidAddress = userCheck.rows[0].liquid_address;
            
            // Gerar QR Code de R$ 1,00 para validação
            await ctx.editMessageText('⏳ Gerando QR Code de validação\\.\\.\\.', { parse_mode: 'MarkdownV2' });

            // Verificar status mas não bloquear se offline
            const depixOnline = await depixMonitor.getStatus();
            if (!depixOnline) {
                logger.warn('DePix appears offline but attempting to generate verification QR code anyway');
            }
            
            // Criar depósito de R$ 1,00
            const webhookUrl = `${config.app.baseUrl}/webhooks/depix_payment`;
            let pixData;
            try {
                // Para verificação, não incluir dados do pagador ainda
                pixData = await depixApiService.generatePixForDeposit(100, liquidAddress, webhookUrl, {}); // 100 centavos = R$ 1,00
            } catch (error) {
                await ctx.editMessageText('Ops! Tente novamente.');
                return;
            }
            
            // Salvar transação de verificação
            const verificationResult = await securityService.createVerificationTransaction(
                dbPool,
                userId,
                pixData.qrCopyPaste,
                pixData.id
            );
            
            if (!verificationResult.success) {
                await ctx.editMessageText('Ops! Tente novamente.');
                return;
            }
            
            // Enviar QR Code
            let qrMessage;
            try {
                // Tentar gerar QR personalizado com logo Atlas
                const { generateCustomQRCode } = require('../services/qrCodeGenerator');
                const customQRBuffer = await generateCustomQRCode(pixData.qrCopyPaste, 1.00);

                qrMessage = await ctx.replyWithPhoto(
                    { source: customQRBuffer },
                    {
                        caption: `✅ **Validação \\- R\\$ 1,00**\n\n` +
                                `📱 Escaneie com seu banco\n` +
                                `⏱️ Validade: 10 minutos\n\n` +
                                `**PIX Copia e Cola:**\n` +
                                `\`${escapeMarkdownV2(pixData.qrCopyPaste)}\``,
                        parse_mode: 'MarkdownV2'
                    }
                );
                logger.info('QR code de validação personalizado enviado com sucesso');
            } catch (qrError) {
                logger.error('Erro ao gerar QR personalizado para validação, usando QR do DePix:', qrError);
                // Fallback para QR do DePix
                qrMessage = await ctx.replyWithPhoto(
                    pixData.qrImageUrl,
                    {
                        caption: `✅ **Validação \\- R\\$ 1,00**\n\n` +
                                `📱 Escaneie com seu banco\n` +
                                `⏱️ Validade: 10 minutos\n\n` +
                                `**PIX Copia e Cola:**\n` +
                                `\`${escapeMarkdownV2(pixData.qrCopyPaste)}\``,
                        parse_mode: 'MarkdownV2'
                    }
                );
            }
            
            // Atualizar mensagem ID na transação
            await dbPool.query(
                'UPDATE verification_transactions SET qr_code_message_id = $1 WHERE verification_id = $2',
                [qrMessage.message_id, verificationResult.verificationId]
            );
            
            // Adicionar job de expiração (10 minutos)
            await expirationQueue.add(
                `verification-expiration-${pixData.id}`,
                { 
                    qrId: pixData.id,
                    userId: userId,
                    isVerification: true
                },
                { delay: 10 * 60 * 1000 }
            );
            
        } catch (error) {
            logError('confirm_validation', error, ctx);
            await sendTempError(ctx);
        }
    });

    // Handler para cancelar verificação pendente
    bot.action(/^cancel_verification:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const depixApiEntryId = ctx.match[1];
            const userId = ctx.from.id;
            
            // Verificar se esta verificação pertence ao usuário
            const verificationCheck = await dbPool.query(
                'SELECT * FROM verification_transactions WHERE depix_api_entry_id = $1 AND telegram_user_id = $2 AND verification_status = $3',
                [depixApiEntryId, userId, 'PENDING']
            );
            
            if (verificationCheck.rows.length === 0) {
                await ctx.answerCbQuery('❌ Verificação não encontrada ou já processada', true);
                return;
            }
            
            // Marcar como cancelada
            await dbPool.query(
                'UPDATE verification_transactions SET verification_status = $1, updated_at = NOW() WHERE depix_api_entry_id = $2',
                ['CANCELLED', depixApiEntryId]
            );
            
            // Tentar apagar mensagem do QR se existir
            const qrMessageId = verificationCheck.rows[0].qr_code_message_id;
            if (qrMessageId) {
                try {
                    await bot.telegram.deleteMessage(userId, qrMessageId);
                } catch (e) {
                    // Ignorar se não conseguir apagar
                }
            }
            
            logger.info(`[cancel_verification] User ${userId} cancelled verification ${depixApiEntryId}`);
            
            // Redirecionar de volta para o início da validação
            const validationMessage = `✅ **Validação Única**\n\n` +
                                     `PIX de R\\$ 1,00 para ativar sua conta\\.\n\n` +
                                     `Deseja continuar?`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Sim, validar minha conta', 'confirm_validation')],
                [Markup.button.callback('❌ Cancelar', 'back_to_main_menu')]
            ]);
            
            await ctx.editMessageText(validationMessage, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            
        } catch (error) {
            logError('cancel_verification', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao cancelar verificação', true);
        }
    });
    
    // Handler para cancelar pagamento anterior
    bot.action(/^cancel_and_generate:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const qrId = ctx.match[1];
            const userId = ctx.from.id;
            
            // Verificar se este QR pertence ao usuário
            const txCheck = await dbPool.query(
                'SELECT * FROM pix_transactions WHERE depix_api_entry_id = $1 AND user_id = $2 AND payment_status = $3',
                [qrId, userId, 'PENDING']
            );
            
            if (txCheck.rows.length === 0) {
                await ctx.answerCbQuery('❌ Transação não encontrada ou já processada', true);
                return;
            }
            
            // Marcar como cancelado
            await dbPool.query(
                'UPDATE pix_transactions SET payment_status = $1, updated_at = NOW() WHERE depix_api_entry_id = $2',
                ['CANCELLED', qrId]
            );
            
            // Informar que o pagamento foi cancelado e voltar ao menu
            const message = '✅ **Pagamento anterior cancelado com sucesso**\n\n' +
                           'Agora você pode gerar um novo QR Code se desejar\\.';
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💵 Receber Pix', 'receive_pix_start')],
                [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
            ]);
            
            await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            
        } catch (error) {
            logError('cancel_and_generate', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao processar', true);
        }
    });
    
    // Handler para cancelar QR code (mantido para compatibilidade com botões antigos)
    bot.action(/^cancel_qr:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const qrId = ctx.match[1];
            const userId = ctx.from.id;
            
            // Verificar se este QR pertence ao usuário
            const txCheck = await dbPool.query(
                'SELECT * FROM pix_transactions WHERE depix_api_entry_id = $1 AND user_id = $2 AND payment_status = $3',
                [qrId, userId, 'PENDING']
            );
            
            if (txCheck.rows.length === 0) {
                await ctx.answerCbQuery('❌ Transação não encontrada ou já processada', true);
                return;
            }
            
            // Marcar como cancelado
            await dbPool.query(
                'UPDATE pix_transactions SET payment_status = $1, updated_at = NOW() WHERE depix_api_entry_id = $2',
                ['CANCELLED', qrId]
            );
            
            // Apagar mensagem do QR
            try {
                await ctx.deleteMessage();
            } catch (e) {
                // Se não conseguir apagar, editar
                await ctx.editMessageCaption(
                    `❌ **QR Code Cancelado**\\n\\n` +
                    `Esta transação foi cancelada pelo usuário\\.`,
                    { parse_mode: 'MarkdownV2' }
                );
            }
            
            // Enviar mensagem de confirmação e mostrar menu para novo depósito
            const message = `✅ **QR Code cancelado com sucesso\\!**\n\n` +
                          `Agora você pode gerar um novo QR Code quando desejar\\.`;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💸 Gerar Novo Depósito', 'receive_pix_start')],
                [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
            ]);
            await ctx.reply(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            
        } catch (error) {
            logError('cancel_qr', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao cancelar', true);
        }
    });

    // Handler para gerar QR com valor máximo disponível
    bot.action(/^generate_max_qr:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const maxValue = parseFloat(ctx.match[1]);
            const telegramUserId = ctx.from.id;

            // Apagar mensagem anterior
            try {
                await ctx.deleteMessage();
            } catch (e) {
                // Ignorar se não conseguir apagar
            }

            // Definir estado para processar o valor
            setUserState(telegramUserId, { type: 'amount' });

            // Criar um update falso para processar com o valor máximo
            const updateId = Date.now();
            await bot.handleUpdate({
                update_id: updateId,
                message: {
                    message_id: ctx.callbackQuery.message.message_id,
                    text: maxValue.toFixed(2),
                    from: ctx.from,
                    chat: ctx.chat,
                    date: Math.floor(Date.now() / 1000)
                }
            });

        } catch (error) {
            logError('generate_max_qr', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao gerar QR Code', true);
        }
    });

    // Handler para apagar QRs pendentes
    bot.action('delete_pending_qrs', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const userId = ctx.from.id;

            // Buscar todos os QRs pendentes do usuário
            const pendingQRs = await dbPool.query(
                `SELECT transaction_id, requested_brl_amount, qr_code_message_id, depix_api_entry_id
                 FROM pix_transactions
                 WHERE user_id = $1
                   AND payment_status = 'PENDING'
                   AND created_at >= CURRENT_DATE
                 ORDER BY created_at DESC`,
                [userId]
            );

            if (pendingQRs.rows.length === 0) {
                await ctx.answerCbQuery('❌ Você não tem QR codes pendentes', true);
                return;
            }

            // Mostrar lista de QRs para o usuário escolher qual apagar
            const buttons = [];
            for (const qr of pendingQRs.rows) {
                buttons.push([
                    Markup.button.callback(
                        `🗑️ R$ ${Number(qr.requested_brl_amount).toFixed(2)} - ID: ${qr.transaction_id}`,
                        `delete_single_qr:${qr.depix_api_entry_id}`
                    )
                ]);
            }

            // Adicionar botão para apagar todos
            buttons.push([
                Markup.button.callback('❌ Apagar TODOS os QR codes', 'delete_all_qrs')
            ]);

            buttons.push([
                Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')
            ]);

            const keyboard = Markup.inlineKeyboard(buttons);

            // Editar mensagem ou enviar nova
            const message = `📋 **QR Codes Pendentes**\n\n` +
                          `Você tem ${pendingQRs.rows.length} QR code\\(s\\) pendente\\(s\\)\\.\n` +
                          `Selecione qual deseja apagar:`;

            try {
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            } catch (e) {
                await ctx.reply(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            }

        } catch (error) {
            logError('delete_pending_qrs', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao listar QR codes', true);
        }
    });

    // Handler para apagar um QR específico
    bot.action(/^delete_single_qr:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const qrId = ctx.match[1];
            const userId = ctx.from.id;

            // Verificar se este QR pertence ao usuário
            const txCheck = await dbPool.query(
                'SELECT * FROM pix_transactions WHERE depix_api_entry_id = $1 AND user_id = $2 AND payment_status = $3',
                [qrId, userId, 'PENDING']
            );

            if (txCheck.rows.length === 0) {
                await ctx.answerCbQuery('❌ QR code não encontrado', true);
                return;
            }

            // Marcar como cancelado
            await dbPool.query(
                'UPDATE pix_transactions SET payment_status = $1, updated_at = NOW() WHERE depix_api_entry_id = $2',
                ['CANCELLED', qrId]
            );

            // Tentar apagar a mensagem do QR se existir
            if (txCheck.rows[0].qr_code_message_id) {
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, txCheck.rows[0].qr_code_message_id);
                } catch (e) {
                    // Ignorar se não conseguir apagar
                }
            }

            const successKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💸 Gerar Novo Depósito', 'receive_pix_start')],
                [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
            ]);
            await ctx.editMessageText(
                `✅ **QR Code cancelado com sucesso\\!**\n\n` +
                `Valor: R\\$ ${escapeMarkdownV2(txCheck.rows[0].requested_brl_amount.toFixed(2))}\n\n` +
                `Agora você pode gerar um novo QR Code\\.`,
                { parse_mode: 'MarkdownV2', reply_markup: successKeyboard.reply_markup }
            );

        } catch (error) {
            logError('delete_single_qr', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao cancelar QR', true);
        }
    });

    // Handler para apagar todos os QRs
    bot.action('delete_all_qrs', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const userId = ctx.from.id;

            // Buscar todos os QRs pendentes para apagar mensagens
            const pendingQRs = await dbPool.query(
                'SELECT qr_code_message_id FROM pix_transactions WHERE user_id = $1 AND payment_status = $2 AND created_at >= CURRENT_DATE',
                [userId, 'PENDING']
            );

            // Cancelar todos os QRs pendentes
            const result = await dbPool.query(
                `UPDATE pix_transactions
                 SET payment_status = 'CANCELLED', updated_at = NOW()
                 WHERE user_id = $1 AND payment_status = 'PENDING' AND created_at >= CURRENT_DATE
                 RETURNING transaction_id`,
                [userId]
            );

            // Tentar apagar as mensagens dos QRs
            for (const qr of pendingQRs.rows) {
                if (qr.qr_code_message_id) {
                    try {
                        await ctx.telegram.deleteMessage(ctx.chat.id, qr.qr_code_message_id);
                    } catch (e) {
                        // Ignorar se não conseguir apagar
                    }
                }
            }

            const allDeletedKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💸 Gerar Novo Depósito', 'receive_pix_start')],
                [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
            ]);
            await ctx.editMessageText(
                `✅ **Todos os QR codes foram cancelados\\!**\n\n` +
                `Total cancelado: ${result.rows.length} QR code\\(s\\)\n\n` +
                `Agora você pode gerar novos QR codes dentro do seu limite\\.`,
                { parse_mode: 'MarkdownV2', reply_markup: allDeletedKeyboard.reply_markup }
            );

        } catch (error) {
            logError('delete_all_qrs', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao cancelar QRs', true);
        }
    });

    bot.action('user_status', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();
            
            const userId = ctx.from.id;
            const userStatus = await securityService.getUserStatus(dbPool, userId);
            
            if (!userStatus) {
                const message = `❌ **Conta não encontrada**\n\n` +
                               `Use /start para começar\\.`;
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
                return;
            }
            
            let statusEmoji = userStatus.is_banned ? '🚫' : (userStatus.is_verified ? '✅' : '⏳');
            let statusText = userStatus.is_banned ? 'BANIDA' : (userStatus.is_verified ? 'VALIDADA' : 'NÃO VALIDADA');
            
            // Calcular progresso para próximo nível
            let progressBar = '';
            let nextLevelInfo = '';
            
            if (userStatus.is_verified && !userStatus.is_banned && userStatus.reputation_level < 10) {
                const percentUsed = (userStatus.actual_daily_used / userStatus.daily_limit_brl) * 100;
                const blocks = Math.floor(percentUsed / 10);
                progressBar = '▓'.repeat(blocks) + '░'.repeat(10 - blocks);

                // Verificar se pode subir de nível
                const upgradeCheck = await securityService.checkAndUpgradeReputation(dbPool, userId);
                if (upgradeCheck.upgraded) {
                    nextLevelInfo = `\n🎉 **Parabéns\\! Você subiu para o nível ${upgradeCheck.newLevel}\\!**\n` +
                                  `Novo limite diário: R\\$ ${upgradeCheck.newLimit}`;
                } else {
                    // Buscar informações do próximo nível
                    const nextLevelData = await dbPool.query(
                        'SELECT * FROM reputation_levels_config WHERE level = $1',
                        [userStatus.reputation_level + 1]
                    );

                    if (nextLevelData.rows.length > 0) {
                        const nextLevel = nextLevelData.rows[0];

                        // Use user's actual stats from the database
                        // These are now properly updated by the trigger
                        const currentTxCount = parseInt(userStatus.completed_transactions || 0);
                        const currentVolume = parseFloat(userStatus.total_volume_brl || 0);

                        // Calcular o que falta para o próximo nível
                        const txNeeded = Math.max(0, nextLevel.min_transactions_for_upgrade - currentTxCount);
                        const volumeNeeded = Math.max(0, nextLevel.min_volume_for_upgrade - currentVolume);

                        // Montar mensagem gamificada
                        nextLevelInfo = `\n🎯 **Próximo Nível ${userStatus.reputation_level + 1}**\n` +
                                      `💰 Limite: R\\$ ${escapeMarkdownV2(Number(nextLevel.daily_limit_brl).toFixed(2))}/dia\n\n` +
                                      `**Missão para desbloquear:**\n`;

                        if (txNeeded > 0 && volumeNeeded > 0) {
                            const txWord = txNeeded === 1 ? 'transação' : 'transações';
                            nextLevelInfo += `📊 Faça mais ${txNeeded} ${txWord}\n` +
                                           `💸 Movimente mais R\\$ ${escapeMarkdownV2(volumeNeeded.toFixed(2))}`;
                        } else if (txNeeded > 0) {
                            const txWord = txNeeded === 1 ? 'transação' : 'transações';
                            nextLevelInfo += `📊 Faça mais ${txNeeded} ${txWord}`;
                        } else if (volumeNeeded > 0) {
                            nextLevelInfo += `💸 Movimente mais R\\$ ${escapeMarkdownV2(volumeNeeded.toFixed(2))}`;
                        } else {
                            nextLevelInfo += `✅ Requisitos cumpridos\\! Será aplicado em breve\\.`;
                        }
                    }
                }
            }
            
            // Create cleaner progress bar
            const createProgressBar = (percentage, width = 10) => {
                const filled = Math.round((percentage / 100) * width);
                return '█'.repeat(filled) + '░'.repeat(width - filled);
            };

            const usagePercent = Math.floor((userStatus.actual_daily_used / userStatus.daily_limit_brl) * 100);

            // Calcular horas para reset se limite atingido
            let resetInfo = '';
            if (userStatus.available_today <= 0 && userStatus.is_verified && !userStatus.is_banned) {
                // Usar horário de Brasília
                const nowUTC = new Date();
                const nowBrasilia = new Date(nowUTC.toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
                const tomorrowBrasilia = new Date(nowBrasilia);
                tomorrowBrasilia.setDate(tomorrowBrasilia.getDate() + 1);
                tomorrowBrasilia.setHours(0, 0, 0, 0);
                const hoursUntilReset = Math.ceil((tomorrowBrasilia - nowBrasilia) / (1000 * 60 * 60));
                resetInfo = `\n⏰ **Reset em ${hoursUntilReset} hora${hoursUntilReset === 1 ? '' : 's'}**`;
            }

            const message = `📊 **Status**\n\n` +
                          `${statusEmoji} ${statusText}\n` +
                          `⭐ Nível ${userStatus.reputation_level}\n\n` +
                          `**Hoje:**\n` +
                          `${createProgressBar(usagePercent)} ${usagePercent}%\n` +
                          `💰 Disponível: R\\$ ${escapeMarkdownV2(String(userStatus.available_today || '0.00'))}\n` +
                          `📈 Usado: R\\$ ${escapeMarkdownV2(String(userStatus.actual_daily_used || '0.00'))}\n` +
                          `📊 Limite: R\\$ ${escapeMarkdownV2(String(userStatus.daily_limit_brl || '0.00'))}` +
                          resetInfo + '\n' +
                          nextLevelInfo +
                          (userStatus.is_banned ?
                           `\n🚫 **BANIDO:** ${escapeMarkdownV2(userStatus.ban_reason || 'Violação')}` : '') +
                          (!userStatus.is_verified ?
                           `\n⚠️ **Valide sua conta para começar**` : '');
            
            const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
            
            if (ctx.callbackQuery?.message) {
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            } else {
                await ctx.replyWithMarkdownV2(message, { reply_markup: keyboard.reply_markup });
            }
            
        } catch (error) {
            logError('user_status', error, ctx);
            await sendTempError(ctx);
        }
    });

    bot.catch((err, ctx) => {
        logError('Global Telegraf bot.catch', err, ctx);
        if (err.message?.includes("query is too old") || err.message?.includes("message is not modified")) return;
        try { ctx.reply('Desculpe, ocorreu um erro inesperado. Por favor, tente /start novamente.'); }
        catch (replyError) { logError('Global bot.catch sendMessage fallback', replyError, ctx); }
    });
    
    logger.info('Bot handlers registered.');
};

module.exports = { registerBotHandlers };