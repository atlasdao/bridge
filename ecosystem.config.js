module.exports = {
  apps : [{
    name   : "atlas-bridge-PROD", // Pode dar um nome novo/distinto para clareza
    script : "src/app.js",       // Caminho relativo ao cwd, entao 'src/app.js' esta OK
    cwd    : "/opt/bridge_app/main/", // <<< caminho de atuacao do pm2
    watch  : false,
    max_memory_restart: "250M",
    env_production: {
       NODE_ENV: "production",
       PORT: 3000 // Porta de producao
    },
    // Atualize os caminhos dos logs para serem relativos ao novo CWD ou absolutos
    out_file : "./logs/pm2-out.log",  // Relativo a /opt/bridge_app/main/
    error_file : "./logs/pm2-err.log", // Relativo a /opt/bridge_app/main/
    // OU caminhos absolutos:
    // out_file : "/opt/bridge_app/main/logs/pm2-out.log",
    // error_file : "/opt/bridge_app/main/logs/pm2-err.log",
    log_date_format : "YYYY-MM-DD HH:mm:ss Z",
    merge_logs : true,
  }]
}
