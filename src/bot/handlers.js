const { Markup } = require('telegraf');
const config = require('../core/config');
const logger = require('../core/logger');
const depixApiService = require('../services/depixApiService');
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');
const securityService = require('../services/securityService');

const isValidLiquidAddress = (address) => {
    if (!address || typeof address !== 'string') return false;
    const trimmedAddress = address.trim();
    const nonConfidentialMainnet = (trimmedAddress.startsWith('ex1') || trimmedAddress.startsWith('lq1'));
    const confidentialMainnet = (trimmedAddress.startsWith('VJL') || trimmedAddress.startsWith('VTj'));
    const currentLength = trimmedAddress.length;
    const isValidLength = currentLength > 40 && currentLength < 110; 
    const result = (nonConfidentialMainnet || confidentialMainnet) && isValidLength;
    logger.info(`[isValidLiquidAddress] Input: "${address}", Result: ${result}`);
    return result;
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

    // Menu principal para usuários validados
    const mainMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('💸 Comprar Depix Liquid', 'receive_pix_start')],
        [Markup.button.callback('📊 Meu Status', 'user_status')],
        [Markup.button.callback('💼 Minha Carteira', 'my_wallet')],
        [Markup.button.callback('📈 Histórico', 'transaction_history')],
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
            if (!ctx.headersSent) await ctx.reply('Ocorreu um erro. Use /start para recomeçar.');
        }
    };
    
    const initialConfigKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Já tenho uma carteira Liquid', 'ask_liquid_address')],
        [Markup.button.callback('❌ Ainda não tenho uma carteira Liquid', 'explain_liquid_wallet')],
        [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
        [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
    ]);

    const clearUserState = (userId) => { 
        if (userId) delete awaitingInputForUser[userId];
    };
    
    bot.start(async (ctx) => {
        clearUserState(ctx.from.id);
        const telegramUserId = ctx.from.id;
        const telegramUsername = ctx.from.username || 'N/A';
        logger.info(`User ${telegramUserId} (${telegramUsername}) started the bot.`);
        try {
            const { rows } = await dbPool.query('SELECT liquid_address, telegram_username FROM users WHERE telegram_user_id = $1', [telegramUserId]);
            if (rows.length > 0 && rows[0].liquid_address) {
                await sendMainMenu(ctx, 'Bem-vindo de volta! O que você gostaria de fazer hoje?');
            } else {
                const initialMessage = `🌟 **Bem\\-vindo ao Bridge Atlas\\!**\n\n` +
                                      `Somos a ponte entre o sistema financeiro tradicional e a soberania digital\\.\n\n` +
                                      `💎 **O que você pode fazer:**\n` +
                                      `• Converter PIX em DePix \\(Real digital soberano\\)\n` +
                                      `• Manter controle total sobre seus fundos\n` +
                                      `• Transacionar com privacidade e segurança\n\n` +
                                      `🔐 Para começar, precisamos do endereço da sua carteira Liquid\\.\n\n` +
                                      `Você já possui uma carteira?`;
                await ctx.replyWithMarkdownV2(initialMessage, initialConfigKeyboardObj);
                if (rows.length === 0) {
                    await dbPool.query('INSERT INTO users (telegram_user_id, telegram_username) VALUES ($1, $2) ON CONFLICT (telegram_user_id) DO NOTHING', [telegramUserId, telegramUsername]);
                    logger.info(`User ${telegramUserId} (${telegramUsername}) newly registered in DB (no address yet).`);
                } else if ((rows[0] && !rows[0].telegram_username && telegramUsername !== 'N/A') || (rows[0]?.telegram_username !== telegramUsername)) { 
                    await dbPool.query('UPDATE users SET telegram_username = $1, updated_at = NOW() WHERE telegram_user_id = $2', [telegramUsername, telegramUserId]);
                    logger.info(`User ${telegramUserId} username updated to ${telegramUsername}.`);
                }
            }
        } catch (error) { 
            logError('/start', error, ctx); 
            try { await ctx.reply('Ocorreu um erro ao iniciar. Tente /start novamente.'); } catch (e) { logError('/start fallback reply', e, ctx); }
        }
    });

    bot.action('ask_liquid_address', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            const message = 'Por favor, digite ou cole o **endereço público da sua carteira Liquid** onde você deseja receber seus DePix\\.';
            const sentMessage = ctx.callbackQuery?.message ? await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' }) : await ctx.replyWithMarkdownV2(message);
            awaitingInputForUser[ctx.from.id] = { type: 'liquid_address_initial', messageIdToEdit: sentMessage?.message_id || null };
            await ctx.answerCbQuery();
        } catch (error) { 
            logError('ask_liquid_address', error, ctx); 
            if (!ctx.answered) { try { await ctx.answerCbQuery('Erro ao processar.'); } catch(e){} }
            await ctx.replyWithMarkdownV2('Por favor, digite ou cole o **endereço público da sua carteira Liquid**\\.');
        }
    });

    bot.action('explain_liquid_wallet', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();
            const supportContactEscaped = escapeMarkdownV2(config.links.supportContact);
            const message = `Sem problemas\\! É fácil criar uma\\. O DePix opera na Liquid Network, uma rede lateral \\(sidechain\\) do Bitcoin\\.\n\nRecomendamos usar uma das seguintes carteiras que são compatíveis com Liquid:\n\\- **Aqua Wallet:** Para iOS e Android\\. \\(Busque na sua loja de aplicativos\\)\n\\- **SideSwap:** Para desktop e mobile\\. \\(Acesse [sideswap\\.io](https://sideswap.io)\\)\n\nApós criar sua carteira, você terá um endereço Liquid\\. Volte aqui e selecione '${escapeMarkdownV2('[✅ Já tenho uma carteira Liquid]')}' para associá\\-lo ao bot\\.\n\nSe precisar de ajuda ou tiver dúvidas, contate nosso suporte: ${supportContactEscaped}`;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('⬅️ Voltar à Configuração', 'back_to_start_config')],
                [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
                [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
            ]);
            if (ctx.callbackQuery?.message) await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup, disable_web_page_preview: true });
            else await ctx.replyWithMarkdownV2(message, keyboard);
        } catch (error) { 
            logError('explain_liquid_wallet', error, ctx); 
            await ctx.replyWithMarkdownV2("Ocorreu um erro ao mostrar a ajuda da carteira. Tente o menu /start.");
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
            
            const amount = parseFloat(text.replace(',', '.')); 
            
            // Verificar limite do usuário antes de validar o valor
            const userStatusCheck = await securityService.getUserStatus(dbPool, telegramUserId);
            const maxAllowed = Math.min(
                userStatusCheck?.available_today || 50,
                userStatusCheck?.max_per_transaction_brl || 5000
            );
            
            // Validação adicional - impedir valores suspeitos
            if (!isNaN(amount) && amount >= 1 && amount <= maxAllowed && amount.toFixed(2) == amount) {
                logger.info(`Received amount ${amount} for deposit from user ${telegramUserId}`);
                let messageIdToUpdate = userState.messageIdToEdit;

                try {
                    const sentMsg = messageIdToUpdate ? await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Verificando seus limites...') : await ctx.reply('Verificando seus limites...');
                    messageIdToUpdate = sentMsg.message_id;
                    
                    // Verificar se o usuário pode fazer a transação com base nos limites
                    const canTransact = await securityService.checkUserCanTransact(dbPool, telegramUserId, amount);
                    if (!canTransact.canTransact) {
                        clearUserState(telegramUserId);
                        await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, `❌ ${canTransact.reason}`);
                        return;
                    }
                    
                    await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Verificando status do serviço DePix...');
                    
                    if (!await depixApiService.ping()) { clearUserState(telegramUserId); await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'O serviço DePix parece estar instável. Tente novamente mais tarde.'); return; }
                                        
                    const userResult = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_user_id = $1', [telegramUserId]);
                    if (!userResult.rows.length || !userResult.rows[0].liquid_address) { 
                        clearUserState(telegramUserId);
                        await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Sua carteira Liquid não foi encontrada. Use /start para configurar.');
                        return; 
                    }
                    
                    const userLiquidAddress = userResult.rows[0].liquid_address;
                    const amountInCents = Math.round(amount * 100);
                    await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Gerando seu QR Code Pix, aguarde...');
                    
                    const webhookUrl = `${config.app.baseUrl}/webhooks/depix_payment`;
                    const pixData = await depixApiService.generatePixForDeposit(amountInCents, userLiquidAddress, webhookUrl);
                    const { qrCopyPaste, qrImageUrl, id: depixApiEntryId } = pixData;
                    
                    const dbResult = await dbPool.query( 'INSERT INTO pix_transactions (user_id, requested_brl_amount, depix_amount_expected, pix_qr_code_payload, payment_status, depix_api_entry_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING transaction_id', [telegramUserId, amount, (amount - 0.99), qrCopyPaste, 'PENDING', depixApiEntryId]);
                    const internalTxId = dbResult.rows[0].transaction_id;
                    logger.info(`Transaction ${internalTxId} for BRL ${amount.toFixed(2)} saved. DePix API ID: ${depixApiEntryId}`);

                    const reminderJobId = `expectation-${depixApiEntryId}`;
                    await expectationMessageQueue.add(reminderJobId, { telegramUserId, depixApiEntryId, supportContact: escapeMarkdownV2(config.links.supportContact) }, { delay: 19 * 60 * 1000, removeOnComplete: true, removeOnFail: true, jobId: reminderJobId });
                    
                    const expirationJobId = `expiration-${depixApiEntryId}`;
                    await expirationQueue.add(expirationJobId, { telegramUserId, depixApiEntryId, requestedBrlAmount: amount }, { delay: 19 * 60 * 1000, removeOnComplete: true, removeOnFail: true, jobId: expirationJobId });
                    logger.info(`Jobs added: Reminder (${reminderJobId}) and Expiration (${expirationJobId}) for user ${telegramUserId}`);

                    let caption = `✅ **QR Code Gerado com Sucesso\\!**\n\n`;
                    caption += `💵 **Valor a pagar:** R\\$ ${escapeMarkdownV2(amount.toFixed(2))}\n`;
                    caption += `💰 **Você receberá:** ${escapeMarkdownV2((amount - 0.99).toFixed(2))} DePix\n`;
                    caption += `⏱️ **Válido por:** 19 minutos\n\n`;
                    caption += `📋 **PIX Copia e Cola:**\n`;
                    caption += `\`${escapeMarkdownV2(qrCopyPaste)}\`\n\n`;
                    caption += `⚠️ **ATENÇÃO IMPORTANTE:**\n`;
                    caption += `• Você deve fazer o pagamento com a mesma conta \\(CPF/CNPJ\\) que foi validada\\.\n`;
                    caption += `• Pagamentos de contas diferentes serão recusados automaticamente\\.\n`;
                    caption += `• Após o pagamento, você receberá os DePix em sua carteira Liquid\\.`;
                    
                    await ctx.telegram.deleteMessage(ctx.chat.id, messageIdToUpdate);
                    
                    // Adicionar botão de cancelar
                    const keyboard = Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Cancelar', `cancel_qr:${depixApiEntryId}`)]
                    ]);
                    
                    const qrPhotoMessage = await ctx.replyWithPhoto(qrImageUrl, { 
                        caption: caption, 
                        parse_mode: 'MarkdownV2',
                        reply_markup: keyboard.reply_markup
                    });

                    await dbPool.query('UPDATE pix_transactions SET qr_code_message_id = $1 WHERE transaction_id = $2', [qrPhotoMessage.message_id, internalTxId]);
                    clearUserState(telegramUserId);

                } catch (apiError) { 
                    clearUserState(telegramUserId); 
                    logError('generate_pix_api_call_or_ping', apiError, ctx); 
                    const errorReply = `Desculpe, ocorreu um problema ao gerar o QR Code: ${apiError.message}`;
                    if (messageIdToUpdate) await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, errorReply);
                    else await ctx.reply(errorReply);
                }
            } else { 
                await ctx.replyWithMarkdownV2(`Valor inválido\\. Por favor, envie um valor entre R\\$ 1\\.00 e R\\$ ${escapeMarkdownV2(maxAllowed.toFixed(2))} \\(ex: \`45.21\`\\)\\.`);
            }
        } else if (userState && (userState.type === 'liquid_address_initial' || userState.type === 'liquid_address_change')) {
            if (isValidLiquidAddress(text)) {
                try {
                    await dbPool.query('INSERT INTO users (telegram_user_id, telegram_username, liquid_address, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_user_id) DO UPDATE SET liquid_address = EXCLUDED.liquid_address, telegram_username = EXCLUDED.telegram_username, updated_at = NOW()', [telegramUserId, telegramUsername, text]);
                    logger.info(`User ${telegramUserId} associated/updated Liquid address: ${text}`);
                    const successMessage = 'Endereço Liquid associado com sucesso!';
                    if (userState.messageIdToEdit) await ctx.telegram.editMessageText(ctx.chat.id, userState.messageIdToEdit, undefined, successMessage);
                    else await ctx.reply(successMessage);
                    clearUserState(telegramUserId); 
                    await sendMainMenu(ctx);
                } catch (error) { 
                    logError('text_handler (save_address)', error, ctx); 
                    await ctx.reply('Ocorreu um erro ao salvar seu endereço Liquid. Tente novamente.');
                }
            } else { 
                await ctx.replyWithMarkdownV2(`O endereço fornecido não parece ser uma carteira Liquid válida\\. Verifique o formato e tente novamente\\.`, Markup.inlineKeyboard([[Markup.button.callback('❌ Preciso de Ajuda com Carteira', 'explain_liquid_wallet')]]));
            }
        } else {
            logger.info(`Unhandled text from user ${telegramUserId} ("${text.substring(0,20)}...") in state: ${JSON.stringify(userState)}`);
        }
    });

    bot.action('receive_pix_start', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();
            
            const userId = ctx.from.id;
            
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
            
            const amountRequestMessage = `Qual o valor em reais que você deseja receber via Pix? \\(Ex: \`45.21\`\\)\n\nLembre\\-se:\n\\- O valor deve ser entre R\\$ 1\\.00 e R\\$ ${escapeMarkdownV2(effectiveMax.toFixed(2))}\\.\n\\- Há uma taxa de R\\$0,99 pela transação\\.\n\\- Seu limite disponível hoje: R\\$ ${escapeMarkdownV2(availableLimit.toFixed(2))}`;
            const sentMessage = ctx.callbackQuery?.message ? await ctx.editMessageText(amountRequestMessage, { parse_mode: 'MarkdownV2' }) : await ctx.replyWithMarkdownV2(amountRequestMessage);
            awaitingInputForUser[ctx.from.id] = { type: 'amount', messageIdToEdit: sentMessage?.message_id || null };
        } catch (error) { 
            logError('receive_pix_start', error, ctx); 
            await ctx.reply("Ocorreu um erro. Tente o menu /start.");
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
            await ctx.reply('Ocorreu um erro ao buscar sua carteira.');
        }
    });

    bot.action('change_wallet_start', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const message = 'OK\\! Por favor, envie seu **novo endereço público da carteira Liquid**\\.';
            const sentMessage = ctx.callbackQuery?.message ? await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' }) : await ctx.replyWithMarkdownV2(message);
            awaitingInputForUser[ctx.from.id] = { type: 'liquid_address_change', messageIdToEdit: sentMessage?.message_id || null };
        } catch (error) { 
            logError('change_wallet_start', error, ctx); 
            await ctx.reply('Ocorreu um erro. Tente novamente.');
        }
    });
    
    const TRANSACTIONS_PER_PAGE = 5;
    bot.action(/^transaction_history(?::(\d+))?$/, async (ctx) => {
        clearUserState(ctx.from.id);
        const page = ctx.match[1] ? parseInt(ctx.match[1], 10) : 0;
        const offset = page * TRANSACTIONS_PER_PAGE;
        try {
            await ctx.answerCbQuery();
            const { rows: transactions } = await dbPool.query( `SELECT transaction_id, requested_brl_amount, payment_status, depix_txid, created_at FROM pix_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [ctx.from.id, TRANSACTIONS_PER_PAGE, offset]);
            const { rows: countResult } = await dbPool.query( 'SELECT COUNT(*) AS total FROM pix_transactions WHERE user_id = $1', [ctx.from.id]);
            const totalTransactions = parseInt(countResult[0].total, 10);
            const totalPages = Math.ceil(totalTransactions / TRANSACTIONS_PER_PAGE);

            let message = `**Seu Histórico de Transações**\n\n`;
            if (transactions.length === 0) {
                message += 'Nenhuma transação encontrada\\.';
            } else {
                transactions.forEach(tx => {
                    const date = escapeMarkdownV2(new Date(tx.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }));
                    const statusEmoji = tx.payment_status === 'PAID' ? '✅' : (tx.payment_status === 'PENDING' ? '⏳' : (tx.payment_status === 'EXPIRED' ? '⏰' : '❌'));
                    message += `${statusEmoji} *${date}* \\- R\\$ ${escapeMarkdownV2(Number(tx.requested_brl_amount).toFixed(2))}\n`;
                    message += `   Status: ${escapeMarkdownV2(tx.payment_status)}\n`;
                    if (tx.depix_txid) { message += `   TXID: \`${escapeMarkdownV2(tx.depix_txid.substring(0,10))}...\`\n`; }
                    message += `   ID: \`${escapeMarkdownV2(tx.transaction_id.substring(0,8))}\`\n\n`;
                });
            }

            const paginationButtons = [];
            if (page > 0) { paginationButtons.push(Markup.button.callback('⬅️ Anterior', `transaction_history:${page - 1}`)); }
            if (page < totalPages - 1) { paginationButtons.push(Markup.button.callback('Próxima ➡️', `transaction_history:${page + 1}`)); }

            const keyboard = Markup.inlineKeyboard([paginationButtons, [Markup.button.callback('⬅️ Voltar', 'my_wallet')]]);
            if (ctx.callbackQuery?.message) await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup, disable_web_page_preview: true });
            else await ctx.replyWithMarkdownV2(message, { reply_markup: keyboard.reply_markup });
        } catch (error) { 
            if (error.message.includes("message is not modified")) return;
            logError('transaction_history', error, ctx); 
            await ctx.reply('Ocorreu um erro ao buscar seu histórico.');
        }
    });
    
    bot.action('back_to_main_menu', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            await ctx.answerCbQuery();
            await sendMainMenu(ctx);
        } catch (error) { 
            logError('back_to_main_menu', error, ctx); 
            await ctx.reply('Ocorreu um erro ao voltar ao menu. Tente /start.');
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
            await ctx.replyWithMarkdownV2('Ocorreu um erro ao mostrar as informações\\. Tente o menu /start\\.');
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
            
            const validationMessage = `🔐 **Validação de Conta**\n\n` +
                                     `Para começar a usar o Bridge, precisamos validar sua conta\\. Este processo serve para:\n\n` +
                                     `✅ Confirmar que você não é um robô\n` +
                                     `✅ Proteger contra abusos e fraudes\n` +
                                     `✅ Liberar limites progressivos de transação\n\n` +
                                     `Ao fazer o pagamento de R\\$ 1,00 você valida sua conta, receberá R\\$ 0,01 e desbloqueará o limite diário de 50 reais\\. Esse limite irá aumentando conforme você vai comprando\\.\n\n` +
                                     `Deseja continuar com a validação?`;
            
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
            await ctx.reply('Ocorreu um erro ao processar sua solicitação. Tente novamente.');
        }
    });
    
    bot.action('why_validate', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            
            const message = `❓ **Por que validar minha conta?**\n\n` +
                          `A validação é essencial para:\n\n` +
                          `🤖 **Anti\\-robô:** Confirma que você é uma pessoa real\n\n` +
                          `🛡️ **Segurança:** Protege contra fraudes e abusos\n\n` +
                          `📈 **Limites Progressivos:** Começa com R\\$ 50/dia e pode chegar até R\\$ 6\\.020/dia\n\n` +
                          `🔐 **Proteção de Identidade:** Apenas você poderá fazer transações com seu CPF/CNPJ\n\n` +
                          `💰 **Custo Único:** Apenas R\\$ 1,00 \\(você recebe 0,01 DEPIX de volta\\)\n\n` +
                          `⚡ **Processo Rápido:** Leva menos de 2 minutos\n\n` +
                          `Sem a validação, você não pode realizar transações no Bridge\\.`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('✅ Validar Agora', 'start_validation')],
                [Markup.button.callback('⬅️ Voltar', 'back_to_main_menu')]
            ]);
            
            await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            
        } catch (error) {
            logError('why_validate', error, ctx);
            await ctx.reply('Ocorreu um erro. Tente novamente.');
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
            
            const pingResult = await depixApiService.ping();
            if (!pingResult) {
                await ctx.editMessageText('❌ Erro ao conectar com a API DePix. Tente novamente mais tarde.');
                return;
            }
            
            // Criar depósito de R$ 1,00
            const webhookUrl = `${config.app.baseUrl}/webhooks/depix_payment`;
            let pixData;
            try {
                pixData = await depixApiService.generatePixForDeposit(100, liquidAddress, webhookUrl); // 100 centavos = R$ 1,00
            } catch (error) {
                await ctx.editMessageText('❌ Erro ao gerar QR Code. Tente novamente.');
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
                await ctx.editMessageText('❌ Erro ao criar transação de verificação. Tente novamente.');
                return;
            }
            
            // Enviar QR Code
            const qrMessage = await ctx.replyWithPhoto(
                pixData.qrImageUrl,
                {
                    caption: `🔐 **QR Code de Validação**\n\n` +
                            `💵 Valor: R\\$ 1,00\n` +
                            `🎁 Recompensa: 0,01 DEPIX\n` +
                            `⏱️ Válido por: 10 minutos\n\n` +
                            `**PIX Copia e Cola:**\n` +
                            `\`${escapeMarkdownV2(pixData.qrCopyPaste)}\`\n\n` +
                            `⚠️ **IMPORTANTE:** Este pagamento valida sua conta\\. ` +
                            `Após o pagamento, todos os QR Codes futuros só aceitarão pagamentos do mesmo CPF/CNPJ\\.`,
                    parse_mode: 'MarkdownV2'
                }
            );
            
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
            await ctx.reply('Ocorreu um erro ao gerar o QR Code de validação. Tente novamente.');
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
            const validationMessage = `🔐 **Validação de Conta**\n\n` +
                                     `Para começar a usar o Bridge, precisamos validar sua conta\\. Este processo serve para:\n\n` +
                                     `✅ Confirmar que você não é um robô\n` +
                                     `✅ Proteger contra abusos e fraudes\n` +
                                     `✅ Liberar limites progressivos de transação\n\n` +
                                     `Ao fazer o pagamento de R\\$ 1,00 você valida sua conta, receberá R\\$ 0,01 e desbloqueará o limite diário de 50 reais\\. Esse limite irá aumentando conforme você vai comprando\\.\n\n` +
                                     `Deseja continuar com a validação?`;
            
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
            const message = `✅ **QR Code cancelado com sucesso\!**\n\n` +
                          `Agora você pode gerar um novo QR Code quando desejar\\.`;
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💸 Gerar Novo Depósito', 'receive_pix_start')],
                [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
            ]);
            await ctx.reply(message, { parse_mode: 'MarkdownV2', ...keyboard });
            
        } catch (error) {
            logError('cancel_qr', error, ctx);
            await ctx.answerCbQuery('❌ Erro ao cancelar', true);
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
                } else if (upgradeCheck.message) {
                    nextLevelInfo = `\n📈 Próximo nível: ${escapeMarkdownV2(upgradeCheck.message)}`;
                }
            }
            
            const message = `📊 **Status da Conta**\n\n` +
                          `${statusEmoji} Status: **${statusText}**\n` +
                          `👤 Usuário: @${escapeMarkdownV2(userStatus.telegram_username || 'N/A')}\n` +
                          `✅ Conta Verificada: ${userStatus.is_verified ? 'Sim' : 'Não'}\n` +
                          `\n⭐ **Nível de Reputação:** ${userStatus.reputation_level}/10\n` +
                          (userStatus.level_description ? `_${escapeMarkdownV2(userStatus.level_description)}_\n` : '') +
                          `\n💰 **Limites:**\n` +
                          `  • Diário: R\\$ ${escapeMarkdownV2(String(userStatus.daily_limit_brl || '0.00'))}\n` +
                          `  • Usado hoje: R\\$ ${escapeMarkdownV2(String(userStatus.actual_daily_used || '0.00'))}\n` +
                          `  • Disponível: R\\$ ${escapeMarkdownV2(String(userStatus.available_today || '0.00'))}\n` +
                          (userStatus.max_per_transaction_brl ? 
                           `  • Máx\\. por transação: R\\$ ${escapeMarkdownV2(String(userStatus.max_per_transaction_brl))}\n` : '') +
                          (progressBar ? `\n📊 Progresso diário: \[${progressBar}\] ${Math.floor((userStatus.actual_daily_used / userStatus.daily_limit_brl) * 100)}%` : '') +
                          nextLevelInfo +
                          (userStatus.is_banned ? 
                           `\n\n🚫 **CONTA BANIDA**\n` +
                           `Motivo: ${escapeMarkdownV2(userStatus.ban_reason || 'Violação dos termos')}\n` +
                           `Entre em contato com o suporte: ${escapeMarkdownV2(config.links.supportContact)}` : '') +
                          (!userStatus.is_verified ? 
                           `\n\n⚠️ **Conta não validada**\n` +
                           `Use o botão "✅ Validar Conta" para começar\\.` : '');
            
            const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
            
            if (ctx.callbackQuery?.message) {
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            } else {
                await ctx.replyWithMarkdownV2(message, { reply_markup: keyboard.reply_markup });
            }
            
        } catch (error) {
            logError('user_status', error, ctx);
            await ctx.reply('Ocorreu um erro ao buscar seu status. Tente novamente.');
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