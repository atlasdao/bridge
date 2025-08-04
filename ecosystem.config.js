module.exports = {
  /**
   * Configuração do PM2 EXCLUSIVAMENTE para a aplicação de PRODUÇÃO.
   * Este arquivo deve viver no diretório raiz da branch 'main'.
   */
  apps : [
    {
      name: "atlas-bridge-prod",
      script: "./src/app.js",
      
      // 'watch' é desabilitado em produção para garantir estabilidade.
      // As atualizações devem ser feitas manualmente com 'pm2 restart'.
      watch: false,

      // A chave 'env' define as variáveis de ambiente para a aplicação.
      // Definir NODE_ENV como 'production' é crucial para carregar o .env.production
      // e para ativar otimizações de performance em bibliotecas como o Express.
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};