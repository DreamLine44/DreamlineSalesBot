# WhatSalesAgent2 — Production Deployment Checklist

## What Changed (Dev → Production)

### New Files
| File | Purpose |
|------|---------|
| `src/middleware/webhookSignature.js` | Verifies Meta's `X-Hub-Signature-256` header on every webhook POST. **Without this, anyone who finds your URL can spoof messages.** |
| `Procfile` | Heroku/Railway process definition |
| `railway.json` | Railway deployment config with health check |
| `render.yaml` | Render.com deployment config |

### Modified Files
| File | What Changed |
|------|-------------|
| `src/config/env.js` | Added `validateEnv()` — crashes on startup if critical vars are missing |
| `src/app.js` | Calls `validateEnv()` first; disables simulation routes in production; uses `webhookLimiter`; rejects unknown CORS origins; adds `uncaughtException` handler |
| `src/config/database.js` | Added connection event monitoring; `maxPoolSize`, `heartbeatFrequencyMS` |
| `src/middleware/authMiddleware.js` | Constant-time comparison; per-tenant API key lookup via SHA-256 hash; failed auth is logged |
| `src/middleware/rateLimiter.js` | Rate limits NEVER skipped in production; webhook gets generous limiter; admin gets tight limiter |
| `src/middleware/errorHandler.js` | Stack traces never sent to clients; Mongoose errors mapped to correct HTTP codes; correlation IDs on 5xx |
| `src/routes/webhookRoutes.js` | `verifyMetaSignature` runs before `receiveWebhook` on POST |
| `package.json` | `start` script sets `NODE_ENV=production` explicitly |
| `.env.example` | Updated with production-appropriate defaults and clear instructions |

---

## Step-by-Step Go-Live Instructions

### 1. Get Meta WhatsApp Cloud API credentials

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create an App → Business → WhatsApp
3. From the WhatsApp setup page, note:
   - **Phone Number ID** (e.g. `123456789012345`)
   - **WhatsApp Business Account ID (WABA ID)**
   - **Temporary access token** (get a permanent one via System User)
   - **App Secret** (App Settings → Basic)
4. Create your webhook verify token — any random string (e.g. `openssl rand -hex 16`)

### 2. Set up MongoDB Atlas (free tier)

1. [mongodb.com/atlas](https://www.mongodb.com/atlas) → New Project → Free M0 cluster
2. Create a DB user with a strong password
3. Whitelist `0.0.0.0/0` (or your server's IP) under Network Access
4. Get connection string: `mongodb+srv://user:pass@cluster.mongodb.net/whatsalesagent2`

### 3. Deploy to Railway (recommended — free tier available)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and init
railway login
railway init

# Set all environment variables (see .env.example)
railway variables set NODE_ENV=production
railway variables set MONGODB_URI="mongodb+srv://..."
railway variables set SUPER_ADMIN_API_KEY="$(openssl rand -hex 32)"
railway variables set ENCRYPTION_KEY="$(openssl rand -hex 16)"
railway variables set META_APP_SECRET="your_app_secret"
railway variables set META_WEBHOOK_VERIFY_TOKEN="your_verify_token"
railway variables set GROQ_API_KEY="your_groq_key"   # optional
railway variables set SCHEDULER_ENABLED=true
railway variables set SIMULATION_MODE=false
railway variables set LOG_LEVEL=info

# Deploy
railway up

# Get your public URL
railway open
```

Your app will be live at `https://your-app.railway.app`

### 4. Connect Meta Webhook

1. In Meta App Dashboard → WhatsApp → Configuration → Webhook
2. Set **Callback URL**: `https://your-app.railway.app/webhook`
3. Set **Verify Token**: same value as `META_WEBHOOK_VERIFY_TOKEN` in your env
4. Subscribe to: **messages**
5. Click **Verify and Save** — this calls `GET /webhook` to confirm

### 5. Seed your first tenant/business

```bash
# Locally (with your production MongoDB URI in .env)
MONGODB_URI="mongodb+srv://..." node src/scripts/seed.js

# Or via Railway
railway run node src/scripts/seed.js
```

### 6. Update the tenant with live WhatsApp credentials

```bash
# Create your tenant via the API
curl -X POST https://your-app.railway.app/admin/tenants \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_SUPER_ADMIN_API_KEY" \
  -d '{
    "name": "My Business",
    "businessMode": "RESTAURANT",
    "adminPhone": "2207XXXXXXX",
    "whatsapp": {
      "phoneNumberId": "YOUR_PHONE_NUMBER_ID",
      "accessToken": "YOUR_ACCESS_TOKEN",
      "apiVersion": "v21.0"
    }
  }'
```

### 7. Verify it's working

```bash
# Health check
curl https://your-app.railway.app/health

# Send a test message from your phone to your WhatsApp Business number
# You should receive a welcome reply from the bot
```

---

## Security Notes

- **Never commit `.env`** — it's in `.gitignore`
- **Rotate `SUPER_ADMIN_API_KEY`** periodically (`openssl rand -hex 32`)
- **Meta access tokens** expire — set up a System User in Meta Business Manager for permanent tokens
- **`META_APP_SECRET`** is required in production — the bot will refuse all webhook POSTs without it
- **`ENCRYPTION_KEY`** must stay constant — changing it invalidates any encrypted data in MongoDB

---

## Deployment Alternatives

| Platform | Command | Notes |
|----------|---------|-------|
| **Railway** | `railway up` | Recommended — auto-detects Node, free tier |
| **Render** | Push to GitHub, connect repo | Uses `render.yaml` |
| **Heroku** | `git push heroku main` | Uses `Procfile` |
| **VPS (Ubuntu)** | See PM2 section below | Full control |

### VPS with PM2

```bash
npm install -g pm2
NODE_ENV=production pm2 start src/app.js --name whatsalesagent2
pm2 save
pm2 startup
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | ✅ | Must be `production` |
| `MONGODB_URI` | ✅ | MongoDB Atlas connection string |
| `SUPER_ADMIN_API_KEY` | ✅ | Master API key (64-char hex) |
| `ENCRYPTION_KEY` | ✅ | Exactly 32 characters |
| `META_WEBHOOK_VERIFY_TOKEN` | ✅ prod | Your chosen verify token |
| `META_APP_SECRET` | ✅ prod | From Meta App Dashboard |
| `GROQ_API_KEY` | Optional | Omit to use mock AI |
| `SIMULATION_MODE` | — | Must be `false` in prod |
| `SCHEDULER_ENABLED` | Optional | `true` to enable reminders |
| `ADMIN_PHONES` | Optional | Comma-separated E.164 numbers |
| `CORS_ORIGIN` | Optional | Your dashboard domain |
| `LOG_LEVEL` | Optional | `info` recommended |
