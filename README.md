# WhatSalesAgent2

> AI-powered WhatsApp Business Assistant Platform  
> Intent Engine → Module Router → Flow Engine → AI Fallback

Supports: Restaurant · Bakery · Salon · Barbershop · Fashion · Cosmetics · Electronics

---

## Quick Start (Local — Windows)

### 1. Install
```powershell
npm install
```

### 2. Configure
```powershell
copy .env.example .env
```
Open `.env`, then generate your security keys:
```powershell
npm run gen-key
```
Copy the output into `.env` (`SUPER_ADMIN_API_KEY` and `ENCRYPTION_KEY`).

Set your MongoDB URI in `.env`:
```
MONGODB_URI=mongodb://127.0.0.1:27017/whatsalesagent2
```

### 3. Seed demo businesses
```powershell
npm run seed
```

### 4. Start (simulation mode — no WhatsApp needed)
```powershell
npm run dev:sim
```

### 5. Test in Bruno / Postman
```
POST http://localhost:5000/api/message
Content-Type: application/json

{"userId":"test001","message":"Hi"}
```

### Check server health
```powershell
npm run health
```

---

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start in development mode |
| `npm run dev:sim` | Start in dev + simulation mode (local testing, no WhatsApp) |
| `npm start` | Start in production mode |
| `npm run seed` | Seed all 6 demo businesses |
| `npm run gen-key` | Generate SUPER_ADMIN_API_KEY + ENCRYPTION_KEY |
| `npm run health` | Check if server is running |

---

## Deploying to Koyeb

### Prerequisites
- MongoDB Atlas free cluster → https://cloud.mongodb.com
- Koyeb account → https://app.koyeb.com
- Meta Developer account → https://developers.facebook.com
- GitHub repo with this project

### Step 1 — Push to GitHub
```powershell
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_NAME/whatsalesagent.git
git push -u origin main
```

### Step 2 — Create Koyeb Service
1. Koyeb → **Create Service** → **GitHub**
2. Select your repo + `main` branch
3. Build command: `npm install --production`
4. Run command: `npm start`
5. Port: `5000`
6. Health check path: `/health`

### Step 3 — Set environment variables on Koyeb
Copy from your `.env` — required for production:

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `MONGODB_URI` | Your Atlas connection string |
| `SUPER_ADMIN_API_KEY` | From `npm run gen-key` |
| `ENCRYPTION_KEY` | From `npm run gen-key` (exactly 32 chars) |
| `META_APP_ID` | From Meta App → Settings → Basic |
| `META_APP_SECRET` | From Meta App → Settings → Basic |
| `META_PHONE_NUMBER_ID` | From Meta App → WhatsApp → API Setup |
| `META_WHATSAPP_TOKEN` | From Meta App → WhatsApp → API Setup |
| `META_WABA_ID` | From Meta App → WhatsApp → API Setup |
| `META_WEBHOOK_VERIFY_TOKEN` | Any string you choose |
| `SIMULATION_MODE` | `false` |
| `SCHEDULER_ENABLED` | `true` |
| `BASE_URL` | Your Koyeb URL (e.g. `https://whatsalesagent-xxx.koyeb.app`) |
| `ADMIN_PHONES` | Your WhatsApp number (without +) |
| `GROQ_API_KEY` | From https://console.groq.com (free) |

### Step 4 — Connect Meta Webhook
1. Meta App → WhatsApp → Configuration → Webhooks
2. **Callback URL**: `https://YOUR_KOYEB_URL/webhook`
3. **Verify Token**: same as `META_WEBHOOK_VERIFY_TOKEN`
4. Click **Verify and Save**
5. Subscribe to: `messages`

### Step 5 — Create your tenant
```powershell
Invoke-RestMethod -Method Post https://YOUR_KOYEB_URL/admin/tenants `
  -ContentType "application/json" `
  -Headers @{"x-api-key" = "YOUR_SUPER_ADMIN_API_KEY"} `
  -Body '{
    "name": "My Business",
    "businessMode": "RESTAURANT",
    "adminPhone": "2207XXXXXX",
    "whatsapp": {
      "phoneNumberId": "YOUR_PHONE_NUMBER_ID",
      "accessToken": "YOUR_WHATSAPP_TOKEN"
    }
  }'
```

Your WhatsApp bot is now live.

---

## Architecture

```
Customer message (WhatsApp)
       ↓
  /webhook (Meta Cloud API)
       ↓
  Guard layer         de-dup · human mode · session load
       ↓
  postFlowAck         warm ack after order/booking completion
       ↓
  Active flow? ──yes──→ flowEngine.advance() → module handler
       ↓ no
  Intent Engine       button ID → emoji → keyword → AI classify
       ↓
  Module Router       intent → action handler
       ↓
  Response builder    buttons · list · text
       ↓
  Dispatcher          Meta Cloud API (live) or simulation slot (dev)
```

---

## API Reference

### Simulation (dev only — `SIMULATION_MODE=true`)

| Method | Path | Body |
|--------|------|------|
| POST | `/api/message` | `{userId, message}` or `{userId, buttonId}` |
| POST | `/api/reset` | `{userId}` |
| GET | `/api/session/:userId` | — |
| GET | `/api/businesses` | — |

### Business (requires `x-api-key`)

| Method | Path |
|--------|------|
| GET | `/business/:tenantId` |
| PUT | `/business/:tenantId` |
| GET/PUT/POST/DELETE | `/business/:tenantId/menu` |

### Dashboard (requires `x-api-key`)

| Method | Path |
|--------|------|
| GET | `/dashboard/:tenantId/overview` |
| GET | `/dashboard/:tenantId/orders` |
| GET | `/dashboard/:tenantId/bookings` |
| GET | `/dashboard/:tenantId/analytics` |
| GET | `/dashboard/:tenantId/conversations` |

### Admin (requires super-admin key)

| Method | Path |
|--------|------|
| POST | `/admin/tenants` |
| GET | `/admin/tenants` |
| PATCH | `/admin/tenants/:id/status` |
| DELETE | `/admin/tenants/:id` |

---

## WhatsApp Admin Commands

Send these from your registered admin WhatsApp number:

```
APPROVE ABC123           → Approve payment proof
REJECT ABC123            → Reject payment proof
CONFIRM BOOK XYZ456      → Confirm a booking
DECLINE BOOK XYZ456      → Decline a booking
RESUME BOT 2207XXXXXX    → Re-enable bot for a customer
```

---

## Adding a New Business Module

1. `src/modules/yourmodule/flows/index.js` — export config + flow handlers
2. `src/core/shared/moduleRegistry.js` — register flows (3 lines)
3. `src/config/modes.js` — add to MODE_MAP (1 line)
4. `npm run seed` — add demo business with `businessMode: 'YOURMODE'`
