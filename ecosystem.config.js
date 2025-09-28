module.exports = {
  apps: [{
    name: 'atlas-bridge',
    script: './src/app.js',
    instances: 2,
    exec_mode: 'cluster',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    min_uptime: '10s',
    max_restarts: 5,
    autorestart: true,
    cron_restart: '0 3 * * *'
  }]
};
