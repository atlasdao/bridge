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
    // console.log(`[isValidLiquidAddress] Final result for "${trimmedAddress.substring(0,30)}...": ${result} (PrefixOK: ${nonConfidentialMainnet || confidentialMainnet}, LengthOK: ${isValidLength}, Length: ${currentLength})`);
    return result;
};

let awaitingAmountForUser = null; 

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

    const mainMenuKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💸 Receber Pix em DePix', 'receive_pix_start')],
        [Markup.button.callback('💼 Minha Carteira', 'my_wallet')],
        [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')],
        [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
    ]);

    bot.start(async (ctx) => {
        awaitingAmountForUser = null; 
        const telegramUserId = ctx.from.id;
        const telegramUsername = ctx.from.username || 'N/A';
        console.log(`User ${telegramUserId} (${telegramUsername}) started the bot.`);
        try {
            const { rows } = await dbPool.query('SELECT liquid_address, telegram_username FROM users WHERE telegram_user_id = $1', [telegramUserId]);
            if (rows.length > 0 && rows[0].liquid_address && rows[0].liquid_address.trim() !== '') {
                await ctx.reply('Bem-vindo de volta! O que você gostaria de fazer hoje?', mainMenuKeyboard);
            } else {
                const initialMessage = `Olá\\! Bem\\-vindo ao **Bridge Bot** da Atlas\\. 🚀\nCom o Bridge Bot, você pode:\n\n\\- 💰 **Receber pagamentos Pix** de clientes diretamente em sua carteira DePix \\(BRL digital soberano\\)\\.\n\nPara receber seus DePix, precisamos saber o endereço da sua carteira Liquid\\. Você já tem uma?`;
                await ctx.replyWithMarkdownV2(initialMessage, Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Já tenho uma carteira Liquid', 'ask_liquid_address')],
                    [Markup.button.callback('❌ Ainda não tenho uma carteira Liquid', 'explain_liquid_wallet')],
                    [Markup.button.callback('ℹ️ Sobre o Bridge', 'about_bridge')], // Botão "Sobre" aqui também
                    [Markup.button.url('💬 Comunidade Atlas', config.links.communityGroup)]
                ]));
                if (rows.length === 0) {
                    await dbPool.query('INSERT INTO users (telegram_user_id, telegram_username) VALUES ($1, $2) ON CONFLICT (telegram_user_id) DO NOTHING', [telegramUserId, telegramUsername]);
                    console.log(`User ${telegramUserId} (${telegramUsername}) newly registered in DB (no address yet).`);
                } else if ((rows.length > 0 && !rows[0].telegram_username && telegramUsername !== 'N/A') || (rows.length > 0 && rows[0].telegram_username !== telegramUsername)) { 
                    await dbPool.query('UPDATE users SET telegram_username = $1, updated_at = NOW() WHERE telegram_user_id = $2', [telegramUsername, telegramUserId]);
                    console.log(`User ${telegramUserId} username updated to ${telegramUsername}.`);
                }
            }
        } catch (error) { /* ... (código de erro existente) ... */ }
    });

    bot.action('ask_liquid_address', async (ctx) => { /* ... (código existente) ... */ });
    bot.action('explain_liquid_wallet', async (ctx) => { /* ... (código existente) ... */ });
    bot.action('back_to_start_config', async (ctx) => { /* ... (código existente) ... */ });

    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim(); 
        const telegramUserId = ctx.from.id;
        // ... (resto do handler de texto, incluindo a parte de salvar endereço)
        // Após salvar o endereço com sucesso:
        if (isAddressValid) { 
            try {
                // ... (query de salvar/update) ...
                console.log(`User ${telegramUserId} associated/updated Liquid address: ${text}`);
                await ctx.reply('Endereço Liquid associado com sucesso! Seus DePix serão enviados diretamente para este endereço.', mainMenuKeyboard); // USA mainMenuKeyboard
            } catch (error) { /* ... */ }
        } else {
             // ... (lógica de input inválido)
            const invalidInputMessage = 
                `O texto fornecido não parece ser uma carteira Liquid válida nem um valor que eu esperava\\. \n`+
                `Verifique o formato da carteira \\(deve começar com \`ex1\`, \`lq1\`, \`VJL\` ou \`VTj\` e ter o comprimento correto\\) ou o valor numérico e tente novamente\\. \n\n` +
                `Se precisar de ajuda, clique abaixo ou contate o suporte\\.`;
            await ctx.replyWithMarkdownV2(invalidInputMessage, Markup.inlineKeyboard([ // BOTÕES ADICIONADOS AQUI
                [Markup.button.callback('Tentar Inserir Carteira Novamente', 'ask_liquid_address')],
                [Markup.button.callback('❌ Preciso de Ajuda com Carteira', 'explain_liquid_wallet')] 
            ]));
        }
    });

    bot.action('receive_pix_start', async (ctx) => { /* ... (código existente) ... */ });

    bot.action('my_wallet', async (ctx) => {
        awaitingAmountForUser = null; 
        const telegramUserId = ctx.from.id;
        try {
            await ctx.answerCbQuery();
            const { rows } = await dbPool.query('SELECT liquid_address FROM users WHERE telegram_user_id = $1', [telegramUserId]);
            if (rows.length > 0 && rows[0].liquid_address && rows[0].liquid_address.trim() !== '') {
                const message = `**Minha Carteira Liquid Associada**\n\nSeu endereço para receber DePix é:\n\`${escapeMarkdownV2(rows[0].liquid_address)}\`\n\n*Lembre\\-se: Você tem total controle sobre esta carteira\\. O Bridge Bot apenas envia DePix para este endereço\\.*`;
                // Usar editMessageText para atualizar a mensagem existente
                await ctx.editMessageText(message, {
                    parse_mode: 'MarkdownV2',
                    reply_markup: Markup.inlineKeyboard([
                       [Markup.button.callback('🔄 Alterar Carteira', 'change_wallet_start')],
                       [Markup.button.callback('📜 Histórico de Transações', 'transaction_history:0')],
                       [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
                    ]).reply_markup
                });
            } else { // ... (código existente) ... }
            }
        } catch (error) { /* ... (código existente) ... */ }
    });

    bot.action('change_wallet_start', async (ctx) => { /* ... (código existente) ... */ });
    
    bot.action(/^transaction_history(?::(\d+))?$/, async (ctx) => { /* ... (código existente) ... */ });
    bot.action('confirm_delete_history', async (ctx) => { /* ... (código existente) ... */ });
    bot.action('delete_history_confirmed', async (ctx) => { /* ... (código existente) ... */ });
    
    // CORREÇÃO DO HANDLER back_to_main_menu
    bot.action('back_to_main_menu', async (ctx) => {
        try {
            awaitingAmountForUser = null; 
            await ctx.answerCbQuery();
            // Edita a mensagem anterior para mostrar o menu principal
            await ctx.editMessageText('O que você gostaria de fazer hoje?', { // Usar editMessageText
                reply_markup: mainMenuKeyboard.reply_markup // Reusa o mainMenuKeyboard
            });
        } catch (error) {
            logError('back_to_main_menu', error, ctx);
            // Fallback se editMessageText falhar (ex: mensagem muito antiga)
            await ctx.reply('O que você gostaria de fazer hoje?', mainMenuKeyboard);
        }
    });

    // CORREÇÃO DO HANDLER about_bridge e ADIÇÃO DO TEXTO DE DOAÇÃO
    bot.action('about_bridge', async (ctx) => {
        try {
            awaitingAmountForUser = null; 
            await ctx.answerCbQuery();
            const supportContactEscaped = escapeMarkdownV2(config.links.supportContact);
            const githubRepoLinkEscaped = escapeMarkdownV2(config.links.githubRepo);
            const donationAddress = "VJLBCUaw6GL8AuyjsrwpwTYNCUfUxPVTfxxffNTEZMKEjSwamWL6YqUUWLvz89ts1scTDKYoTF8oruMX"; // Endereço de doação
            const donationAddressEscaped = escapeMarkdownV2(donationAddress);

            const aboutMessage = 
                `O **Bridge Bot da Atlas** conecta o Pix brasileiro ao DePix \\(um Real digital soberano e privado\\)\\. \n` +
                `Estamos em constante desenvolvimento e buscamos construir uma comunidade resiliente\\.\n\n` +
                `\\- **Soberania Total:** Com o Bridge, você tem controle exclusivo sobre suas chaves e seus fundos DePix, pois tudo é enviado diretamente para sua carteira Liquid\\.\n` +
                `\\- **Receba Pix em DePix:** Converta pagamentos Pix em DePix \\(pareado 1:1 com o BRL\\), com a flexibilidade de convertê\\-lo para Bitcoin \\(L\\-BTC\\) quando desejar usando sua carteira Liquid compatível\\.\n` +
                `\\- **Tecnologia:** Usamos a robusta Liquid Network \\(uma sidechain do Bitcoin\\) para DePix\\. Nosso código é aberto e auditável\\.\n` +
                `\\- **Taxas Atuais \\(MVP v0\\.0\\.1\\):**\n` +
                `  A Atlas DAO não cobra taxas adicionais\\. O único custo é a taxa fixa de **R$0,99 por transação** para o serviço de conversão Pix para DePix \\(este é o custo da API DePix que é repassado\\)\\.\n\n` +
                `Para mais detalhes técnicos ou para ver nosso código, visite nosso GitHub: ${githubRepoLinkEscaped}\n\n` +
                `A Atlas DAO é uma Organização Autônoma Descentralizada\\. Doações são o principal meio de financiamento do desenvolvimento e nos ajudam a cobrir os custos para manter o serviço no ar\\.\n` + // Texto sobre DAO e doações
                `Endereço Liquid para doações em DePix ou L\\-BTC:\n` +
                `\`${donationAddressEscaped}\`\n\n` + // Endereço de doação
                `Contate o suporte em: ${supportContactEscaped}`;

            // Edita a mensagem anterior para mostrar as informações "Sobre"
            await ctx.editMessageText(aboutMessage, { // Usar editMessageText
                parse_mode: 'MarkdownV2',
                reply_markup: Markup.inlineKeyboard([ // Botão para voltar ao menu principal
                    [Markup.button.callback('⬅️ Voltar ao Menu', 'back_to_main_menu')]
                ]).reply_markup
            });
        } catch (error) {
            logError('about_bridge', error, ctx);
            // Fallback se editMessageText falhar
            await ctx.replyWithMarkdownV2('Ocorreu um erro ao mostrar as informações\\. Tente o menu novamente\\.');
        }
    });

    bot.catch((err, ctx) => { /* ... (código existente) ... */ });

    console.log('Bot handlers registered.');
};

module.exports = registerBotHandlers;

