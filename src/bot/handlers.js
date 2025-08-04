const { Markup } = require('telegraf');
const config = require('../core/config');
const depixApiService = require('../services/depixApiService');
// CORREÇÃO: Importando a função do novo arquivo de utilitários.
const { escapeMarkdownV2 } = require('../utils/escapeMarkdown');

const isValidLiquidAddress = (address) => {
    if (!address || typeof address !== 'string') return false;
    const trimmedAddress = address.trim();
    const nonConfidentialMainnet = (trimmedAddress.startsWith('ex1') || trimmedAddress.startsWith('lq1'));
    const confidentialMainnet = (trimmedAddress.startsWith('VJL') || trimmedAddress.startsWith('VTj'));
    const currentLength = trimmedAddress.length;
    const isValidLength = currentLength > 40 && currentLength < 110; 
    const result = (nonConfidentialMainnet || confidentialMainnet) && isValidLength;
    console.log(`[isValidLiquidAddress] Input: "${address}", Result: ${result}`);
    return result;
};

let awaitingInputForUser = {}; 

const registerBotHandlers = (bot, dbPool, expectationMessageQueue, expirationQueue) => { 
    const logError = (handlerName, error, ctx) => {
        const userId = ctx?.from?.id || 'N/A';
        console.error(`Error in ${handlerName} for user ${userId}:`, error.message);
        if (error.response && error.on) { 
            console.error('TelegramError details:', JSON.stringify({ response: error.response, on: error.on }, null, 2));
        } else if (error.response && error.response.data) {
             console.error(`Axios Error Status: ${error.response.status}`);
             console.error('Axios Error Data:', JSON.stringify(error.response.data));
        } else if (error.stack) {
            console.error(error.stack);
        }
    };

    const mainMenuKeyboardObj = Markup.inlineKeyboard([
        [Markup.button.callback('💸 Receber Pix em DePix', 'receive_pix_start')],
        [Markup.button.callback('💼 Minha Carteira', 'my_wallet')],
        [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
        [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
    ]);

    const sendMainMenu = async (ctx, messageText = 'O que você gostaria de fazer hoje?') => {
        try {
            if (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.message_id) {
                await ctx.editMessageText(messageText, { reply_markup: mainMenuKeyboardObj.reply_markup });
            } else {
                await ctx.reply(messageText, mainMenuKeyboardObj);
            }
        } catch (error) {
            logError('sendMainMenu/editOrReply', error, ctx);
            await ctx.reply(messageText, mainMenuKeyboardObj);
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
        console.log(`User ${telegramUserId} (${telegramUsername}) started the bot.`);
        try {
            const { rows } = await dbPool.query('SELECT liquid_address, telegram_username FROM users WHERE telegram_user_id = $1', [telegramUserId]);
            if (rows.length > 0 && rows[0].liquid_address && rows[0].liquid_address.trim() !== '') {
                await sendMainMenu(ctx, 'Bem-vindo de volta! O que você gostaria de fazer hoje?');
            } else {
                const initialMessage = `Olá\\! Bem\\-vindo ao **Bridge Bot** da Atlas\\. 🚀\nCom o Bridge Bot, você pode:\n\n\\- 💰 **Receber pagamentos Pix** de clientes diretamente em sua carteira DePix \\(BRL digital soberano\\)\\.\n\nPara receber seus DePix, precisamos saber o endereço da sua carteira Liquid\\. Você já tem uma?`;
                await ctx.replyWithMarkdownV2(initialMessage, initialConfigKeyboardObj);
                if (rows.length === 0) {
                    await dbPool.query('INSERT INTO users (telegram_user_id, telegram_username) VALUES ($1, $2) ON CONFLICT (telegram_user_id) DO NOTHING', [telegramUserId, telegramUsername]);
                    console.log(`User ${telegramUserId} (${telegramUsername}) newly registered in DB (no address yet).`);
                } else if ((rows[0] && !rows[0].telegram_username && telegramUsername !== 'N/A') || (rows[0] && rows[0].telegram_username !== telegramUsername)) { 
                    await dbPool.query('UPDATE users SET telegram_username = $1, updated_at = NOW() WHERE telegram_user_id = $2', [telegramUsername, telegramUserId]);
                    console.log(`User ${telegramUserId} username updated to ${telegramUsername}.`);
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
            let sentMessage;
            if (ctx.callbackQuery && ctx.callbackQuery.message) {
                sentMessage = await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' });
            } else { 
                sentMessage = await ctx.replyWithMarkdownV2(message); 
            }
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
            if (ctx.callbackQuery && ctx.callbackQuery.message) {
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup, disable_web_page_preview: true });
            } else { await ctx.replyWithMarkdownV2(message, keyboard); }
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
            if (ctx.callbackQuery && ctx.callbackQuery.message) {
                await ctx.editMessageText(messageText, { reply_markup: initialConfigKeyboardObj.reply_markup });
            } else { await ctx.reply(messageText, initialConfigKeyboardObj); }
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
        console.log(`Text input: "${text}", UserState: ${JSON.stringify(userState)}, User: ${telegramUserId}`);

        if (userState && userState.type === 'amount') {
            const amount = parseFloat(text.replace(',', '.')); 
            if (!isNaN(amount) && amount >= 1 && amount <= 5000) {
                console.log(`Received amount ${amount} for deposit from user ${telegramUserId}`);
                let messageIdToUpdate = userState.messageIdToEdit;

                try {
                    if (messageIdToUpdate) {
                        await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Verificando status do serviço DePix, um momento...');
                    } else { 
                        const sentMsg = await ctx.reply('Verificando status do serviço DePix, um momento...');
                        messageIdToUpdate = sentMsg.message_id;
                    }
                    
                    if (!await depixApiService.ping()) { clearUserState(telegramUserId); await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'O serviço DePix parece estar instável. Tente novamente mais tarde.'); return; }
                                        
                    const userResult = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_user_id = $1', [telegramUserId]);
                    if (!userResult.rows.length || !userResult.rows[0].liquid_address) { 
                        clearUserState(telegramUserId);
                        await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Sua carteira Liquid não foi encontrada. Use /start para configurar.');
                        return; 
                    }
                    
                    const userLiquidAddress = userResult.rows[0].liquid_address;
                    const amountInCents = Math.round(amount * 100);

                    await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, 'Gerando seu QR Code Pix, aguarde um momento...');

                    const pixData = await depixApiService.generatePixForDeposit(amountInCents, userLiquidAddress);
                    const { qrCopyPaste, qrImageUrl, id: depixApiEntryId } = pixData;
                    const requestedBrlAmount = amount; 
                    const depixAmountExpected = (amount - 0.99).toFixed(2);

                    const dbResult = await dbPool.query( 'INSERT INTO pix_transactions (user_id, requested_brl_amount, depix_amount_expected, pix_qr_code_payload, payment_status, depix_api_entry_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING transaction_id', [telegramUserId, requestedBrlAmount, parseFloat(depixAmountExpected), qrCopyPaste, 'PENDING', depixApiEntryId]);
                    const internalTxId = dbResult.rows[0].transaction_id;
                    console.log(`Transaction ${internalTxId} for BRL ${requestedBrlAmount.toFixed(2)} saved. DePix API ID: ${depixApiEntryId}`);

                    const reminderJobId = `expectation-${depixApiEntryId}`;
                    await expectationMessageQueue.add(reminderJobId, { telegramUserId, depixApiEntryId, supportContact: escapeMarkdownV2(config.links.supportContact) }, { delay: 70 * 1000, removeOnComplete: true, removeOnFail: 5, jobId: reminderJobId });
                    
                    const expirationJobId = `expiration-${depixApiEntryId}`;
                    const THIRTY_MINUTES_IN_MS = 30 * 60 * 1000;
                    await expirationQueue.add(expirationJobId, { telegramUserId, depixApiEntryId, requestedBrlAmount }, { delay: THIRTY_MINUTES_IN_MS, removeOnComplete: true, removeOnFail: 5, jobId: expirationJobId });
                    console.log(`Jobs added: Reminder (${reminderJobId}) and Expiration (${expirationJobId}) for user ${telegramUserId}`);

                    let caption = `Pronto\\! Apresente este QRCode Pix ou o código abaixo para o pagador:\n\n`;
                    caption += `Código Pix Copia e Cola:\n\`${escapeMarkdownV2(qrCopyPaste)}\`\n\n`; 
                    caption += `Você receberá aproximadamente \`${depixAmountExpected}\` DePix \\(reais\\) diretamente em sua carteira Liquid assim que o pagamento for confirmado\\. Avisaremos você\\.`;
                    
                    await ctx.telegram.deleteMessage(ctx.chat.id, messageIdToUpdate);
                    const qrPhotoMessage = await ctx.replyWithPhoto(qrImageUrl, { caption: caption, parse_mode: 'MarkdownV2' });

                    await dbPool.query('UPDATE pix_transactions SET qr_code_message_id = $1 WHERE transaction_id = $2', [qrPhotoMessage.message_id, internalTxId]);

                    clearUserState(telegramUserId);

                } catch (apiError) { 
                    clearUserState(telegramUserId); 
                    logError('generate_pix_api_call_or_ping', apiError, ctx); 
                    const errorReply = `Desculpe, ocorreu um problema ao gerar o QR Code: ${apiError.message}`;
                    if (messageIdToUpdate) { await ctx.telegram.editMessageText(ctx.chat.id, messageIdToUpdate, undefined, errorReply); }
                    else { await ctx.reply(errorReply); }
                }
            } else { 
                let eMessage = `Valor inválido ou fora dos limites: \`${escapeMarkdownV2(text)}\`\\. `
                eMessage += `Por favor, envie um valor entre R\\$ 1\\.00 e R\\$ 5000\\.00 \\(ex: \`50.21\`\\)\\.`;
                if (amount > 5000) { eMessage += `\nPara valores maiores que R\\$ 5000\\.00, contate o suporte: ${escapeMarkdownV2(config.links.supportContact)}`; }
                await ctx.replyWithMarkdownV2(eMessage);
            }
        } else if (userState && (userState.type === 'liquid_address_initial' || userState.type === 'liquid_address_change')) {
            if (isValidLiquidAddress(text)) {
                try {
                    await dbPool.query('INSERT INTO users (telegram_user_id, telegram_username, liquid_address, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_user_id) DO UPDATE SET liquid_address = EXCLUDED.liquid_address, telegram_username = EXCLUDED.telegram_username, updated_at = NOW()', [telegramUserId, telegramUsername, text]);
                    console.log(`User ${telegramUserId} associated/updated Liquid address: ${text}`);
                    const successMessage = 'Endereço Liquid associado com sucesso!';
                    if (userState.messageIdToEdit) { await ctx.telegram.editMessageText(ctx.chat.id, userState.messageIdToEdit, undefined, successMessage); }
                    else { await ctx.reply(successMessage); }
                    clearUserState(telegramUserId); 
                    await sendMainMenu(ctx);
                } catch (error) { 
                    logError('text_handler (save_address)', error, ctx); 
                    await ctx.reply('Ocorreu um erro ao salvar seu endereço Liquid. Tente novamente.');
                }
            } else { 
                const invalidAddressMessage = `O endereço fornecido não parece ser uma carteira Liquid válida\\. \nVerifique o formato \\(deve começar com \`ex1\`, \`lq1\`, \`VJL\` ou \`VTj\`\\) e tente novamente\\. \n\nOu, se precisar de ajuda para criar uma:`;
                await ctx.replyWithMarkdownV2(invalidAddressMessage, Markup.inlineKeyboard([[Markup.button.callback('❌ Preciso de Ajuda com Carteira', 'explain_liquid_wallet')]]));
            }
        } else {
            console.log(`[INFO] Unhandled text from user ${telegramUserId} ("${text.substring(0,20)}...") in state: ${JSON.stringify(userState)}`);
        }
    });

    bot.action('receive_pix_start', async (ctx) => {
        try {
            clearUserState(ctx.from.id);
            await ctx.answerCbQuery();
            const { rows } = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_user_id = $1', [ctx.from.id]);
            if (!rows.length || !rows[0].liquid_address || rows[0].liquid_address.trim() === '') {
                const message = "Você precisa associar uma carteira Liquid primeiro\\! Use o botão abaixo ou o comando /start para reconfigurar\\.";
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('✅ Associar Minha Carteira Liquid', 'ask_liquid_address')]]);
                if (ctx.callbackQuery && ctx.callbackQuery.message) { await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }); }
                else { await ctx.replyWithMarkdownV2(message, keyboard); }
                return;
            }
            const amountRequestMessage = `Qual o valor em reais que você deseja receber via Pix? \\(Ex: \`50.21\`\\)\n\nLembre\\-se:\n\\- O valor deve ser entre R\\$ 1\\.00 e R\\$ 5000\\.00\\.\n\\- Para valores maiores, contate o suporte: ${escapeMarkdownV2(config.links.supportContact)}\\.\n\\- Há uma taxa de R\\$0,99 pela transação\\.`;
            let sentMessage;
            if (ctx.callbackQuery && ctx.callbackQuery.message) { sentMessage = await ctx.editMessageText(amountRequestMessage, { parse_mode: 'MarkdownV2' }); }
            else { sentMessage = await ctx.replyWithMarkdownV2(amountRequestMessage); }
            awaitingInputForUser[ctx.from.id] = { type: 'amount', messageIdToEdit: sentMessage?.message_id || null };
        } catch (error) { 
            logError('receive_pix_start', error, ctx); 
            await ctx.reply("Ocorreu um erro. Tente o menu /start.");
        }
    });

    bot.action('my_wallet', async (ctx) => {
        clearUserState(ctx.from.id); 
        const telegramUserId = ctx.from.id;
        try {
            await ctx.answerCbQuery();
            const { rows } = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_user_id = $1', [telegramUserId]);
            if (rows.length > 0 && rows[0].liquid_address && rows[0].liquid_address.trim() !== '') {
                const message = `**Minha Carteira Liquid Associada**\n\nSeu endereço para receber DePix é:\n\`${escapeMarkdownV2(rows[0].liquid_address)}\`\n\n*Lembre\\-se: Você tem total controle sobre esta carteira\\. O Bridge Bot apenas envia DePix para este endereço\\.*`;
                const keyboard = Markup.inlineKeyboard([
                       [Markup.button.callback('🔄 Alterar Carteira', 'change_wallet_start')],
                       [Markup.button.callback('📜 Histórico de Transações', 'transaction_history:0')],
                       [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
                if (ctx.callbackQuery && ctx.callbackQuery.message) { await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup }); }
                else { await ctx.replyWithMarkdownV2(message, keyboard); }
            } else { 
                const message = 'Você ainda não associou uma carteira Liquid\\. Configure uma primeiro usando o botão abaixo ou o comando /start\\.';
                const keyboard = Markup.inlineKeyboard([[Markup.button.callback('✅ Associar Carteira Liquid', 'ask_liquid_address')]]);
                if (ctx.callbackQuery && ctx.callbackQuery.message) { await ctx.editMessageText(message, {parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup});}
                else { await ctx.replyWithMarkdownV2(message, keyboard);}
            }
        } catch (error) { 
            logError('my_wallet', error, ctx); 
            if (ctx.callbackQuery && ctx.callbackQuery.message && error.message && !error.message.includes("message is not modified")){ await ctx.reply('Ocorreu um erro ao buscar sua carteira.');}
        }
    });

    bot.action('change_wallet_start', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const message = 'OK\\! Por favor, envie seu **novo endereço público da carteira Liquid**\\.';
            let sentMessage;
            if (ctx.callbackQuery && ctx.callbackQuery.message) { sentMessage = await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' });}
            else { sentMessage = await ctx.replyWithMarkdownV2(message); }
            awaitingInputForUser[ctx.from.id] = { type: 'liquid_address_change', messageIdToEdit: sentMessage?.message_id || null };
        } catch (error) { 
            logError('change_wallet_start', error, ctx); 
            await ctx.reply('Ocorreu um erro. Tente novamente.');
        }
    });
    
    const TRANSACTIONS_PER_PAGE = 5;
    bot.action(/^transaction_history(?::(\d+))?$/, async (ctx) => {
        clearUserState(ctx.from.id);
        const telegramUserId = ctx.from.id;
        const page = ctx.match[1] ? parseInt(ctx.match[1], 10) : 0;
        const offset = page * TRANSACTIONS_PER_PAGE;

        try {
            await ctx.answerCbQuery();
            const { rows: transactions } = await dbPool.query( `SELECT transaction_id, requested_brl_amount, payment_status, depix_txid, created_at FROM pix_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [telegramUserId, TRANSACTIONS_PER_PAGE, offset]);
            const { rows: countResult } = await dbPool.query( 'SELECT COUNT(*) AS total FROM pix_transactions WHERE user_id = $1', [telegramUserId]);
            const totalTransactions = parseInt(countResult[0].total, 10);
            const totalPages = Math.ceil(totalTransactions / TRANSACTIONS_PER_PAGE);

            let message = `**Seu Histórico de Transações \\(Pix \\-\\> DePix\\)**\n\n`;
            if (transactions.length === 0) {
                message += 'Nenhuma transação encontrada\\. Comece recebendo um Pix\\!';
            } else {
                transactions.forEach(tx => {
                    const date = escapeMarkdownV2(new Date(tx.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }));
                    const statusEmoji = tx.payment_status === 'PAID' ? '✅' : (tx.payment_status === 'PENDING' ? '⏳' : (tx.payment_status === 'EXPIRED' ? '⏰' : '❌'));
                    message += `${statusEmoji} *${date}*\n`;
                    message += `   Valor: R\\$ ${escapeMarkdownV2(Number(tx.requested_brl_amount).toFixed(2))}\n`;
                    message += `   Status: ${escapeMarkdownV2(tx.payment_status)}\n`;
                    if (tx.depix_txid) { message += `   Liquid TXID: \`${escapeMarkdownV2(tx.depix_txid.substring(0,10))}...\`\n`; }
                    message += `   ID Interno: \`${escapeMarkdownV2(tx.transaction_id.substring(0,8))}\`\n\n`;
                });
            }

            const paginationButtons = [];
            if (page > 0) { paginationButtons.push(Markup.button.callback('⬅️ Anterior', `transaction_history:${page - 1}`)); }
            if (page < totalPages - 1) { paginationButtons.push(Markup.button.callback('Próxima ➡️', `transaction_history:${page + 1}`)); }

            const keyboardButtons = [];
            if (paginationButtons.length > 0) keyboardButtons.push(paginationButtons);
            keyboardButtons.push([Markup.button.callback('⬅️ Voltar para Carteira', 'my_wallet')]);

            if (ctx.callbackQuery && ctx.callbackQuery.message) {
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: Markup.inlineKeyboard(keyboardButtons).reply_markup, disable_web_page_preview: true });
            } else { await ctx.replyWithMarkdownV2(message, Markup.inlineKeyboard(keyboardButtons)); }
        } catch (error) { 
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
            const supportContactEscaped = escapeMarkdownV2(config.links.supportContact);
            const githubRepoLinkEscaped = escapeMarkdownV2(config.links.githubRepo);
            const donationAddress = "VJLBCUaw6GL8AuyjsrwpwTYNCUfUxPVTfxxffNTEZMKEjSwamWL6YqUUWLvz89ts1scTDKYoTF8oruMX";
            const donationAddressEscaped = escapeMarkdownV2(donationAddress);

            const aboutMessage = `O **Bridge Bot da Atlas** conecta o Pix brasileiro ao DePix \\(um Real digital soberano e privado\\)\\. \nEstamos em constante desenvolvimento e buscamos construir uma comunidade resiliente\\.\n\n\\- **Soberania Total:** Com o Bridge, você tem controle exclusivo sobre suas chaves e seus fundos DePix, pois tudo é enviado diretamente para sua carteira Liquid\\.\n\\- **Receba Pix em DePix:** Converta pagamentos Pix em DePix \\(pareado 1:1 com o BRL\\), com a flexibilidade de convertê\\-lo para Bitcoin \\(L\\-BTC\\) quando desejar usando sua carteira Liquid compatível\\.\n\\- **Tecnologia:** Usamos a robusta Liquid Network \\(uma sidechain do Bitcoin\\) para DePix\\. Nosso código é aberto e auditável\\.\n\\- **Taxas Atuais \\(MVP v0\\.0\\.1\\):**\n  A Atlas DAO não cobra taxas adicionais\\. O único custo é a taxa fixa de **R$0,99 por transação** para o serviço de conversão Pix para DePix \\(este é o custo da API DePix que é repassado\\)\\.\n\nPara mais detalhes técnicos ou para ver nosso código, visite nosso GitHub: ${githubRepoLinkEscaped}\n\n` +
                               `A Atlas DAO é uma Organização Autônoma Descentralizada\\. Doações são o principal meio de financiamento do desenvolvimento e nos ajudam a cobrir os custos para manter o serviço no ar\\.\nEndereço Liquid para doações em DePix ou L\\-BTC:\n\`${donationAddressEscaped}\`\n\nContate o suporte em: ${supportContactEscaped}`;
            const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]]);
            if (ctx.callbackQuery && ctx.callbackQuery.message) { await ctx.editMessageText(aboutMessage, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup, disable_web_page_preview: true });}
            else { await ctx.replyWithMarkdownV2(aboutMessage, keyboard); }
        } catch (error) { 
            logError('about_bridge', error, ctx); 
            await ctx.replyWithMarkdownV2('Ocorreu um erro ao mostrar as informações\\. Tente o menu /start\\.');
        }
    });

    bot.catch((err, ctx) => { 
        logError('Global Telegraf bot.catch', err, ctx);
        if (ctx && err.message && (err.message.includes("query is too old") || err.message.includes("message is not modified"))) {
            return; 
        }
        if (ctx && ctx.chat && ctx.chat.id) {
            try {
                 ctx.telegram.sendMessage(ctx.chat.id, 'Desculpe, ocorreu um erro inesperado. Por favor, tente o comando /start novamente ou contate o suporte.');
            } catch (replyError) {
                logError('Global bot.catch sendMessage fallback', replyError, ctx);
            }
        }
    });
    console.log('Bot handlers registered.');
};

module.exports = { registerBotHandlers }; // Não exportamos mais o escapeMarkdownV2 daqui