# WhatSalesAgent2 — Complete Live Deployment Guide

> **Audience:** You, right now. Step-by-step, nothing skipped. Every account, every click, every command.

---

## What you need before starting

| Thing | Where to get it | Free? |
|---|---|---|
| MongoDB Atlas account | mongodb.com/atlas | ✅ Free tier |
| Railway or Render account | railway.app or render.com | ✅ Free tier |
| Meta Developer account | developers.facebook.com | ✅ Free |
| WhatsApp Business account | Already on your phone | ✅ |
| Groq API key (AI) | console.groq.com | ✅ Free |
| Node 18+ on your laptop (for seed only) | nodejs.org | ✅ |

---

## STEP 1 — MongoDB Atlas (your database)

1. Go to **mongodb.com/atlas** → Create free account → Create a **free M0 cluster** (any region)
2. Click **Database Access** → Add Database User:
   - Username: `whatsalesagent`
   - Password: generate a strong one, save it
   - Role: **Atlas Admin**
3. Click **Network Access** → Add IP Address → **Allow Access from Anywhere** (`0.0.0.0/0`)
4. Click your cluster → **Connect** → **Compass** → copy the connection string. It looks like:
   ```
   mongodb+srv://whatsalesagent:<password>@cluster0.xxxxx.mongodb.net/
   ```
5. Replace `<password>` with your actual password. Add the DB name at the end:
   ```
   mongodb+srv://whatsalesagent:YOURPASS@cluster0.xxxxx.mongodb.net/whatsalesagent2
   ```
   **Save this string** — it becomes your `MONGODB_URI`.

---

## STEP 2 — Groq API Key (free AI)

1. Go to **console.groq.com** → Sign up free
2. Click **API Keys** → **Create API Key** → copy it
3. **Save it** — it becomes your `GROQ_API_KEY`

---

## STEP 3 — Meta WhatsApp Setup

This is the most involved part. Take it one step at a time.

### 3a. Create a Meta App

1. Go to **developers.facebook.com** → **My Apps** → **Create App**
2. Use case: **Other** → Next
3. App type: **Business** → Next
4. Fill in app name (e.g. `WhatSalesAgent`) and your email → **Create App**

### 3b. Add WhatsApp Product

1. On your app dashboard, scroll to find **WhatsApp** → click **Set Up**
2. You'll land on the WhatsApp Getting Started page
3. Under **Step 1**, select or create a **WhatsApp Business Account (WABA)**
4. Under **Step 2**, you'll see a **test phone number** pre-provided by Meta (free, for testing) — use this at first. Note down:
   - **Phone Number ID** (looks like `123456789012345`) → this is `PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** → this is your WABA ID

### 3c. Get your permanent Access Token

1. Go to **Business Settings** (business.facebook.com) → **System Users** → Add
2. Create a System User with **Admin** role
3. Click **Add Assets** → WhatsApp Accounts → select your WABA → give **Full Control**
4. Click **Generate Token** on the System User → select your app → **generate**
5. Scopes needed: `whatsapp_business_messaging`, `whatsapp_business_management`
6. Copy the token — this is your `WHATSAPP_ACCESS_TOKEN`

### 3d. Note your App Secret

1. In your Meta app → **Settings** → **Basic**
2. Click **Show** next to **App Secret** → copy it
3. This is your `META_APP_SECRET`

---

## STEP 4 — Deploy to Railway (recommended)

Railway is the easiest. Takes ~5 minutes.

### 4a. Push your code to GitHub

```bash
# On your laptop
unzip WhatSalesAgent_FINAL.zip
cd whatsalesagent2-FINAL
git init
git add .
git commit -m "initial"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOURNAME/whatsalesagent2.git
git push -u origin main
```

### 4b. Deploy on Railway

1. Go to **railway.app** → New Project → **Deploy from GitHub repo**
2. Select your repo → Railway auto-detects Node.js
3. Click **Variables** tab → Add all environment variables (see STEP 5)
4. Railway auto-deploys. Watch logs until you see:
   ```
   WhatSalesAgent2 v2.0.0 — production — port 5000
   Connected to MongoDB
   ```
5. Click **Settings** → **Domains** → **Generate Domain**
6. Your URL will be something like: `https://whatsalesagent2-production.up.railway.app`
   **Save this URL** — you need it for Meta webhook setup.

### Alternative: Render

1. Go to **render.com** → New → **Web Service** → connect your GitHub repo
2. Build command: `npm install`
3. Start command: `node src/app.js`
4. Add environment variables (same as below)
5. Your URL: `https://whatsalesagent2.onrender.com`

---

## STEP 5 — Environment Variables

Set ALL of these in Railway/Render's Variables panel.

```bash
# ── REQUIRED ──────────────────────────────────────────────────────
NODE_ENV=production
PORT=5000

# Your MongoDB Atlas connection string from Step 1
MONGODB_URI=mongodb+srv://whatsalesagent:YOURPASS@cluster0.xxxxx.mongodb.net/whatsalesagent2

# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SUPER_ADMIN_API_KEY=generate_a_long_random_string_here

# Must be exactly 32 characters — generate with:
# node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
ENCRYPTION_KEY=exactly32characterslongstringhere

# ── META WHATSAPP ──────────────────────────────────────────────────
# From Meta App → Settings → Basic → App Secret
META_APP_SECRET=your_meta_app_secret_here

# Make up your own random string — you'll enter this in Meta's dashboard too
META_WEBHOOK_VERIFY_TOKEN=my_random_verify_token_123

# ── AI (recommended) ──────────────────────────────────────────────
GROQ_API_KEY=gsk_your_groq_api_key_here

# ── OPTIONAL ──────────────────────────────────────────────────────
# Your deployment URL (used for CORS, no trailing slash)
BASE_URL=https://whatsalesagent2-production.up.railway.app

# Enable background jobs (abandoned cart, booking reminders, payment reminders)
SCHEDULER_ENABLED=true

# Your admin phone numbers (comma-separated, no +, no spaces)
ADMIN_PHONES=2201234567,2209876543

# Log level: error | warn | info | debug
LOG_LEVEL=info
```

---

## STEP 6 — Configure Meta Webhook

This connects Meta to your server so WhatsApp messages flow in.

1. In your Meta App → **WhatsApp** → **Configuration**
2. Under **Webhook**, click **Edit**:
   - **Callback URL**: `https://YOUR-RAILWAY-URL.up.railway.app/webhook`
   - **Verify Token**: exactly what you put in `META_WEBHOOK_VERIFY_TOKEN`
3. Click **Verify and Save** — Meta calls your webhook and your server responds ✅
4. Under **Webhook Fields**, click **Manage** → enable **messages** → Save

---

## STEP 7 — Connect a Real Phone Number (Production)

When you're ready to go beyond the test number:

1. WhatsApp API → **Phone Numbers** → **Add Phone Number**
2. Enter your WhatsApp Business phone number → verify via SMS/call
3. Once verified, note the new **Phone Number ID**
4. Create a tenant using your admin API:

```bash
curl -X POST https://YOUR-URL/admin/tenants \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_SUPER_ADMIN_API_KEY" \
  -d '{
    "name": "My Restaurant",
    "businessMode": "RESTAURANT",
    "adminPhone": "2201234567",
    "whatsapp": {
      "phoneNumberId": "YOUR_PHONE_NUMBER_ID",
      "accessToken": "YOUR_WHATSAPP_ACCESS_TOKEN"
    }
  }'
```

Response gives you a `tenantId` and `apiKey`. **Save both.**

---

## STEP 8 — Seed Demo Data (optional but recommended to test)

```bash
# On your laptop, from inside whatsalesagent2-FINAL/
npm install
MONGODB_URI="your-atlas-uri" npm run seed
```

This creates 6 demo businesses (restaurant, bakery, salon, fashion, cosmetics, electronics).

---

## STEP 9 — Configure Your Business

```bash
# Set your menu, hours, payment details, etc.
curl -X PUT https://YOUR-URL/business/TENANT_ID \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_TENANT_API_KEY" \
  -d '{
    "name": "My Restaurant",
    "description": "Best food in town",
    "adminPhone": "2201234567",
    "payment": {
      "enabled": true,
      "requireProof": true,
      "wavePhone": "2201234567",
      "currency": "D"
    },
    "menuItems": [
      { "name": "Chicken Rice", "price": 150, "description": "Jollof rice with chicken", "available": true },
      { "name": "Fish Soup", "price": 120, "description": "Fresh fish soup", "available": true }
    ],
    "faq": [
      { "trigger": "hours,open", "reply": "We are open 8am–10pm daily" },
      { "trigger": "location,where", "reply": "We are on Kairaba Avenue, Serrekunda" }
    ]
  }'
```

---

## STEP 10 — Test It

### With the Meta test number (no real phone needed yet):

1. Meta Dashboard → **WhatsApp** → **API Setup**
2. Under **Send and receive messages**, click **Send message** to your personal WhatsApp
3. Type "Hi" — your bot should respond

### With real WhatsApp:

Send "Hi" to your WhatsApp Business number. The bot responds.

---

## Admin Commands (send via WhatsApp as the admin)

Once orders/bookings come in, manage them from your phone:

```
APPROVE ABC123          ← approve a payment proof
REJECT ABC123           ← reject a payment proof  
CONFIRM BOOK ABC123     ← confirm a booking
DECLINE BOOK ABC123 Not available that day  ← decline with reason
RESUME BOT 2201234567   ← end human-handoff mode for a customer
```

---

## Dashboard API Reference

All dashboard routes require your tenant API key: `x-api-key: YOUR_TENANT_KEY`

```
GET  /dashboard/TENANT_ID/overview          # 30-day summary
GET  /dashboard/TENANT_ID/orders            # list orders (?status=pending)
GET  /dashboard/TENANT_ID/bookings          # list bookings
GET  /dashboard/TENANT_ID/analytics         # revenue + counts
GET  /dashboard/TENANT_ID/conversations     # active sessions
GET  /dashboard/TENANT_ID/customers         # customer profiles
PATCH /dashboard/TENANT_ID/conversations/PHONE/human  # toggle human mode
```

---

## Troubleshooting

**Bot doesn't respond at all**
→ Check Railway/Render logs. If you see `[DB] Failed to connect` — check `MONGODB_URI`.
→ If you see `META_APP_SECRET not set` — add the env var.

**Meta webhook verification fails**
→ Your server must be publicly reachable. Check Railway/Render gave you a public URL.
→ `META_WEBHOOK_VERIFY_TOKEN` in your env must match exactly what you entered in Meta.

**"No tenants found" in logs**
→ Run `npm run seed` or create a tenant via `POST /admin/tenants`.

**Messages arrive but bot replies gibberish**
→ `GROQ_API_KEY` may be missing — bot falls back to mock provider. Add the key.

**Orders/bookings not showing in dashboard analytics**
→ This was a schema bug in previous versions — fixed in this build. Analytics now write correctly.

**Payment flow never triggers**
→ Set `payment.enabled: true` in your business config. Previous builds had this field missing from the schema (now fixed).

**Emoji taps (🍔, 📅, ❓) do nothing**
→ Fixed in this build. Previously emoji actions were not mapped to flow actions.

---

## Security Checklist Before Going Live

- [ ] `SUPER_ADMIN_API_KEY` is a long random string (not "change_me")
- [ ] `ENCRYPTION_KEY` is exactly 32 characters
- [ ] `META_APP_SECRET` is set (blocks spoofed webhooks)
- [ ] MongoDB Network Access is restricted to your Railway/Render IP range (optional but better)
- [ ] `SIMULATION_MODE` is NOT set (or set to `false`) in production
- [ ] `SCHEDULER_ENABLED=true` so abandoned cart + booking reminders run
- [ ] `ADMIN_PHONES` contains your real phone number (no leading +)

---

## Multi-Tenant: Adding More Businesses

Each business gets its own API key and phone number:

```bash
# Create tenant
curl -X POST https://YOUR-URL/admin/tenants \
  -H "x-api-key: SUPER_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Golden Bakery", "businessMode": "BAKERY", "adminPhone": "2209999999",
        "whatsapp": { "phoneNumberId": "PHONE_ID_2", "accessToken": "TOKEN_2" } }'

# Suspend a tenant
curl -X PATCH https://YOUR-URL/admin/tenants/TENANT_ID/status \
  -H "x-api-key: SUPER_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "status": "SUSPENDED" }'

# List all tenants
curl https://YOUR-URL/admin/tenants \
  -H "x-api-key: SUPER_ADMIN_KEY"
```

Valid statuses: `ACTIVE`, `PENDING`, `SUSPENDED`, `INACTIVE`

---

*Built with WhatSalesAgent2 — AI WhatsApp Business Platform*
