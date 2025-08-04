module.exports = {
  apps : [{
    name   : "atlas-bridge-PROD",
    script : "./src/app.js",
    env_production: {
      NODE_ENV: "production"
    }
  }, {
    name   : "atlas-bridge-dev",
    script : "./src/app.js",
    watch: ["src"],
    watch_delay: 1000,
    ignore_watch : ["node_modules"],
    env_development: {
       NODE_ENV: "development"
    }
  }]
}