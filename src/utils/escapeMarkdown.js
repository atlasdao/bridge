/**
 * Escapa uma string para ser compatível com o formato MarkdownV2 do Telegram.
 * @param {string} text O texto a ser escapado.
 * @returns {string} O texto escapado.
 */
const escapeMarkdownV2 = (text) => {
    if (typeof text !== 'string') return '';
    // Escapa os seguintes caracteres: _ * [ ] ( ) ~ ` > # + - = | { } . !
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
};

module.exports = { escapeMarkdownV2 };