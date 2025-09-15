const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// SVG do logo Atlas DAO
const svgLogo = `<svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <!-- Logo Atlas DAO baseado no design fornecido -->
  <g transform="translate(100, 100)">
    <!-- Triângulo principal (estilo montanha/pirâmide) -->
    <path d="M -60 40 L 0 -60 L 60 40 Z"
          fill="none"
          stroke="#000000"
          stroke-width="8"
          stroke-linejoin="miter"/>

    <!-- Linha horizontal conectando os lados -->
    <path d="M -35 0 L 35 0"
          fill="none"
          stroke="#000000"
          stroke-width="8"/>

    <!-- Vértice superior -->
    <path d="M 0 -60 L 0 -20"
          fill="none"
          stroke="#000000"
          stroke-width="8"/>
  </g>
</svg>`;

// Converter SVG para PNG
async function generateLogoPNG() {
    try {
        const outputPath = path.join(__dirname, '../assets/atlas-logo.png');

        await sharp(Buffer.from(svgLogo))
            .resize(200, 200)
            .png()
            .toFile(outputPath);

        console.log('Logo PNG gerado com sucesso em:', outputPath);
    } catch (error) {
        console.error('Erro ao gerar logo PNG:', error);
    }
}

generateLogoPNG();