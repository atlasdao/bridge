module.exports = {
  apps: [
    {
      name: 'atlas-bridge',
      script: './src/app.js',
      instances: 1,
      exec_mode: 'fork',
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
      // IMPORTANT: PM2 cron_restart does NOT respect timezone setting!
      // PM2 uses server's local time for cron_restart (not UTC, not custom timezone)
      // Server timezone appears to be UTC, so we must calculate accordingly
      //
      // Cron jobs schedule (Brazil timezone = UTC-3):
      // - 00:00 BRT (03:00 UTC): Daily limit reset (CRITICAL)
      // - 02:00 BRT (05:00 UTC): Transaction cleanup
      // - 03:30 BRT (06:30 UTC): PM2 restart (SAFE - 3.5 hours after reset)
      // - Every 15 min: User state cleanup
      // - Every hour (XX:15): Stats recalculation
      // - Every 5 min: Verification polling
      //
      // REMOVED cron_restart - causing conflict with daily limit reset at 03:00 UTC
      // Manual restarts should be done during maintenance windows if needed
    },
    {
      name: 'atlas-alert-bot',
      script: './alert-bot.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/alert-bot-error.log',
      out_file: './logs/alert-bot-out.log',
      log_file: './logs/alert-bot-combined.log',
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '5s'
    }
  ]
};
