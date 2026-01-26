const { Markup } = require('telegraf');
const config = require('../core/config');
const logger = require('../core/logger');
const depixApiService = require('../services/depixApiService');
const depixMonitor = require('../services/depixMonitor');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const securityService = require('../services/securityService');
const { generateCustomQRCode } = require('../services/qrCodeGenerator');
const uxService = require('../services/userExperienceService');
const UserValidation = require('../utils/userValidation');
const InputValidator = require('../utils/inputValidator');
const WithdrawalService = require('../services/withdrawalService');
const BountyService = require('../services/bountyService');

// Helper para nome amigável do tipo de chave PIX
const getPixKeyTypeName = (type) => {
    const names = {
        'PHONE': 'Celular',
        'EMAIL': 'E-mail',
        'CPF': 'CPF',
        'CNPJ': 'CNPJ',
        'RANDOM': 'Aleatória',
        'AMBIGUOUS_CPF_PHONE': 'CPF/Celular'
    };
    return names[type] || type;
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

    // BountyService para sugestões de usuários
    const bountyServiceEarly = new BountyService(dbPool, bot);

    // Menu principal para usuários validados
    const mainMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('💸 Comprar Depix Liquid', 'receive_pix_start')],
        // [Markup.button.callback('💰 Sacar (DePix → PIX)', 'withdrawal_start')], // TODO: Habilitar quando pronto
        [Markup.button.callback('🚀 Impulsionar Atlas', 'user_bounties')],
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



    // Comando de teste para saque
    bot.command('testsaque', async (ctx) => {
        logger.info(`[TestSaque] Recebido de ${ctx.from.id}`);
        await ctx.reply('Teste de saque OK!');
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

    bot.on('text', async (ctx, next) => {
        const text = ctx.message.text.trim();
        const telegramUserId = ctx.from.id;
        const telegramUsername = ctx.from.username || 'N/A';
        const userState = awaitingInputForUser[telegramUserId];

        if (text.startsWith('/')) { clearUserState(telegramUserId); return next(); }
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

                    const progressBar3 = uxService.formatProgressBar(60);
                    await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, `Gerando QR Code ${progressBar3}`);
                                        
                    const userResult = await dbPool.query(
                        'SELECT liquid_address, payer_name, payer_cpf_cnpj, euid, contribution_fee FROM users WHERE telegram_user_id = $1',
                        [telegramUserId]
                    );
                    if (!userResult.rows.length || !userResult.rows[0].liquid_address) {
                        clearUserState(telegramUserId);
                        await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Sua carteira Liquid não foi encontrada. Use /start para configurar.');
                        return;
                    }

                    const userLiquidAddress = userResult.rows[0].liquid_address;
                    const contributionFee = parseFloat(userResult.rows[0].contribution_fee) || 0;
                    const amountInCents = Math.round(amount * 100);
                    const progressBar4 = uxService.formatProgressBar(80);
                    await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, `Finalizando ${progressBar4}`);

                    // Lógica de identificação:
                    // 1. Se tem EUID: usa EUID (apenas dono do EUID paga)
                    // 2. Se não tem EUID: QR aberto (EUID será capturado do webhook)
                    // Nota: Eulen alterou regras - CPF não é mais usado para identificação
                    const userInfo = {};

                    if (userResult.rows[0].euid && userResult.rows[0].euid.trim() !== '') {
                        userInfo.euid = userResult.rows[0].euid;
                    }
                    // Não enviar mais CPF/nome - Eulen não usa mais para identificação

                    // Adicionar contribuição se configurada
                    if (contributionFee > 0) {
                        userInfo.contributionFee = contributionFee;
                    }

                    // Calcular valor da contribuição em BRL
                    const contributionAmountBrl = contributionFee > 0 ? (amount * contributionFee / 100) : 0;

                    const webhookUrl = `${config.app.baseUrl}/webhooks/depix_payment`;
                    const pixData = await depixApiService.generatePixForDeposit(amountInCents, userLiquidAddress, webhookUrl, userInfo);
                    const { qrCopyPaste, qrImageUrl, id: depixApiEntryId } = pixData;

                    const dbResult = await dbPool.query(
                        'INSERT INTO pix_transactions (user_id, requested_brl_amount, depix_amount_expected, pix_qr_code_payload, payment_status, depix_api_entry_id, contribution_fee_percent, contribution_amount_brl) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING transaction_id',
                        [telegramUserId, amount, (amount - 0.99), qrCopyPaste, 'PENDING', depixApiEntryId, contributionFee, contributionAmountBrl]
                    );
                    const internalTxId = dbResult.rows[0].transaction_id;
                    logger.info(`Transaction ${internalTxId} for BRL ${amount.toFixed(2)} saved. DePix API ID: ${depixApiEntryId}`);

                    const reminderJobId = `expectation-${depixApiEntryId}`;
                    await expectationMessageQueue.add(reminderJobId, { telegramUserId, depixApiEntryId, supportContact: escapeMarkdownV2(config.links.supportContact) }, { delay: 19 * 60 * 1000, removeOnComplete: true, removeOnFail: true, jobId: reminderJobId });
                    
                    const expirationJobId = `expiration-${depixApiEntryId}`;
                    await expirationQueue.add(expirationJobId, { telegramUserId, depixApiEntryId, requestedBrlAmount: amount }, { delay: 19 * 60 * 1000, removeOnComplete: true, removeOnFail: true, jobId: expirationJobId });
                    logger.info(`Jobs added: Reminder (${reminderJobId}) and Expiration (${expirationJobId}) for user ${telegramUserId}`);

                    let caption = `💸 **PIX \\- R\\$ ${escapeMarkdownV2(amount.toFixed(2))}**\n\n`;
                    caption += `📱 Escaneie com seu banco\n`;
                    caption += `⏱️ Validade: 29 minutos\n\n`;
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
                    // Se falhou ao gerar o QR, mostrar mensagem genérica
                    const errorReply = 'Ops! Tente novamente.';
                    if (messageIdToUpdate) await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, errorReply);
                    else await ctx.reply(errorReply);
                }
            } else { 
                await ctx.replyWithMarkdownV2(`Valor inválido\\. Por favor, envie um valor entre R\\$ 1\\.00 e R\\$ ${escapeMarkdownV2(maxAllowed.toFixed(2))} \\(ex: \`45.21\`\\)\\.`);
            }
        } else if (userState && (userState.type === 'liquid_address_initial' || userState.type === 'liquid_address_change')) {
            const validation = InputValidator.validateLiquidAddress(text);
            if (validation.valid) {
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
        } else if (userState && userState.type === 'custom_contribution') {
            // Handler para porcentagem de contribuição personalizada
            const cleanedText = text.replace(',', '.').replace('%', '').trim();
            const newFee = parseFloat(cleanedText);

            if (isNaN(newFee) || newFee < 0 || newFee > 20) {
                await ctx.reply('❌ Valor inválido. Digite um número entre 0 e 20.');
                return;
            }

            try {
                // Buscar taxa atual
                const currentResult = await dbPool.query(
                    'SELECT contribution_fee FROM users WHERE telegram_user_id = $1',
                    [telegramUserId]
                );
                const currentFee = parseFloat(currentResult.rows[0]?.contribution_fee) || 0;

                // Atualizar a contribuição
                await dbPool.query(
                    'UPDATE users SET contribution_fee = $1, updated_at = NOW() WHERE telegram_user_id = $2',
                    [newFee, telegramUserId]
                );

                let message;
                if (newFee === 0) {
                    message = `✅ Contribuição desativada\\.\n\n` +
                        `Você pode reativar a qualquer momento no menu de contribuições\\.`;
                } else if (newFee > currentFee) {
                    message = `🎉 *Obrigado\\!*\n\n` +
                        `Sua contribuição foi aumentada de ${escapeMarkdownV2(currentFee.toFixed(2))}% para *${escapeMarkdownV2(newFee.toFixed(2))}%*\\!\n\n` +
                        `💝 Sua generosidade ajuda a manter o projeto\\!`;
                } else {
                    message = `✅ Contribuição atualizada para *${escapeMarkdownV2(newFee.toFixed(2))}%*\\.`;
                }

                // Editar mensagem original se possível
                if (userState.messageIdToEdit) {
                    try {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            userState.messageIdToEdit,
                            undefined,
                            message,
                            {
                                parse_mode: 'MarkdownV2',
                                ...Markup.inlineKeyboard([
                                    [Markup.button.callback('⬅️ Voltar ao Menu', 'contribution_menu')]
                                ])
                            }
                        );
                    } catch (e) {
                        await ctx.replyWithMarkdownV2(message);
                    }
                } else {
                    await ctx.replyWithMarkdownV2(message);
                }

                // Deletar mensagem do usuário
                try {
                    await ctx.deleteMessage();
                } catch (e) {
                    // Ignorar se não conseguir deletar
                }

                logger.info(`[CONTRIBUTION] User ${telegramUserId} set custom contribution to ${newFee}%`);
                clearUserState(telegramUserId);

            } catch (error) {
                logError('custom_contribution_handler', error, ctx);
                await ctx.reply('❌ Erro ao atualizar contribuição. Tente novamente.');
            }
        } else if (userState && userState.type === 'withdrawal_amount') {
            // Handler para valor de saque
            const cleanedText = text.replace(',', '.').replace('R$', '').replace('r$', '').trim();
            const amount = parseFloat(cleanedText);

            if (isNaN(amount) || amount < 100 || amount > 5940) {
                await ctx.reply('❌ Entre R$ 100 e R$ 5.940');
                return;
            }

            setUserState(telegramUserId, {
                type: 'withdrawal_pix_key',
                messageIdToEdit: userState.messageIdToEdit,
                amount: amount
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar', 'withdrawal_start')]
            ]);

            const pixMsg = `💸 *R$ ${amount.toLocaleString('pt-BR')}*\n\nPra qual chave PIX?`;

            try {
                if (userState.messageIdToEdit) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        userState.messageIdToEdit,
                        undefined,
                        pixMsg,
                        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                    );
                } else {
                    await ctx.reply(pixMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
                }
            } catch (e) {
                await ctx.reply(pixMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            }

        } else if (userState && userState.type === 'withdrawal_pix_key') {
            // Handler para chave PIX de saque
            const detectedType = InputValidator.detectPixKeyType(text);

            // Se for ambíguo (11 dígitos), perguntar ao usuário
            if (detectedType === 'AMBIGUOUS_CPF_PHONE') {
                setUserState(telegramUserId, {
                    ...userState,
                    type: 'withdrawal_pix_key_confirm_type',
                    ambiguousKey: text.trim()
                });

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Celular', 'wd_keytype:PHONE')],
                    [Markup.button.callback('🪪 CPF', 'wd_keytype:CPF')],
                    [Markup.button.callback('⬅️ Voltar', 'withdrawal_start')]
                ]);

                const askMsg = `🤔 *${text.trim()}*\n\nÉ CPF ou Celular?`;

                try {
                    if (userState.messageIdToEdit) {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            userState.messageIdToEdit,
                            undefined,
                            askMsg,
                            { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                        );
                    } else {
                        await ctx.reply(askMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
                    }
                } catch (e) {
                    await ctx.reply(askMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
                }
                return;
            }

            const pixValidation = InputValidator.validatePixKey(text);

            if (!pixValidation.valid) {
                await ctx.reply(`❌ ${pixValidation.error}`);
                return;
            }

            const amount = userState.amount;
            const withdrawalServiceLocal = new WithdrawalService(dbPool);
            const fees = withdrawalServiceLocal.calculateFees(amount);

            setUserState(telegramUserId, {
                type: 'withdrawal_confirm',
                amount: amount,
                pixKey: pixValidation.normalized,
                pixKeyType: pixValidation.type,
                fees: fees
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Confirmar', 'withdrawal_confirm')],
                [Markup.button.callback('⬅️ Voltar', 'withdrawal_start')]
            ]);

            const confirmMsg =
                `💸 *Confirma?*\n\n` +
                `Você envia: *${fees.totalDepixRequired.toFixed(2)} DePix*\n` +
                `Você recebe: *R$ ${amount.toFixed(2)}*\n` +
                `PIX: \`${pixValidation.normalized}\` (${getPixKeyTypeName(pixValidation.type)})\n\n` +
                `_Taxa: R$ ${(fees.ourFeeAmount + fees.networkFeeAmount).toFixed(2)} (2,5% + rede)_`;

            try {
                if (userState.messageIdToEdit) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        userState.messageIdToEdit,
                        undefined,
                        confirmMsg,
                        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                    );
                } else {
                    await ctx.reply(confirmMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
                }
            } catch (e) {
                await ctx.reply(confirmMsg, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
            }

        } else if (userState && userState.type === 'bounty_suggest_title') {
            // Handler para título de sugestão de projeto
            const title = text.trim();

            if (title.length < 5) {
                await ctx.reply('❌ Título muito curto. Mínimo de 5 caracteres.');
                return;
            }

            if (title.length > 40) {
                await ctx.reply('❌ Título muito longo. Máximo de 40 caracteres.');
                return;
            }

            // Rate limiting: máximo 3 sugestões por dia
            try {
                const todaySuggestions = await dbPool.query(`
                    SELECT COUNT(*) as count FROM bounty_features
                    WHERE creator_telegram_id = $1
                    AND created_at > NOW() - INTERVAL '24 hours'
                `, [telegramUserId]);

                if (parseInt(todaySuggestions.rows[0].count) >= 3) {
                    clearUserState(telegramUserId);
                    await ctx.reply(
                        '⚠️ *Limite diário atingido*\n\n' +
                        'Você já sugeriu 3 projetos nas últimas 24h.\n' +
                        'Aguarde um pouco para enviar novas sugestões.',
                        { parse_mode: 'Markdown' }
                    );
                    return;
                }
            } catch (e) {
                logger.error(`[Bounty Suggest] Rate limit check error: ${e.message}`);
            }

            // Salvar título e passar para próximo passo
            setUserState(telegramUserId, {
                type: 'bounty_suggest_desc',
                title: title,
                messageIdToEdit: userState.messageIdToEdit
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancelar', 'user_bounties')]
            ]);

            await ctx.reply(
                `✅ Título: *${title}*\n\n` +
                `📝 Agora descreva o projeto (30-800 caracteres):\n\n` +
                `_O que precisa ser feito? Por que é importante?_`,
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );

        } else if (userState && userState.type === 'bounty_suggest_desc') {
            // Handler para descrição de sugestão de projeto
            const description = text.trim();

            if (description.length < 30) {
                await ctx.reply('❌ Descrição muito curta. Mínimo de 30 caracteres.');
                return;
            }

            if (description.length > 800) {
                const excess = description.length - 800;

                // Botão que copia o texto para o clipboard
                const keyboard = {
                    inline_keyboard: [
                        [{
                            text: '📋 Copiar meu texto',
                            copy_text: { text: description }
                        }],
                        [{
                            text: '❌ Cancelar',
                            callback_data: 'user_bounties'
                        }]
                    ]
                };

                await ctx.reply(
                    `❌ *Descrição muito longa\\!*\n\n` +
                    `📊 Seu texto: *${description.length}* caracteres\n` +
                    `📏 Limite: *800* caracteres\n` +
                    `✂️ Remova: *${excess}* caracteres\n\n` +
                    `Clique no botão abaixo para copiar seu texto, edite e envie novamente\\.\n\n` +
                    `_Título "${userState.title.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')}" mantido\\._`,
                    { parse_mode: 'MarkdownV2', reply_markup: keyboard }
                );

                return;
            }

            const title = userState.title;

            try {
                // Criar sugestão via bountyService
                const bounty = await bountyServiceEarly.createBounty({
                    title: title,
                    description: description,
                    createdByTelegramId: telegramUserId,
                    createdByUsername: telegramUsername
                });

                clearUserState(telegramUserId);

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Ver Projetos', 'user_bounties')],
                    [Markup.button.callback('⬅️ Menu Principal', 'back_to_main_menu')]
                ]);

                await ctx.reply(
                    `🎉 *Sugestão enviada!*\n\n` +
                    `Título: *${title}*\n\n` +
                    `Sua ideia foi registrada e será analisada pela equipe.\n` +
                    `Se aprovada, aparecerá na lista de projetos para receber contribuições.\n\n` +
                    `_Obrigado por ajudar a melhorar a Atlas!_`,
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );

                logger.info(`[Bounty Suggest] User ${telegramUserId} (@${telegramUsername}) suggested: "${title}"`);

            } catch (error) {
                logError('bounty_suggest_desc', error, ctx);
                await ctx.reply('❌ Erro ao enviar sugestão. Tente novamente.');
            }

        } else if (userState && userState.type === 'bounty_vote_pix_amount') {
            // Handler para valor PIX do voto em bounty
            const cleanedText = text.trim().replace(',', '.');
            const amount = parseFloat(cleanedText);

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
                const result = await bountyServiceEarly.createPixPayment(
                    userState.bountyId,
                    telegramUserId,
                    telegramUsername,
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
                    [Markup.button.callback('⬅️ Voltar', `bounty_contribute:${userState.bountyId}`)]
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
                logError('bounty_vote_pix_amount', error, ctx);
                await ctx.reply(`❌ Erro ao gerar PIX: ${error.message}`);
            }

            clearUserState(telegramUserId);

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
                       [Markup.button.callback('💝 Contribuição', 'contribution_menu')],
                       [Markup.button.callback('📜 Histórico de Transações', 'transaction_history:0:all')],
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

    // ==================== SISTEMA DE CONTRIBUIÇÃO ====================

    // Constantes da competição (26/11/2024 a 26/12/2024)
    const COMPETITION_ID = '2024-11-26_2024-12-26';

    // Função para gerar opções de contribuição baseado na taxa atual
    const getContributionOptions = (currentFee) => {
        const INCREMENT = 0.25;
        const MAX_FEE = 20.00;
        const fee = parseFloat(currentFee) || 0;

        if (fee === 0) {
            return [0.25, 0.50, 0.75];
        }

        if (fee >= MAX_FEE) {
            return [];
        }

        const options = [];
        for (let i = 1; i <= 3; i++) {
            const nextValue = fee + (INCREMENT * i);
            if (nextValue <= MAX_FEE) {
                options.push(parseFloat(nextValue.toFixed(2)));
            }
        }

        return options;
    };

    // Função para gerar opções de redução
    const getReduceOptions = (currentFee) => {
        const INCREMENT = 0.25;
        const fee = parseFloat(currentFee) || 0;
        const options = [];

        for (let f = fee - INCREMENT; f >= INCREMENT; f -= INCREMENT) {
            options.push(parseFloat(f.toFixed(2)));
            if (options.length >= 3) break;
        }

        return options;
    };

    // Função para buscar posição no ranking
    const getUserRankingPosition = async (telegramUserId) => {
        try {
            const result = await dbPool.query(`
                WITH ranked AS (
                    SELECT
                        telegram_user_id,
                        total_contribution_brl,
                        ROW_NUMBER() OVER (ORDER BY total_contribution_brl DESC, transaction_count DESC) as position
                    FROM contribution_ranking
                    WHERE competition_id = $1
                )
                SELECT
                    r.position,
                    (SELECT COUNT(*) FROM contribution_ranking WHERE competition_id = $1) as total_participants
                FROM ranked r
                WHERE r.telegram_user_id = $2
            `, [COMPETITION_ID, telegramUserId]);

            if (result.rows.length === 0) {
                const countResult = await dbPool.query(
                    'SELECT COUNT(*) as total FROM contribution_ranking WHERE competition_id = $1',
                    [COMPETITION_ID]
                );
                return {
                    position: null,
                    isParticipating: false,
                    totalParticipants: parseInt(countResult.rows[0].total) || 0
                };
            }

            return {
                position: parseInt(result.rows[0].position),
                isParticipating: true,
                totalParticipants: parseInt(result.rows[0].total_participants)
            };
        } catch (error) {
            logger.error('[CONTRIBUTION] Error getting ranking position:', error);
            return { position: null, isParticipating: false, totalParticipants: 0 };
        }
    };

    // Função para atualizar ranking após transação confirmada
    const updateContributionRanking = async (telegramUserId, contributionBrl) => {
        try {
            if (!contributionBrl || contributionBrl <= 0) return;

            await dbPool.query(`
                INSERT INTO contribution_ranking
                    (telegram_user_id, competition_id, total_contribution_brl, transaction_count)
                VALUES ($1, $2, $3, 1)
                ON CONFLICT (telegram_user_id, competition_id)
                DO UPDATE SET
                    total_contribution_brl = contribution_ranking.total_contribution_brl + $3,
                    transaction_count = contribution_ranking.transaction_count + 1,
                    updated_at = NOW()
            `, [telegramUserId, COMPETITION_ID, contributionBrl]);

            logger.info(`[RANKING] Updated ranking for user ${telegramUserId}: +R$ ${contributionBrl}`);
        } catch (error) {
            logger.error('[RANKING] Error updating ranking:', error);
        }
    };

    // Função para enviar sugestão sutil de aumento pós-transação
    const sendContributionSuggestion = async (bot, telegramUserId, currentFee) => {
        try {
            const fee = parseFloat(currentFee) || 0;
            const MAX_FEE = 20.00;

            // Se já está no máximo, não sugerir
            if (fee >= MAX_FEE) return;

            // Calcular opções: +0.25% e +0.50% da atual
            const option1 = parseFloat((fee + 0.25).toFixed(2));
            const option2 = parseFloat((fee + 0.50).toFixed(2));

            const options = [];
            if (option1 <= MAX_FEE) options.push(option1);
            if (option2 <= MAX_FEE) options.push(option2);

            if (options.length === 0) return;

            let message;
            if (fee === 0) {
                message = `💝 *Quer apoiar a Atlas?*\n\n` +
                    `Sua contribuição voluntária ajuda a manter o serviço no ar e desenvolver ferramentas pró\\-liberdade\\.`;
            } else {
                message = `💝 *Obrigado por apoiar a Atlas\\!*\n\n` +
                    `Quer aumentar sua contribuição?`;
            }

            const keyboard = [];
            const optionButtons = options.map(f =>
                Markup.button.callback(`${f.toFixed(2)}%`, `contribution_set:${f.toFixed(2)}`)
            );
            keyboard.push(optionButtons);
            keyboard.push([Markup.button.callback('Agora não', 'dismiss_contribution_suggestion')]);

            await bot.telegram.sendMessage(telegramUserId, message, {
                parse_mode: 'MarkdownV2',
                ...Markup.inlineKeyboard(keyboard)
            });

        } catch (error) {
            logger.error('[CONTRIBUTION] Error sending suggestion:', error);
        }
    };

    // Handler para dispensar sugestão de contribuição
    bot.action('dismiss_contribution_suggestion', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            await ctx.deleteMessage();
        } catch (error) {
            // Ignorar erro se não conseguir apagar
        }
    });

    // Handler principal do menu de contribuição
    bot.action('contribution_menu', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            clearUserState(ctx.from.id);

            const userId = ctx.from.id;

            // Buscar taxa atual do usuário
            const userResult = await dbPool.query(
                'SELECT contribution_fee FROM users WHERE telegram_user_id = $1',
                [userId]
            );

            const currentFee = parseFloat(userResult.rows[0]?.contribution_fee) || 0;

            // Buscar posição no ranking
            const rankingInfo = await getUserRankingPosition(userId);

            // Gerar opções de taxa
            const options = getContributionOptions(currentFee);

            let message = '';
            const keyboard = [];

            if (currentFee === 0) {
                // Usuário sem contribuição
                message = `💝 *Contribuição com a Atlas*\n\n` +
                    `A Atlas opera sem fins lucrativos, cobrando apenas o custo operacional de R\\$ 0,99 por transação\\.\n\n` +
                    `Sua contribuição voluntária ajuda a:\n` +
                    `• Manter os servidores no ar 24/7\n` +
                    `• Desenvolver novas funcionalidades\n` +
                    `• Financiar ferramentas pró\\-liberdade\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🎁 *PRESENTE DE NATAL*\n` +
                    `O maior apoiador até 26/12 ganha\n` +
                    `uma Hardware Wallet Jade DIY\\!\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `*Contribuição atual:* Nenhuma\n\n` +
                    `Escolha quanto deseja contribuir:`;
            } else if (currentFee >= 20) {
                // Usuário no máximo
                let rankingText = '';
                if (rankingInfo.isParticipating) {
                    rankingText = `📊 Sua posição: \\#${rankingInfo.position}`;
                }

                message = `💝 *Contribuição com a Atlas*\n\n` +
                    `🏆 *CONTRIBUIDOR MÁXIMO* 🏆\n\n` +
                    `Você atingiu o nível máximo de contribuição\\!\n` +
                    `A Atlas agradece imensamente seu apoio\\.\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🎁 *PRESENTE DE NATAL*\n` +
                    `${rankingText}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `*Contribuição atual:* ${escapeMarkdownV2(currentFee.toFixed(2))}% ✓ \\(máximo\\)`;
            } else {
                // Usuário com contribuição ativa
                let rankingText = '';
                if (rankingInfo.isParticipating) {
                    rankingText = `📊 Sua posição: \\#${rankingInfo.position} de ${rankingInfo.totalParticipants}`;
                } else {
                    rankingText = `📊 Você ainda não está no ranking`;
                }

                message = `💝 *Contribuição com a Atlas*\n\n` +
                    `Obrigado por apoiar a Atlas\\! 🙏\n\n` +
                    `Sua contribuição faz diferença real no desenvolvimento de ferramentas para a liberdade financeira\\.\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🎁 *PRESENTE DE NATAL*\n` +
                    `Prêmio: Hardware Wallet Jade DIY\n\n` +
                    `${rankingText}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `*Contribuição atual:* ${escapeMarkdownV2(currentFee.toFixed(2))}% ✓\n\n` +
                    `Quer contribuir ainda mais?`;
            }

            // Botões de opções de taxa (se houver)
            if (options.length > 0) {
                const optionButtons = options.map(fee =>
                    Markup.button.callback(`${fee.toFixed(2)}%`, `contribution_set:${fee.toFixed(2)}`)
                );
                keyboard.push(optionButtons);
            }

            // Botão de alterar (se tem contribuição ativa)
            if (currentFee > 0) {
                keyboard.push([
                    Markup.button.callback('⚙️ Personalizar', 'contribution_reduce'),
                    Markup.button.callback('⬅️ Voltar', 'my_wallet')
                ]);
            } else {
                keyboard.push([Markup.button.callback('⬅️ Voltar', 'my_wallet')]);
            }

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                ...Markup.inlineKeyboard(keyboard)
            });

        } catch (error) {
            logError('contribution_menu', error, ctx);
            await sendTempError(ctx);
        }
    });

    // Handler para definir contribuição
    bot.action(/^contribution_set:(.+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();

            const userId = ctx.from.id;
            const newFee = parseFloat(ctx.match[1]);

            // Validações
            if (isNaN(newFee) || newFee < 0 || newFee > 20) {
                await ctx.reply('❌ Valor de contribuição inválido.');
                return;
            }

            // Buscar taxa atual
            const currentResult = await dbPool.query(
                'SELECT contribution_fee FROM users WHERE telegram_user_id = $1',
                [userId]
            );
            const currentFee = parseFloat(currentResult.rows[0]?.contribution_fee) || 0;

            // Atualizar no banco
            await dbPool.query(
                'UPDATE users SET contribution_fee = $1, updated_at = NOW() WHERE telegram_user_id = $2',
                [newFee, userId]
            );

            // Determinar mensagem de confirmação
            let message;
            if (newFee === 0) {
                message = `*Contribuição Desativada*\n\n` +
                    `Sua contribuição foi desativada\\.\n\n` +
                    `Você pode reativar a qualquer momento através do menu "Minha Carteira"\\.\n\n` +
                    `Esperamos poder contar com seu apoio novamente no futuro\\!`;
            } else if (currentFee === 0) {
                // Primeira contribuição
                message = `✅ *Contribuição Ativada\\!*\n\n` +
                    `Sua contribuição foi definida para *${escapeMarkdownV2(newFee.toFixed(2))}%*\n\n` +
                    `Bem\\-vindo ao time de apoiadores\\! Obrigado por contribuir com a Atlas\\. 🙏\n\n` +
                    `A taxa será aplicada nas suas próximas transações\\.`;
            } else if (newFee > currentFee) {
                message = `✅ *Contribuição Aumentada\\!*\n\n` +
                    `Sua contribuição foi alterada para *${escapeMarkdownV2(newFee.toFixed(2))}%*\n\n` +
                    `Obrigado por apoiar o desenvolvimento da liberdade\\! Cada centavo nos ajuda a construir um futuro mais livre\\. 🙏`;
            } else {
                message = `✅ *Contribuição Atualizada*\n\n` +
                    `Sua contribuição foi alterada para *${escapeMarkdownV2(newFee.toFixed(2))}%*\n\n` +
                    `Obrigado por continuar apoiando a Atlas\\!`;
            }

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
                ])
            });

            logger.info(`[CONTRIBUTION] User ${userId} changed contribution from ${currentFee}% to ${newFee}%`);

        } catch (error) {
            logError('contribution_set', error, ctx);
            await sendTempError(ctx);
        }
    });

    // Handler para reduzir/desativar contribuição
    bot.action('contribution_reduce', async (ctx) => {
        try {
            await ctx.answerCbQuery();

            const userId = ctx.from.id;

            // Buscar taxa atual
            const result = await dbPool.query(
                'SELECT contribution_fee FROM users WHERE telegram_user_id = $1',
                [userId]
            );

            const currentFee = parseFloat(result.rows[0]?.contribution_fee) || 0;

            const message = `⚙️ *Personalizar Contribuição*\n\n` +
                `*Contribuição atual:* ${escapeMarkdownV2(currentFee.toFixed(2))}%\n\n` +
                `Digite a porcentagem desejada \\(0 a 20\\):\n` +
                `Ex: 1\\.2 para 1\\.2%\\.`;

            // Salvar estado para aguardar input
            setUserState(userId, {
                type: 'custom_contribution',
                messageIdToEdit: ctx.callbackQuery.message.message_id
            });

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Voltar', 'contribution_menu')]
                ])
            });

        } catch (error) {
            logError('contribution_reduce', error, ctx);
            await sendTempError(ctx);
        }
    });

    // Exportar funções para uso em outros módulos (webhook)
    bot.context.contributionHelpers = {
        updateContributionRanking,
        sendContributionSuggestion: (userId, fee) => sendContributionSuggestion(bot, userId, fee)
    };

    // ==================== FIM SISTEMA DE CONTRIBUIÇÃO ====================

    // Transaction history with pagination and filters
    bot.action(/^transaction_history:(\d+):?(all|approved)?$/, async (ctx) => {
        clearUserState(ctx.from.id);
        try {
            await ctx.answerCbQuery();

            const page = parseInt(ctx.match[1]) || 0;
            const filter = ctx.match[2] || 'all';
            const itemsPerPage = 10;
            const offset = page * itemsPerPage;

            // Build query based on filter
            let whereClause = 'WHERE user_id = $1';
            if (filter === 'approved') {
                whereClause += ` AND payment_status IN ('CONFIRMED', 'PAID')`;
            }

            // Get total count and total approved amount
            const { rows: countResult } = await dbPool.query(
                `SELECT COUNT(*) as total FROM pix_transactions ${whereClause}`,
                [ctx.from.id]
            );
            const totalTransactions = parseInt(countResult[0].total);
            const totalPages = Math.ceil(totalTransactions / itemsPerPage);

            // Get total approved purchases (sum of all confirmed/paid transactions)
            const { rows: totalResult } = await dbPool.query(
                `SELECT COALESCE(SUM(requested_brl_amount), 0) as total_brl
                 FROM pix_transactions
                 WHERE user_id = $1 AND payment_status IN ('CONFIRMED', 'PAID')`,
                [ctx.from.id]
            );
            const totalApprovedBrl = parseFloat(totalResult[0].total_brl);

            // Get transactions for current page
            const { rows: transactions } = await dbPool.query(
                `SELECT requested_brl_amount, payment_status, created_at, transaction_id
                 FROM pix_transactions
                 ${whereClause}
                 ORDER BY created_at DESC
                 LIMIT $2 OFFSET $3`,
                [ctx.from.id, itemsPerPage, offset]
            );

            let message = filter === 'approved'
                ? `📜 **Transações Aprovadas**\n\n`
                : `📜 **Histórico de Transações**\n\n`;

            // Show total approved purchases
            message += `💰 *Total de compras:* R\\$ ${escapeMarkdownV2(totalApprovedBrl.toFixed(2))}\n\n`;

            if (transactions.length === 0) {
                message += `Nenhuma transação encontrada\\.`;
            } else {
                transactions.forEach((tx, index) => {
                    const date = new Date(tx.created_at).toLocaleString('pt-BR', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                    const status = tx.payment_status === 'CONFIRMED' || tx.payment_status === 'PAID' ? '✅' :
                                 tx.payment_status === 'PENDING' ? '⏳' : '❌';
                    const amount = parseFloat(tx.requested_brl_amount);
                    message += `${status} R\\$ ${escapeMarkdownV2(amount.toFixed(2))} \\- ${escapeMarkdownV2(date)}\n`;
                });

                // Add pagination info
                message += `\n*Página ${page + 1} de ${totalPages || 1}* \\(${totalTransactions} transações\\)`;
            }

            // Build keyboard with navigation and filters
            const buttons = [];

            // Filter buttons row
            if (filter === 'all') {
                buttons.push([
                    Markup.button.callback('✅ Apenas Aprovadas', `transaction_history:0:approved`),
                    Markup.button.callback('📥 Exportar CSV', `export_transactions:${filter}`)
                ]);
            } else {
                buttons.push([
                    Markup.button.callback('📋 Todas', `transaction_history:0:all`),
                    Markup.button.callback('📥 Exportar CSV', `export_transactions:${filter}`)
                ]);
            }

            // Navigation buttons row
            const navButtons = [];
            if (page > 0) {
                navButtons.push(Markup.button.callback('◀️ Anterior', `transaction_history:${page - 1}:${filter}`));
            }
            if (page < totalPages - 1 && totalPages > 1) {
                navButtons.push(Markup.button.callback('Próxima ▶️', `transaction_history:${page + 1}:${filter}`));
            }
            if (navButtons.length > 0) {
                buttons.push(navButtons);
            }

            // Back button
            buttons.push([Markup.button.callback('⬅️ Voltar', 'my_wallet')]);

            const keyboard = Markup.inlineKeyboard(buttons);

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

    // Export transactions to CSV
    bot.action(/^export_transactions:(all|approved)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery('Gerando arquivo CSV...');

            const filter = ctx.match[1];

            // Build query based on filter
            let whereClause = 'WHERE user_id = $1';
            if (filter === 'approved') {
                whereClause += ` AND payment_status IN ('CONFIRMED', 'PAID')`;
            }

            // Get all transactions for export
            const { rows: transactions } = await dbPool.query(
                `SELECT requested_brl_amount, payment_status, created_at, transaction_id,
                        depix_amount_expected, depix_txid
                 FROM pix_transactions
                 ${whereClause}
                 ORDER BY created_at DESC`,
                [ctx.from.id]
            );

            if (transactions.length === 0) {
                await ctx.answerCbQuery('Nenhuma transação para exportar', { show_alert: true });
                return;
            }

            // Generate CSV content
            let csv = 'Data,Status,Valor BRL,DePix Esperado,TXID DePix,ID Transação\n';

            transactions.forEach((tx) => {
                const date = new Date(tx.created_at).toLocaleString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const statusMap = {
                    'CONFIRMED': 'Aprovada',
                    'PAID': 'Aprovada',
                    'PENDING': 'Pendente',
                    'EXPIRED': 'Expirada',
                    'FAILED': 'Falhou'
                };
                const status = statusMap[tx.payment_status] || tx.payment_status;
                const amount = parseFloat(tx.requested_brl_amount).toFixed(2);
                const depixAmount = tx.depix_amount_expected ? parseFloat(tx.depix_amount_expected).toFixed(2) : '0.00';
                const depixTxid = tx.depix_txid || '-';

                csv += `"${date}","${status}","${amount}","${depixAmount}","${depixTxid}","${tx.transaction_id}"\n`;
            });

            // Send CSV file
            const filename = `transacoes_${filter}_${new Date().toISOString().split('T')[0]}.csv`;
            const buffer = Buffer.from(csv, 'utf-8');

            await ctx.replyWithDocument(
                { source: buffer, filename },
                {
                    caption: filter === 'approved'
                        ? `📊 Exportação de ${transactions.length} transações aprovadas`
                        : `📊 Exportação de ${transactions.length} transações`
                }
            );

        } catch (error) {
            logError('export_transactions', error, ctx);
            await ctx.answerCbQuery('Erro ao gerar CSV. Tente novamente.', { show_alert: true });
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

            // Criar depósito de R$ 1,00
            const webhookUrl = `${config.app.baseUrl}/webhooks/depix_payment`;
            let pixData;
            try {
                // Validação: QR aberto (sem identificação) para permitir qualquer pessoa pagar
                // O EUID será capturado do webhook após o pagamento
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

    // ============================================
    // HANDLERS DE SAQUE DEPIX → PIX
    // ============================================

    // Inicializar serviço de saques
    const withdrawalService = new WithdrawalService(dbPool);

    // Comando /saque - Saque rápido
    bot.command('saque', async (ctx) => {
        logger.info(`[Saque] Comando /saque recebido de ${ctx.from.id}`);
        try {
            const telegramUserId = ctx.from.id;
            clearUserState(telegramUserId);

            // Verificar se usuário é verificado
            const userStatus = await securityService.getUserStatus(dbPool, telegramUserId);
            if (!userStatus || !userStatus.is_verified) {
                await ctx.reply('❌ Você precisa validar sua conta primeiro. Use /start');
                return;
            }

            // Extrair parâmetros: /saque <valor> <chave_pix>
            const commandText = ctx.message.text.trim();
            const parts = commandText.split(/\s+/);

            if (parts.length < 3) {
                await ctx.reply(
                    '❌ *Formato inválido*\n\n' +
                    'Use: `/saque <valor> <chave_pix>`\n\n' +
                    '*Exemplos:*\n' +
                    '`/saque 500 +5511999999999` (Celular)\n' +
                    '`/saque 500 123.456.789-00` (CPF)\n' +
                    '`/saque 500 email@teste.com` (Email)\n' +
                    '`/saque 500 12345678901234` (CNPJ)\n' +
                    '`/saque 500 abc123xyz` (Aleatória)',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            const valorStr = parts[1].replace(',', '.');
            const chavePix = parts.slice(2).join(' ');

            // Validar valor
            const valor = parseFloat(valorStr);
            if (isNaN(valor) || valor < 100 || valor > 5940) {
                await ctx.reply('❌ Valor inválido. O saque deve ser entre R$ 100 e R$ 5.940');
                return;
            }

            // Validar chave PIX
            const pixValidation = InputValidator.validatePixKey(chavePix);
            if (!pixValidation.valid) {
                await ctx.reply(`❌ Chave PIX inválida: ${pixValidation.error}`);
                return;
            }

            // Verificar se já tem saque pendente
            const pendingWithdrawal = await withdrawalService.getUserPendingWithdrawal(telegramUserId);
            if (pendingWithdrawal) {
                await ctx.reply('❌ Você já tem um saque pendente. Aguarde a conclusão ou cancele-o.');
                return;
            }

            // Calcular taxas
            const fees = withdrawalService.calculateFees(valor);

            // Mostrar resumo e pedir confirmação
            setUserState(telegramUserId, {
                type: 'withdrawal_confirm',
                amount: valor,
                pixKey: pixValidation.normalized,
                pixKeyType: pixValidation.type,
                fees: fees
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Confirmar', 'withdrawal_confirm')],
                [Markup.button.callback('❌ Cancelar', 'withdrawal_cancel_flow')]
            ]);

            await ctx.reply(
                `💸 *Confirma?*\n\n` +
                `Você envia: *${fees.totalDepixRequired.toFixed(2)} DePix*\n` +
                `Você recebe: *R$ ${valor.toFixed(2)}*\n` +
                `PIX: \`${pixValidation.normalized}\` (${getPixKeyTypeName(pixValidation.type)})\n\n` +
                `_Taxa: R$ ${(fees.ourFeeAmount + fees.networkFeeAmount).toFixed(2)} (2,5% + rede)_`,
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            logError('command_saque', error, ctx);
            await sendTempError(ctx);
        }
    });

    // Action: withdrawal_start - Iniciar fluxo de saque (menu admin por enquanto)
    bot.action('withdrawal_start', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const telegramUserId = ctx.from.id;
            clearUserState(telegramUserId);

            // Verificar se usuário é verificado
            const userStatus = await securityService.getUserStatus(dbPool, telegramUserId);
            if (!userStatus || !userStatus.is_verified) {
                await ctx.editMessageText(
                    '❌ Você precisa validar sua conta primeiro.',
                    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]])
                );
                return;
            }

            // Verificar se já tem saque pendente
            const pendingWithdrawal = await withdrawalService.getUserPendingWithdrawal(telegramUserId);
            if (pendingWithdrawal) {
                // Mapear status para texto amigável
                const statusMap = {
                    'AWAITING_PAYMENT': '⏳ Aguardando pagamento',
                    'INSUFFICIENT_PAYMENT': '⚠️ Pagamento insuficiente',
                    'EXCESS_PAYMENT': '⚠️ Pagamento em excesso',
                    'PAYMENT_DETECTED': '✅ Pagamento detectado',
                    'PROCESSING': '🔄 Processando',
                    'COMPLETED': '✅ Concluído',
                    'CANCELLED': '❌ Cancelado',
                    'EXPIRED': '⏰ Expirado'
                };
                const statusText = statusMap[pendingWithdrawal.status] || pendingWithdrawal.status;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('📋 Ver Saque Pendente', `withdrawal_view:${pendingWithdrawal.withdrawal_id}`)],
                    [Markup.button.callback('❌ Cancelar Saque', `withdrawal_cancel:${pendingWithdrawal.withdrawal_id}`)],
                    [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
                ]);

                await ctx.editMessageText(
                    `⚠️ *Você já tem um saque pendente*\n\n` +
                    `💰 Valor: R$ ${parseFloat(pendingWithdrawal.requested_pix_amount).toFixed(2)}\n` +
                    `📱 Chave: \`${pendingWithdrawal.pix_key_value}\`\n` +
                    `📊 Status: ${statusText}\n\n` +
                    `Aguarde a conclusão ou cancele para iniciar um novo.`,
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );
                return;
            }

            // Mostrar menu de saque - limpo e direto
            setUserState(telegramUserId, {
                type: 'withdrawal_amount',
                messageIdToEdit: ctx.callbackQuery.message.message_id
            });

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('R$ 100', 'wd_val:100'),
                    Markup.button.callback('R$ 200', 'wd_val:200'),
                    Markup.button.callback('R$ 500', 'wd_val:500')
                ],
                [
                    Markup.button.callback('R$ 1.000', 'wd_val:1000'),
                    Markup.button.callback('R$ 2.000', 'wd_val:2000'),
                    Markup.button.callback('Outro', 'wd_custom')
                ],
                [Markup.button.callback('❌ Cancelar', 'withdrawal_cancel_flow')]
            ]);

            await ctx.editMessageText(
                `💸 *DePix → PIX*\n\n` +
                `Quanto você quer receber?`,
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            logError('withdrawal_start', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao iniciar saque');
        }
    });

    // Action: wd_val - Valor selecionado via botão
    bot.action(/wd_val:(\d+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const telegramUserId = ctx.from.id;
            const amount = parseInt(ctx.match[1]);

            setUserState(telegramUserId, {
                type: 'withdrawal_pix_key',
                amount: amount,
                messageIdToEdit: ctx.callbackQuery.message.message_id
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar', 'withdrawal_start')]
            ]);

            await ctx.editMessageText(
                `💸 *R$ ${amount.toLocaleString('pt-BR')}*\n\n` +
                `Pra qual chave PIX?`,
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            logError('wd_val', error, ctx);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Action: wd_custom - Digitar valor
    bot.action('wd_custom', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const telegramUserId = ctx.from.id;

            setUserState(telegramUserId, {
                type: 'withdrawal_amount',
                messageIdToEdit: ctx.callbackQuery.message.message_id
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar', 'withdrawal_start')]
            ]);

            await ctx.editMessageText(
                `💸 *Valor personalizado*\n\n` +
                `Digite quanto quer receber:\n` +
                `_(mín R$ 100 / máx R$ 5.940)_`,
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            logError('wd_custom', error, ctx);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Action: wd_keytype - Usuário escolheu tipo de chave (CPF ou Celular)
    bot.action(/wd_keytype:(PHONE|CPF)/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const telegramUserId = ctx.from.id;
            const userState = awaitingInputForUser[telegramUserId];
            const chosenType = ctx.match[1];

            if (!userState || userState.type !== 'withdrawal_pix_key_confirm_type' || !userState.ambiguousKey) {
                await ctx.editMessageText('❌ Sessão expirada. Tente novamente.');
                clearUserState(telegramUserId);
                return;
            }

            const rawKey = userState.ambiguousKey;
            let normalizedKey;
            let pixKeyType;

            if (chosenType === 'PHONE') {
                // Formatar como telefone: +55XXXXXXXXXXX
                const numbersOnly = rawKey.replace(/\D/g, '');
                normalizedKey = '+55' + numbersOnly;
                pixKeyType = 'PHONE';
            } else {
                // Formatar como CPF: XXX.XXX.XXX-XX
                const numbersOnly = rawKey.replace(/\D/g, '');
                normalizedKey = numbersOnly.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
                pixKeyType = 'CPF';
            }

            const amount = userState.amount;
            const withdrawalServiceLocal = new WithdrawalService(dbPool);
            const fees = withdrawalServiceLocal.calculateFees(amount);

            setUserState(telegramUserId, {
                type: 'withdrawal_confirm',
                amount: amount,
                pixKey: normalizedKey,
                pixKeyType: pixKeyType,
                fees: fees
            });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Confirmar', 'withdrawal_confirm')],
                [Markup.button.callback('⬅️ Voltar', 'withdrawal_start')]
            ]);

            const confirmMsg =
                `💸 *Confirma?*\n\n` +
                `Você envia: *${fees.totalDepixRequired.toFixed(2)} DePix*\n` +
                `Você recebe: *R$ ${amount.toFixed(2)}*\n` +
                `PIX: \`${normalizedKey}\` (${getPixKeyTypeName(pixKeyType)})\n\n` +
                `_Taxa: R$ ${(fees.ourFeeAmount + fees.networkFeeAmount).toFixed(2)} (2,5% + rede)_`;

            await ctx.editMessageText(confirmMsg, {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });
        } catch (error) {
            logError('wd_keytype', error, ctx);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Action: withdrawal_confirm - Confirmar saque
    bot.action('withdrawal_confirm', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const telegramUserId = ctx.from.id;
            const userState = awaitingInputForUser[telegramUserId];

            if (!userState || userState.type !== 'withdrawal_confirm') {
                await ctx.editMessageText('❌ Sessão expirada. Use /saque novamente.');
                clearUserState(telegramUserId);
                return;
            }

            const { amount, pixKey, pixKeyType, fees } = userState;
            clearUserState(telegramUserId);

            // Criar saque
            await ctx.editMessageText('⏳ Gerando endereço...');

            try {
                const withdrawal = await withdrawalService.createWithdrawal({
                    telegramUserId,
                    pixAmount: amount,
                    pixKeyType,
                    pixKeyValue: pixKey
                });

                withdrawalService.bot = ctx.telegram;

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancelar', `withdrawal_cancel:${withdrawal.withdrawal_id}`)]
                ]);

                await ctx.editMessageText(
                    `✅ *Envie ${fees.totalDepixRequired.toFixed(2)} DePix*\n\n` +
                    `\`${withdrawal.deposit_address}\`\n\n` +
                    `➡️ Você recebe: *R$ ${amount.toFixed(2)}*\n` +
                    `📱 PIX: \`${pixKey}\`\n` +
                    `⏱ Prazo: ${withdrawal.estimatedCompletionText}\n\n` +
                    `_Expira em 60 min • Detecção automática_`,
                    { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
                );

                // Salvar ID da mensagem para atualizações
                await dbPool.query(
                    'UPDATE withdrawal_transactions SET info_message_id = $1 WHERE withdrawal_id = $2',
                    [ctx.callbackQuery.message.message_id, withdrawal.withdrawal_id]
                );

            } catch (error) {
                await ctx.editMessageText(`❌ Erro ao criar saque: ${error.message}`);
            }
        } catch (error) {
            logError('withdrawal_confirm', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao confirmar saque');
        }
    });

    // Action: withdrawal_cancel - Cancelar saque específico
    bot.action(/withdrawal_cancel:(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const telegramUserId = ctx.from.id;
            const withdrawalId = ctx.match[1];

            try {
                await withdrawalService.cancelWithdrawal(withdrawalId, telegramUserId);

                await ctx.editMessageText(
                    '✅ Saque cancelado com sucesso.\n\nVocê pode iniciar um novo saque quando quiser.',
                    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]])
                );
            } catch (error) {
                await ctx.editMessageText(`❌ ${error.message}`);
            }
        } catch (error) {
            logError('withdrawal_cancel', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao cancelar saque');
        }
    });

    // Action: withdrawal_cancel_flow - Cancelar fluxo de saque
    bot.action('withdrawal_cancel_flow', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            clearUserState(ctx.from.id);
            await sendMainMenu(ctx, 'Saque cancelado.');
        } catch (error) {
            logError('withdrawal_cancel_flow', error, ctx);
        }
    });

    // Action: withdrawal_view - Ver detalhes do saque
    bot.action(/withdrawal_view:(.+)/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const withdrawalId = ctx.match[1];

            const withdrawal = await withdrawalService.getWithdrawalDetails(withdrawalId);
            if (!withdrawal) {
                await ctx.editMessageText('❌ Saque não encontrado.');
                return;
            }

            const statusEmoji = {
                'AWAITING_PAYMENT': '⏳',
                'PAYMENT_DETECTED': '✅',
                'PROCESSING': '🔄',
                'COMPLETED': '✅',
                'EXPIRED': '⏰',
                'CANCELLED': '❌',
                'FAILED': '❌'
            };

            const statusText = {
                'AWAITING_PAYMENT': 'Aguardando pagamento',
                'PAYMENT_DETECTED': 'Pagamento detectado',
                'PROCESSING': 'Processando',
                'COMPLETED': 'Concluído',
                'EXPIRED': 'Expirado',
                'CANCELLED': 'Cancelado',
                'FAILED': 'Falhou'
            };

            let message = `📋 *Detalhes do Saque*\n\n` +
                `${statusEmoji[withdrawal.status]} Status: ${statusText[withdrawal.status]}\n\n` +
                `💰 Valor PIX: R$ ${parseFloat(withdrawal.requested_pix_amount).toFixed(2)}\n` +
                `📱 Chave: ${withdrawal.pix_key_value}\n` +
                `💸 Total DePix: ${parseFloat(withdrawal.total_depix_required).toFixed(2)}\n`;

            if (withdrawal.status === 'AWAITING_PAYMENT') {
                message += `\n📍 *Endereço para pagamento:*\n\`${withdrawal.deposit_address}\`\n`;
            }

            if (withdrawal.liquid_txid) {
                message += `\n🔗 TXID: \`${withdrawal.liquid_txid.substring(0, 16)}...\`\n`;
            }

            const buttons = [];
            if (withdrawal.status === 'AWAITING_PAYMENT') {
                buttons.push([Markup.button.callback('❌ Cancelar', `withdrawal_cancel:${withdrawalId}`)]);
            }
            buttons.push([Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]);

            await ctx.editMessageText(message, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
        } catch (error) {
            logError('withdrawal_view', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao ver saque');
        }
    });

    // Handler de texto para fluxo de saque
    // Adicionado ao bot.on('text') existente - será processado no switch de estados

    // ========================================
    // MENU IMPULSIONAR ATLAS (BOUNTIES) - PARA USUÁRIOS
    // ========================================
    const bountyService = new BountyService(dbPool, bot);
    const PROJECTS_PER_PAGE = 5;

    // Função helper para renderizar lista de projetos com paginação
    async function renderProjectsList(ctx, page = 0) {
        const totalCount = await bountyService.countBounties('approved');

        if (totalCount === 0) {
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💡 Sugerir Projeto', 'user_bounty_suggest')],
                [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
            ]);

            await ctx.editMessageText(
                '🚀 *Impulsionar Atlas*\n\n' +
                'A Atlas é sustentada por contribuições da comunidade. ' +
                'Aqui você pode financiar projetos que quer ver prontos ou assumir trabalhos e ser remunerado.\n\n' +
                '📭 Nenhum projeto aberto no momento.\n\n' +
                'Tem uma ideia? Sugira um projeto!',
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
            return;
        }

        const totalPages = Math.ceil(totalCount / PROJECTS_PER_PAGE);
        const currentPage = Math.max(0, Math.min(page, totalPages - 1));
        const offset = currentPage * PROJECTS_PER_PAGE;

        const bounties = await bountyService.listBounties('approved', PROJECTS_PER_PAGE, offset);

        // Botões dos projetos
        const buttons = bounties.map(b => {
            const funded = parseFloat(b.total_brl || 0);
            const progress = funded > 0 ? ` 💰 R$${funded.toFixed(0)}` : '';
            const title = b.title.length > 25 ? b.title.substring(0, 24) + '…' : b.title;
            return [Markup.button.callback(
                `${title}${progress}`,
                `user_bounty_view:${b.id}`
            )];
        });

        // Navegação de páginas (se houver mais de uma página)
        if (totalPages > 1) {
            const navButtons = [];

            if (currentPage > 0) {
                navButtons.push(Markup.button.callback('◀️', `user_bounties_page:${currentPage - 1}`));
            } else {
                navButtons.push(Markup.button.callback(' ', 'noop'));
            }

            navButtons.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'noop'));

            if (currentPage < totalPages - 1) {
                navButtons.push(Markup.button.callback('▶️', `user_bounties_page:${currentPage + 1}`));
            } else {
                navButtons.push(Markup.button.callback(' ', 'noop'));
            }

            buttons.push(navButtons);
        }

        // Botões de ação
        buttons.push([Markup.button.callback('💡 Sugerir Projeto', 'user_bounty_suggest')]);
        buttons.push([Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]);

        await ctx.editMessageText(
            '🚀 *Impulsionar Atlas*\n\n' +
            'A Atlas é sustentada por contribuições da comunidade. ' +
            'Escolha um projeto para contribuir ou assumir:\n\n' +
            `📊 ${totalCount} projeto${totalCount > 1 ? 's' : ''} aberto${totalCount > 1 ? 's' : ''}`,
            { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup }
        );
    }

    bot.action('user_bounties', async (ctx) => {
        try {
            clearUserState(ctx.from.id); // Limpar estado pendente (ex: sugestão cancelada)
            await ctx.answerCbQuery();
            await renderProjectsList(ctx, 0);
        } catch (error) {
            logError('user_bounties', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao carregar projetos');
        }
    });

    // Paginação
    bot.action(/^user_bounties_page:(\d+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const page = parseInt(ctx.match[1]);
            await renderProjectsList(ctx, page);
        } catch (error) {
            logError('user_bounties_page', error, ctx);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Handler vazio para botões de navegação desabilitados
    bot.action('noop', async (ctx) => {
        await ctx.answerCbQuery();
    });

    // Ver detalhes de um bounty (usuário)
    bot.action(/^user_bounty_view:(\d+)$/, async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const bountyId = parseInt(ctx.match[1]);
            const bounty = await bountyService.getBountyById(bountyId);

            if (!bounty || bounty.status !== 'approved') {
                return ctx.editMessageText('❌ Projeto não encontrado ou não está disponível.');
            }

            const escapeMarkdown = (text) => {
                if (!text) return '';
                return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
            };

            const totalBrl = parseFloat(bounty.total_brl || 0).toFixed(2).replace('.', '\\.');
            const votes = bounty.vote_count || 0;

            const message =
                `🎯 *${escapeMarkdown(bounty.title)}*\n\n` +
                `${escapeMarkdown(bounty.short_description?.substring(0, 500) || '')}\n\n` +
                `💰 *Arrecadado:* R\\$ ${totalBrl}\n` +
                `👥 *Contribuições:* ${votes}\n\n` +
                `_Escolha como quer participar:_`;

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💰 Quero Contribuir', `bounty_contribute:${bountyId}`)],
                [Markup.button.callback('🛠️ Quero Trabalhar', `bounty_work:${bountyId}`)],
                [Markup.button.callback('⬅️ Voltar', 'user_bounties')]
            ]);

            await ctx.editMessageText(message, {
                parse_mode: 'MarkdownV2',
                reply_markup: keyboard.reply_markup
            });
        } catch (error) {
            logError('user_bounty_view', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao carregar projeto');
        }
    });

    // Sugerir novo projeto
    bot.action('user_bounty_suggest', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            setUserState(ctx.from.id, { type: 'bounty_suggest_title' });

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancelar', 'user_bounties')]
            ]);

            await ctx.editMessageText(
                '💡 *Sugerir Projeto*\n\n' +
                'Tem uma ideia para melhorar a Atlas? Sugira!\n\n' +
                '📝 Digite o *título* do seu projeto (máx. 40 caracteres):',
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            logError('user_bounty_suggest', error, ctx);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // ========================================
    // BOUNTY HANDLERS PARA USUÁRIOS COMUNS
    // ========================================

    // Menu de contribuição - escolher método de pagamento
    bot.action(/^bounty_contribute:(\d+)$/, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            const bounty = await bountyService.getBountyById(bountyId);

            if (!bounty || bounty.status !== 'approved') {
                return ctx.answerCbQuery('❌ Projeto não disponível');
            }

            const escapeMarkdown = (text) => {
                if (!text) return '';
                return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
            };

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💳 PIX', `bounty_vote_pix:${bountyId}`)],
                [Markup.button.callback('🔗 DePix (Liquid)', `bounty_vote_liquid:${bountyId}:LIQUID_DEPIX`)],
                [Markup.button.callback('₿ L-BTC', `bounty_vote_liquid:${bountyId}:LIQUID_LBTC`)],
                [Markup.button.callback('💵 L-USDT', `bounty_vote_liquid:${bountyId}:LIQUID_USDT`)],
                [Markup.button.callback('⬅️ Voltar', `user_bounty_view:${bountyId}`)]
            ]);

            await ctx.editMessageText(
                `💰 *Contribuir para o Projeto*\n\n` +
                `*${escapeMarkdown(bounty.title)}*\n\n` +
                `Sua contribuição ajuda a financiar este projeto\\. Quando a meta for atingida, um trabalhador poderá executá\\-lo e receber a recompensa\\.\n\n` +
                `Selecione o método de contribuição:`,
                { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logError('bounty_contribute', error, ctx);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Menu de trabalho - assumir o projeto
    bot.action(/^bounty_work:(\d+)$/, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            const bounty = await bountyService.getBountyById(bountyId);

            if (!bounty || bounty.status !== 'approved') {
                return ctx.answerCbQuery('❌ Projeto não disponível');
            }

            const escapeMarkdown = (text) => {
                if (!text) return '';
                return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
            };

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Assumir este Projeto', `bounty_claim:${bountyId}`)],
                [Markup.button.callback('⬅️ Voltar', `user_bounty_view:${bountyId}`)]
            ]);

            await ctx.editMessageText(
                `🛠️ *Trabalhar neste Projeto*\n\n` +
                `*${escapeMarkdown(bounty.title)}*\n\n` +
                `${escapeMarkdown(bounty.short_description)}\n\n` +
                `💰 *Recompensa:* R\\$ ${parseFloat(bounty.total_brl || 0).toFixed(2).replace('.', '\\.')}\n\n` +
                `Ao assumir este projeto, você se compromete a executá\\-lo\\. Um admin irá aprovar sua solicitação e você poderá começar a trabalhar\\.\n\n` +
                `Ao concluir, envie o resultado e receba a recompensa\\!`,
                { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logError('bounty_work', error, ctx);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Assumir projeto (claim)
    bot.action(/^bounty_claim:(\d+)$/, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            await bountyService.claimBounty(bountyId, ctx.from.id, ctx.from.username);

            await ctx.editMessageText(
                `✅ *Solicitação Enviada\\!*\n\n` +
                `Você solicitou assumir o projeto \\#${bountyId}\\.\n\n` +
                `Um administrador irá analisar sua solicitação e você será notificado quando for aprovado\\.\n\n` +
                `_Aguarde a aprovação para começar a trabalhar\\._`,
                { parse_mode: 'MarkdownV2' }
            );
            await ctx.answerCbQuery('✅ Solicitação enviada!');
        } catch (error) {
            logError('bounty_claim', error, ctx);
            await ctx.answerCbQuery(`❌ ${error.message}`);
        }
    });

    // Contribuir com PIX - pedir valor
    bot.action(/^bounty_vote_pix:(\d+)$/, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);

            setUserState(ctx.from.id, {
                type: 'bounty_vote_pix_amount',
                bountyId: bountyId
            });

            await ctx.editMessageText(
                `💳 *Contribuir com PIX*\n\n` +
                `Digite o valor em R$ (mínimo R$ ${config.bounties.minPixAmountBrl}, máximo R$ ${config.bounties.maxPixAmountBrl}):\n\n` +
                `_Exemplo: 50 ou 100.50_\n\n` +
                `_Envie /cancel para cancelar_`,
                { parse_mode: 'Markdown' }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logError('bounty_vote_pix', error, ctx);
            await ctx.answerCbQuery('❌ Erro');
        }
    });

    // Contribuir com Liquid - gerar endereço
    bot.action(/^bounty_vote_liquid:(\d+):(.+)$/, async (ctx) => {
        try {
            const bountyId = parseInt(ctx.match[1]);
            const assetType = ctx.match[2];

            const { payment, address, assetId } = await bountyService.createLiquidPayment(
                bountyId,
                ctx.from.id,
                ctx.from.username,
                assetType
            );

            const assetName = assetType === 'LIQUID_LBTC' ? 'L-BTC' :
                assetType === 'LIQUID_USDT' ? 'L-USDT' : 'DePix';

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar', `bounty_contribute:${bountyId}`)]
            ]);

            await ctx.editMessageText(
                `🔗 *Contribuição ${assetName}*\n\n` +
                `Envie ${assetName} para o endereço abaixo:\n\n` +
                `\`${address}\`\n\n` +
                `✅ Detecção automática em ~30 segundos\n\n` +
                `_Toque no endereço para copiar_`,
                { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
            );
            await ctx.answerCbQuery();
        } catch (error) {
            logError('bounty_vote_liquid', error, ctx);
            await ctx.answerCbQuery(`❌ ${error.message}`);
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