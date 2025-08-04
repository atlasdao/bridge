module.exports = {
  /**
   * Lista de aplicações a serem gerenciadas pelo PM2.
   * Cada objeto no array representa uma aplicação.
   */
  apps : [
    // --- AMBIENTE DE PRODUÇÃO ---
    {
      name: "atlas-bridge-PROD",
      script: "./src/app.js",
      // As variáveis de ambiente definidas aqui serão carregadas
      // apenas quando o PM2 for iniciado com a flag --env production
      env_production: {
        NODE_ENV: "production"
      }
    },
    
    // --- AMBIENTE DE DESENVOLVIMENTO ---
    {
      name: "atlas-bridge-dev",
      script: "./src/app.js",
      // 'watch' reinicia automaticamente a aplicação quando um arquivo é modificado.
      // Ideal para desenvolvimento.
      watch: ["src"],
      watch_delay: 1000,
      ignore_watch: ["node_modules"],
      // As variáveis de ambiente definidas aqui serão carregadas
      // apenas quando o PM2 for iniciado com a flag --env development
      env_development: {
        NODE_ENV: "development"
      }
    }
  ]
};