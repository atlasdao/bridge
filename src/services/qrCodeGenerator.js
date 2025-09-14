const QRCode = require('qrcode');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../core/logger');

/**
 * Gera um QR Code personalizado com branding Atlas DAO
 * @param {string} pixCode - Código PIX copia e cola
 * @param {number} amount - Valor em reais
 * @returns {Promise<Buffer>} - Buffer da imagem do QR code com design Atlas
 */
async function generateCustomQRCode(pixCode, amount) {
    try {
        // Configurações do QR Code - sem logo no centro para melhor leitura
        const qrOptions = {
            errorCorrectionLevel: 'M', // Médio - melhor performance
            type: 'png',
            width: 300, // Otimizado
            margin: 2,
            color: {
                dark: '#000000',  // QR code preto
                light: '#FFFFFF'  // Fundo branco
            }
        };

        // Gerar QR code base
        const qrBuffer = await QRCode.toBuffer(pixCode, qrOptions);

        // Criar o design completo com tema Atlas DAO
        return await createAtlasDesign(qrBuffer, amount);

    } catch (error) {
        logger.error('Erro ao gerar QR code personalizado:', error);
        // Fallback para QR code simples
        return await QRCode.toBuffer(pixCode, { width: 400 });
    }
}

/**
 * Cria o design completo com tema Atlas DAO otimizado
 */
async function createAtlasDesign(qrBuffer, amount) {
    const canvasSize = 500; // Tamanho otimizado
    const qrSize = 300;
    const qrPosition = (canvasSize - qrSize) / 2;

    // Criar SVG com design Atlas DAO limpo e moderno
    const svgDesign = `
    <svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
        <!-- Fundo gradiente escuro -->
        <defs>
            <linearGradient id="bgGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#0a1929;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#1a2332;stop-opacity:1" />
            </linearGradient>

            <!-- Padrão de rede blockchain -->
            <pattern id="networkPattern" x="0" y="0" width="100" height="100" patternUnits="userSpaceOnUse">
                <!-- Grid principal -->
                <line x1="0" y1="50" x2="100" y2="50" stroke="#ff6b35" stroke-width="0.4" opacity="0.3"/>
                <line x1="50" y1="0" x2="50" y2="100" stroke="#ff6b35" stroke-width="0.4" opacity="0.3"/>

                <!-- Diagonais -->
                <line x1="0" y1="0" x2="100" y2="100" stroke="#00d4ff" stroke-width="0.3" opacity="0.25"/>
                <line x1="100" y1="0" x2="0" y2="100" stroke="#00d4ff" stroke-width="0.3" opacity="0.25"/>

                <!-- Nós da rede -->
                <circle cx="0" cy="0" r="1.5" fill="#ff6b35" opacity="0.5"/>
                <circle cx="100" cy="0" r="1.5" fill="#ff6b35" opacity="0.5"/>
                <circle cx="0" cy="100" r="1.5" fill="#00d4ff" opacity="0.5"/>
                <circle cx="100" cy="100" r="1.5" fill="#00d4ff" opacity="0.5"/>
                <circle cx="50" cy="50" r="2" fill="#ffa500" opacity="0.6"/>
            </pattern>
        </defs>

        <!-- Background -->
        <rect width="${canvasSize}" height="${canvasSize}" fill="url(#bgGradient)"/>

        <!-- Padrão de rede -->
        <rect width="${canvasSize}" height="${canvasSize}" fill="url(#networkPattern)"/>

        <!-- Elementos decorativos nos cantos -->
        <g opacity="0.4">
            <path d="M 25 45 L 25 25 L 45 25" stroke="#ff6b35" stroke-width="2" fill="none" stroke-linecap="round"/>
            <path d="M ${canvasSize-45} 25 L ${canvasSize-25} 25 L ${canvasSize-25} 45" stroke="#00d4ff" stroke-width="2" fill="none" stroke-linecap="round"/>
            <path d="M 25 ${canvasSize-45} L 25 ${canvasSize-25} L 45 ${canvasSize-25}" stroke="#00d4ff" stroke-width="2" fill="none" stroke-linecap="round"/>
            <path d="M ${canvasSize-45} ${canvasSize-25} L ${canvasSize-25} ${canvasSize-25} L ${canvasSize-25} ${canvasSize-45}" stroke="#ff6b35" stroke-width="2" fill="none" stroke-linecap="round"/>
        </g>

        <!-- Header limpo e moderno -->
        <g transform="translate(${canvasSize/2}, 55)">
            <!-- Nome Atlas DAO com sombra -->
            <text y="0" font-family="'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
                  font-size="32" font-weight="800" letter-spacing="2"
                  text-anchor="middle" fill="#ffffff"
                  filter="drop-shadow(0 2px 4px rgba(0,0,0,0.5))">ATLAS DAO</text>

            <!-- Tagline sem fundo, apenas com sombra para legibilidade -->
            <text y="28" font-family="'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
                  font-size="13" font-weight="600" letter-spacing="1.2"
                  text-anchor="middle" fill="#ffffff" opacity="0.95"
                  filter="drop-shadow(0 1px 3px rgba(0,0,0,0.8))">Bridge • PIX para Liquid</text>
        </g>

        <!-- Container do QR Code -->
        <g transform="translate(${canvasSize/2}, ${canvasSize/2 + 20})">
            <!-- Fundo branco do QR -->
            <rect x="${-qrSize/2 - 15}" y="${-qrSize/2 - 15}"
                  width="${qrSize + 30}" height="${qrSize + 30}"
                  fill="#ffffff" rx="18"/>

            <!-- Borda decorativa -->
            <rect x="${-qrSize/2 - 17}" y="${-qrSize/2 - 17}"
                  width="${qrSize + 34}" height="${qrSize + 34}"
                  fill="none" stroke="#ff6b35" stroke-width="1.5" rx="20" opacity="0.6"/>
        </g>

        <!-- Pontos decorativos -->
        <g opacity="0.6">
            <circle cx="80" cy="140" r="1" fill="#ff6b35"/>
            <circle cx="420" cy="110" r="1" fill="#00d4ff"/>
            <circle cx="120" cy="380" r="1" fill="#ffffff"/>
            <circle cx="380" cy="360" r="1" fill="#ff6b35"/>
        </g>
    </svg>`;

    // Converter SVG para buffer
    const svgBuffer = Buffer.from(svgDesign);

    // Adicionar logo branco no topo
    const headerLogoPath = path.join(__dirname, '../../assets/atlas-logo-white.png');
    let compositeArray = [];

    try {
        await fs.access(headerLogoPath);
        const headerLogoBuffer = await sharp(headerLogoPath)
            .resize(35, 35, {
                fit: 'contain',
                background: { r: 255, g: 255, b: 255, alpha: 0 }
            })
            .png()
            .toBuffer();

        compositeArray.push({
            input: headerLogoBuffer,
            top: 18,
            left: canvasSize/2 - 17
        });
    } catch (error) {
        logger.info('Logo branco não encontrado para header');
    }

    // Adicionar QR code
    compositeArray.push({
        input: qrBuffer,
        top: qrPosition + 20,
        left: qrPosition,
        blend: 'over'
    });

    // Compor a imagem base
    const baseImage = await sharp(svgBuffer)
        .composite(compositeArray)
        .png()
        .toBuffer();


    // Criar badge de valor com design moderno
    const valueOverlay = `
    <svg width="180" height="50" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <filter id="valueShadow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
                <feOffset dx="0" dy="4" result="offsetblur"/>
                <feFlood flood-color="#000000" flood-opacity="0.4"/>
                <feComposite in2="offsetblur" operator="in"/>
                <feMerge>
                    <feMergeNode/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
            <linearGradient id="valueGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#ff7043;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#ff5722;stop-opacity:1" />
            </linearGradient>
        </defs>

        <!-- Container principal com cantos arredondados -->
        <rect x="10" y="10" width="160" height="36"
              fill="url(#valueGrad)" rx="18" filter="url(#valueShadow)"/>

        <!-- Highlight superior -->
        <rect x="10" y="10" width="160" height="18"
              fill="#ffffff" opacity="0.15" rx="18"/>

        <!-- Texto do valor com fonte moderna -->
        <text x="90" y="32" font-family="'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif"
              font-size="19" font-weight="700" text-anchor="middle" fill="#ffffff"
              style="letter-spacing: 0.5px">
            R$ ${amount.toFixed(2).replace('.', ',')}
        </text>
    </svg>`;

    const valueBuffer = await sharp(Buffer.from(valueOverlay))
        .png()
        .toBuffer();

    const finalImage = await sharp(baseImage)
        .composite([
            {
                input: valueBuffer,
                top: canvasSize/2 + qrSize/2 + 5, // Centro do badge 50% fora do QR
                left: canvasSize/2 - 90 // Centralizado
            }
        ])
        .png({
            quality: 85,
            compressionLevel: 9
        })
        .toBuffer();

    return finalImage;
}

/**
 * Gera um QR Code minimalista (versão alternativa)
 */
async function generateMinimalQRCode(pixCode, amount) {
    try {
        const qrOptions = {
            errorCorrectionLevel: 'M',
            type: 'png',
            width: 280,
            margin: 2,
            color: {
                dark: '#1a2332',
                light: '#FFFFFF'
            }
        };

        const qrBuffer = await QRCode.toBuffer(pixCode, qrOptions);

        // Design minimalista
        const canvasSize = 350;
        const minimalDesign = `
        <svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${canvasSize}" height="${canvasSize}" fill="#ffffff"/>

            <!-- Header minimalista -->
            <text x="${canvasSize/2}" y="35" font-family="'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
                  font-size="18" font-weight="300" text-anchor="middle" fill="#1a2332">
                ATLAS BRIDGE
            </text>

            <!-- Linha decorativa -->
            <line x1="40" y1="48" x2="${canvasSize-40}" y2="48"
                  stroke="#ff6b35" stroke-width="1" opacity="0.5"/>

            <!-- Footer com valor -->
            <text x="${canvasSize/2}" y="${canvasSize-25}" font-family="'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
                  font-size="16" font-weight="500" text-anchor="middle" fill="#ff6b35">
                PIX • R$ ${amount.toFixed(2).replace('.', ',')}
            </text>
        </svg>`;

        return await sharp(Buffer.from(minimalDesign))
            .composite([
                {
                    input: qrBuffer,
                    top: 60,
                    left: 35
                }
            ])
            .png({
                quality: 85,
                compressionLevel: 9
            })
            .toBuffer();

    } catch (error) {
        logger.error('Erro ao gerar QR minimalista:', error);
        return await QRCode.toBuffer(pixCode, { width: 400 });
    }
}

module.exports = {
    generateCustomQRCode,
    generateMinimalQRCode
};