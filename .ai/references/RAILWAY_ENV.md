# references/RAILWAY_ENV.md

## Deployment

- **Backend:** Railway. Node/Express, `npm start` → `node app.js`.
- **Frontend** (`whatsales-frontend`, separate repo): Vercel.
- `app.js` sets `trust proxy: 1` — required for `X-Forwarded-For` to work
  correctly behind Railway's reverse proxy.
- `GET /health` returns `{ status, version, webhookBuild, uptime, timestamp,
  environment }`. `webhookBuild` is `WEBHOOK_BUILD_MARKER` exported from
  `controllers/webhookController.js` — **bump this string on every
  meaningful deploy** and curl `/health` after deploying to confirm Railway
  is actually running the code you think it is, rather than inferring it
  from log shapes.

## Environment variables (`config/env.js`)

`validateEnv()` runs before any I/O in `app.js` and crashes fast
(`process.exit(1)`) on missing critical vars in production — this is
intentional: fail loud at boot, not silently at runtime.

### Always required (every environment)
- `MONGODB_URI`
- `SUPER_ADMIN_API_KEY` — must not be left as one of the known placeholder
  strings in production (`change_me_to_a_strong_random_string`, etc.) or
  boot fails with an explicit error.

### Required in production only
- `ENCRYPTION_KEY` — any non-empty string (SHA-256 hashed internally, so
  raw byte length doesn't matter). Without it, WhatsApp access tokens,
  verify tokens, webhook secrets, and Meta app secrets are stored in
  **plaintext** in MongoDB for every tenant — this only warns loudly at
  boot rather than blocking, but treat it as a real production requirement.
  Existing plaintext values do NOT retroactively encrypt themselves when
  you set this later — re-save each tenant's WhatsApp credentials once
  after setting it.
- `META_WEBHOOK_VERIFY_TOKEN` — required for the Meta webhook verification
  handshake.
- `SIMULATION_MODE` must be `false`/unset in production (hard error if
  `true`).
- `SCHEDULER_ENABLED=true` requires `WHATSAPP_TEMPLATES_ENABLED=true` — in
  production every scheduler target is a "cold" contact (24h+ since last
  customer message), and Meta silently drops plain-text messages to cold
  contacts. This is escalated from a warning to a hard startup ERROR
  specifically because the previous "warn only" behavior meant reminders
  looked like they were sending (no error in logs) while zero customers
  ever actually received one.

### Recommended / warn-only
- `META_APP_SECRET` — platform-wide fallback for webhook signature
  verification; each tenant can (and should) also store their own
  `meta.appSecret` on the `Tenant` document. Warns if absent (signature
  verification falls back to no-op for tenants without a stored secret).
- `GROQ_API_KEY` — without it, AI responses use the deterministic
  `mockProvider` fallback (valid for dev/testing; degraded for production).
- `CORS_ORIGIN` — comma-separated list of allowed frontend origins. If
  unset in production, every browser request from the real frontend fails
  silently client-side (the browser blocks it before it ever reaches this
  server's logs) — `app.js` warns loudly at boot specifically because this
  failure mode is otherwise invisible server-side.

### Other configuration vars (with sane defaults)
`META_API_VERSION` (default `v21.0`), `TEMPLATE_LANGUAGE` (default
`en_US` — must be a valid BCP-47 code Meta actually approved the template
under, not a bare `en`), `DISABLE_WORKING_HOURS` (default `false`),
`TIMEZONE` (default `UTC` — server-wide fallback when a
`BusinessConfig.hours.timezone` is absent), `CLOUDINARY_CLOUD_NAME` /
`CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` / `CLOUDINARY_UPLOAD_PRESET`,
`WHATSAPP_TEMPLATES_ENABLED` + `TEMPLATE_ABANDONED_CART` /
`TEMPLATE_BOOKING_REMINDER` / `TEMPLATE_PAYMENT_REMINDER`,
`SESSION_TTL_MINUTES` (default 30), `PAYMENT_SESSION_TTL_HOURS` (default
4), `HUMAN_MODE_SESSION_TTL_HOURS` (default 24), `ADMIN_PHONES`,
`NODE_ENV`, `PORT` (default 5000), `LOG_LEVEL`, `BASE_URL`.

## Contact/repo details

- GitHub: `DreamLine44/DreamlineSalesBot`.
- Owner contact used across the project: `alhassantrawally1@gmail.com`,
  Gambian phone number.

## Migration/maintenance scripts (`scripts/`)

Run manually via `npm run <script>` (see `package.json`):
- `migrate:remove-raw-api-keys` — `scripts/migrate_remove_raw_api_keys.js`
- `migrate:set-meta-fields` — `scripts/migrate_set_meta_fields.js`
- `gen-key` — `scripts/genKey.js` (generates a new API key)
- `health` — `scripts/health.js`
- `seed` — `scripts/seed.js`

If you add a new migration, follow the existing naming/registration
convention (`migrate_<description>.js`, wired into `package.json` as
`migrate:<short-name>`).
