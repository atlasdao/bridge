module.exports = {
  apps : [{
    name   : "atlas-bridge-bot", // Nome que aparecerá no PM2
    script : "src/app.js",       // Seu script de entrada principal
    cwd    : "/opt/bridge_app/",   // Diretório de trabalho da aplicação
    watch  : false,              // Desabilitar watch do PM2 (nodemon já faz isso em dev, em prod não é ideal)
                                 // Para produção, se você fizer deploy de novo código, você fará `pm2 reload atlas-bridge-bot`
    max_memory_restart: "250M",  // Reiniciar se usar mais que 250MB de RAM (ajuste conforme necessário)
    env_production: {            // Variáveis de ambiente específicas para o modo "production"
       NODE_ENV: "production"
    },
    env_development: {           // Variáveis de ambiente específicas para o modo "development" (se iniciar com --env development)
       NODE_ENV: "development"
    },
    // Configuração de Logs
    out_file : "/opt/bridge_app/logs/pm2-out.log",  // Caminho para logs de saída padrão (console.log)
    error_file : "/opt/bridge_app/logs/pm2-err.log", // Caminho para logs de erro (console.error)
    log_date_format : "YYYY-MM-DD HH:mm:ss Z",    // Formato da data nos logs
    merge_logs : true,           // Se rodar em cluster, mescla logs. Não crítico para um processo.
    // instances: 1,             // Rodar uma instância. Para cluster, mude para 'max' ou um número.
    // exec_mode: "cluster"      // Mudar para "fork" se não usar cluster. Fork é o padrão.
  }]
}
