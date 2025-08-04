module.exports = {
  /**
   * Configuração APENAS para a aplicação de produção.
   */
  apps : [
    {
      name: "atlas-bridge-prod",
      script: "./src/app.js",
      // Garante que o NODE_ENV seja 'production' ao iniciar.
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
