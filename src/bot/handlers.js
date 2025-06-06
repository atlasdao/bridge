const { Markup } = require('telegraf');
const config = require('../core/config');
const depixApiService = require('../services/depixApiService');

const escapeMarkdownV2 = (text) => {
    if (typeof text !== 'string') return '';
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
};
module.exports.escapeMarkdownV2 = escapeMarkdownV2;

const isValidLiquidAddress = (address) => {
    if (!address || typeof address !== 'string') return false;
    const trimmedAddress = address.trim();
    const nonConfidentialMainnet = (trimmedAddress.startsWith('ex1') || trimmedAddress.startsWith('lq1'));
    const confidentialMainnet = (trimmedAddress.startsWith('VJL') || trimmedAddress.startsWith('VTj'));
    const currentLength = trimmedAddress.length;
    const isValidLength = currentLength > 40 && currentLength < 110; 
    const result = (nonConfidentialMainnet || confidentialMainnet) && isValidLength;
    // console.log(`[isValidLiquidAddress] Validation for "${trimmedAddress.substring(0,30)}...": ${result} (PrefixOK: ${nonConfidentialMainnet || confidentialMainnet}, LengthOK: ${isValidLength}, Length: ${currentLength})`);
    return result;
};

let awaitingInputForUser = {}; 

const registerBotHandlers = (bot, dbPool, expectationMessageQueue) => { 
    const logError = (handlerName, error, ctx) => {
        const userId = ctx?.from?.id || 'N/A';
        console.error(`Error in ${handlerName} for user ${userId}:`, error.message);
        if (error.response && error.on) {
            console.error('TelegramError details:', JSON.stringify({ response: error.response, on: error.on }, null, 2));
        } else if (error.response) { 
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
            if (ctx.callbackQuery && ctx.callbackQuery.message) {
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

    const clearUserState = (userId) => { delete awaitingInputForUser[userId]; };
    
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
                } else if ((rows.length > 0 && !rows[0].telegram_username && telegramUsername !== 'N/A') || (rows.length > 0 && rows[0].telegram_username !== telegramUsername)) { 
                    await dbPool.query('UPDATE users SET telegram_username = $1, updated_at = NOW() WHERE telegram_user_id = $2', [telegramUsername, telegramUserId]);
                    console.log(`User ${telegramUserId} username updated to ${telegramUsername}.`);
                }
            }
        } catch (error) { logError('/start', error, ctx); /* ... fallback ... */ }
    });

    bot.action('ask_liquid_address', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            awaitingInputForUser[ctx.from.id] = { type: 'liquid_address_initial' };
            await ctx.answerCbQuery();
            const message = 'Por favor, digite ou cole o **endereço público da sua carteira Liquid** onde você deseja receber seus DePix\\.';
            if (ctx.callbackQuery && ctx.callbackQuery.message) {
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' });
            } else { await ctx.replyWithMarkdownV2(message); }
        } catch (error) { logError('ask_liquid_address', error, ctx); /* ... fallback ... */ }
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
                await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });
            } else { await ctx.replyWithMarkdownV2(message, keyboard); }
        } catch (error) { logError('explain_liquid_wallet', error, ctx); /* ... fallback ... */ }
    });

    bot.action('back_to_start_config', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            await ctx.answerCbQuery();
            const messageText = `Para receber seus DePix, precisamos saber o endereço da sua carteira Liquid. Você já tem uma?`;
            if (ctx.callbackQuery && ctx.callbackQuery.message) {
                await ctx.editMessageText(messageText, { reply_markup: initialConfigKeyboardObj.reply_markup });
            } else { await ctx.reply(messageText, initialConfigKeyboardObj); }
        } catch (error) { logError('back_to_start_config', error, ctx); /* ... fallback ... */ }
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
                let loadingMessage;
                try {
                    if (userState.messageIdToEdit) {
                        await ctx.telegram.editMessageText(ctx.chat.id, userState.messageIdToEdit, undefined, 'Verificando status do serviço DePix, um momento...');
                    } else { loadingMessage = await ctx.reply('Verificando status do serviço DePix, um momento...'); }
                    
                    const isDePixHealthy = await depixApiService.ping();
                    if (!isDePixHealthy) { clearUserState(telegramUserId); await ctx.reply('O serviço DePix parece estar instável ou indisponível no momento. Por favor, tente novamente mais tarde.'); return; }
                    
                    clearUserState(telegramUserId); 

                    const userResult = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_user_id = $1', [telegramUserId]);
                    if (!userResult.rows.length || !userResult.rows[0].liquid_address || userResult.rows[0].liquid_address.trim() === '') { await ctx.replyWithMarkdownV2('Não consegui encontrar sua carteira Liquid associada\\. Por favor, use o comando /start para configurar novamente\\.'); return; }
                    
                    const userLiquidAddress = userResult.rows[0].liquid_address;
                    const amountInCents = Math.round(amount * 100);

                    if (userState.messageIdToEdit) { await ctx.telegram.editMessageText(ctx.chat.id, userState.messageIdToEdit, undefined, 'Gerando seu QR Code Pix, aguarde um momento...'); }
                    else if (loadingMessage) { await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, undefined, 'Gerando seu QR Code Pix, aguarde um momento...');}
                    else { await ctx.reply('Gerando seu QR Code Pix, aguarde um momento...');  }

                    const pixData = await depixApiService.generatePixForDeposit(amountInCents, userLiquidAddress);
                    const { qrCopyPaste, qrImageUrl, id: depixApiEntryId } = pixData;
                    const requestedBrlAmount = amount; 
                    const depixAmountExpected = (amount - 0.99).toFixed(2);

                    const dbResult = await dbPool.query( 'INSERT INTO pix_transactions (user_id, requested_brl_amount, depix_amount_expected, pix_qr_code_payload, payment_status, depix_api_entry_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING transaction_id', [telegramUserId, requestedBrlAmount, parseFloat(depixAmountExpected), qrCopyPaste, 'PENDING', depixApiEntryId]);
                    const internalTxId = dbResult.rows[0].transaction_id;
                    console.log(`Transaction ${internalTxId} for BRL ${requestedBrlAmount.toFixed(2)} saved. DePix API ID: ${depixApiEntryId}`);

                    const jobId = `expectation-${depixApiEntryId}`;
                    await expectationMessageQueue.add(jobId, { telegramUserId, depixApiEntryId, supportContact: config.links.supportContact }, { delay: 70 * 1000, removeOnComplete: true, removeOnFail: 5, jobId: jobId });
                    console.log(`Job ${jobId} added for user ${telegramUserId}`);

                    let caption = `Pronto\\! Apresente este QRCode Pix ou o código abaixo para o pagador:\n\n`;
                    caption += `Código Pix Copia e Cola:\n\`${escapeMarkdownV2(qrCopyPaste)}\`\n\n`; 
                    caption += `Você receberá aproximadamente \`${depixAmountExpected}\` DePix \\(reais\\) diretamente em sua carteira Liquid assim que o pagamento for confirmado\\. Avisaremos você\\.`;
                    await ctx.replyWithPhoto(qrImageUrl, { caption: caption, parse_mode: 'MarkdownV2' });

                } catch (apiError) { clearUserState(telegramUserId); logError('generate_pix_api_call_or_ping', apiError, ctx); await ctx.reply(`Desculpe, ocorreu um problema ao gerar o QR Code: ${apiError.message}`); }
            } else { /* ... (mensagem de valor inválido) ... */ }
        } else if (userState && (userState.type === 'liquid_address_initial' || userState.type === 'liquid_address_change')) {
            if (isValidLiquidAddress(text)) {
                try {
                    await dbPool.query('INSERT INTO users (telegram_user_id, telegram_username, liquid_address, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_user_id) DO UPDATE SET liquid_address = EXCLUDED.liquid_address, telegram_username = EXCLUDED.telegram_username, updated_at = NOW()', [telegramUserId, telegramUsername, text]);
                    clearUserState(telegramUserId); 
                    console.log(`User ${telegramUserId} associated/updated Liquid address: ${text}`);
                    const successMessage = 'Endereço Liquid associado com sucesso!';
                    if (userState.messageIdToEdit) { await ctx.telegram.editMessageText(ctx.chat.id, userState.messageIdToEdit, undefined, successMessage); }
                    else { await ctx.reply(successMessage); }
                    await sendMainMenu(ctx);
                } catch (error) { logError('text_handler (save_address)', error, ctx); /* ... fallback ... */ }
            } else { /* ... (mensagem de endereço inválido) ... */ }
        } else { /* ... (log de texto não manipulado) ... */ }
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
        } catch (error) { logError('receive_pix_start', error, ctx); /* ... fallback ... */ }
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
            } else { /* ... (carteira não associada) ... */ }
        } catch (error) { logError('my_wallet', error, ctx); /* ... fallback ... */ }
    });

    bot.action('change_wallet_start', async (ctx) => {
        try {
            await ctx.answerCbQuery();
            const message = 'OK\\! Por favor, envie seu **novo endereço público da carteira Liquid**\\.';
            let sentMessage;
            if (ctx.callbackQuery && ctx.callbackQuery.message) { sentMessage = await ctx.editMessageText(message, { parse_mode: 'MarkdownV2' });}
            else { sentMessage = await ctx.replyWithMarkdownV2(message); }
            awaitingInputForUser[ctx.from.id] = { type: 'liquid_address_change', messageIdToEdit: sentMessage?.message_id || null };
        } catch (error) { logError('change_wallet_start', error, ctx); /* ... fallback ... */ }
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

            // CORREÇÃO AQUI: Escapar o título
            let message = `**Seu Histórico de Transações \\(Pix \\-\\> DePix\\)**\n\n`;
            if (transactions.length === 0) {
                message += 'Nenhuma transação encontrada\\. Comece recebendo um Pix\\!';
            } else {
                transactions.forEach(tx => {
                    // Formatar data e escapar para MarkdownV2
                    const date = escapeMarkdownV2(new Date(tx.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Sao_Paulo' }));
                    const statusEmoji = tx.payment_status === 'PAID' ? '✅' : (tx.payment_status === 'PENDING' ? '⏳' : '❌');
                    
                    message += `${statusEmoji} *${date}*\n`; // Data já escapada, não precisa de mais escapes aqui se for só texto
                    message += `   Valor: R\\$ ${escapeMarkdownV2(Number(tx.requested_brl_amount).toFixed(2))}\n`;
                    message += `   Status: ${escapeMarkdownV2(tx.payment_status)}\n`;
                    if (tx.depix_txid) {
                        message += `   Liquid TXID: \`${escapeMarkdownV2(tx.depix_txid.substring(0,10))}...\`\n`; // Conteúdo de ` ` não é interpretado
                    }
                    message += `   ID Interno: \`${escapeMarkdownV2(tx.transaction_id.substring(0,8))}\`\n\n`; // Conteúdo de ` ` não é interpretado
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
        } catch (error) { logError('transaction_history', error, ctx); /* ... fallback ... */ }
    });
    
    bot.action('back_to_main_menu', async (ctx) => {
        try {
            clearUserState(ctx.from.id); 
            await ctx.answerCbQuery();
            await sendMainMenu(ctx);
        } catch (error) { logError('back_to_main_menu', error, ctx); /* ... fallback ... */ }
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
            if (ctx.callbackQuery && ctx.callbackQuery.message) { await ctx.editMessageText(aboutMessage, { parse_mode: 'MarkdownV2', reply_markup: keyboard.reply_markup });}
            else { await ctx.replyWithMarkdownV2(aboutMessage, keyboard); }
        } catch (error) { logError('about_bridge', error, ctx); /* ... fallback ... */ }
    });

    bot.catch((err, ctx) => { /* ... (código existente) ... */ });
    console.log('Bot handlers registered.');
};

module.exports = { registerBotHandlers, escapeMarkdownV2 };
