/**
 * ecosystem.config.cjs — DreamLine SalesBot v24.0
 * PM2 process manager configuration for production deployment.
 *
 * Usage:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save          ← persist across reboots
 *   pm2 startup       ← auto-start on server reboot
 *
 * Note: .cjs extension is used because the project is ESM ("type":"module")
 * but PM2 config files must use CommonJS require() syntax.
 */

module.exports = {
  apps: [
    {
      name:         "dreamline-salesbot",
      script:       "app.js",
      interpreter:  "node",

      // ── Clustering ──────────────────────────────────────────────────────────
      // "max" uses all CPU cores. For a WhatsApp bot on a 1–2 core VPS,
      // use instances: 1 to avoid MongoDB connection pool exhaustion.
      // Increase to 2 or "max" only on 4+ core machines.
      instances:    1,
      exec_mode:    "fork",   // use "cluster" if instances > 1

      // ── Environment ─────────────────────────────────────────────────────────
      env: {
        NODE_ENV: "development",
        PORT:     5000,
      },
      env_production: {
        NODE_ENV:         "production",
        PORT:             5000,
        SIMULATION_MODE:  "false",  // NEVER expose /api/messages in production
      },

      // ── Logs ────────────────────────────────────────────────────────────────
      log_date_format:  "YYYY-MM-DD HH:mm:ss Z",
      error_file:       "logs/pm2-error.log",
      out_file:         "logs/pm2-out.log",
      merge_logs:       true,
      log_file:         "logs/pm2-combined.log",

      // ── Restart Policy ──────────────────────────────────────────────────────
      // Restart automatically on crash, but stop after 10 crashes in 5 min
      // to prevent infinite restart loops masking a real bug.
      autorestart:      true,
      max_restarts:     10,
      min_uptime:       "5s",
      restart_delay:    3000,   // ms between restarts

      // ── Memory Guard ────────────────────────────────────────────────────────
      // Restart if memory exceeds 512 MB (adjust for your server size)
      max_memory_restart: "512M",

      // ── Watch ───────────────────────────────────────────────────────────────
      // Disabled in production — use pm2 reload after deploy instead
      watch:            false,
      ignore_watch:     ["node_modules", "logs", ".git"],

      // ── Source maps ─────────────────────────────────────────────────────────
      source_map_support: false,

      // ── Node.js args ────────────────────────────────────────────────────────
      // --max-old-space-size: cap Node heap at 400 MB (below max_memory_restart)
      node_args: "--max-old-space-size=400",
    },
  ],
};
