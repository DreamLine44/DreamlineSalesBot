# DreamLine SalesBot — Deployment Guide

## Table of Contents
1. [Railway (Recommended)](#railway)
2. [Render](#render)
3. [VPS / Ubuntu (PM2)](#vps-ubuntu-with-pm2)
4. [Environment Variables Reference](#environment-variables)
5. [Meta WhatsApp Integration (Phase 5)](#meta-whatsapp-integration)
6. [MongoDB Atlas Setup](#mongodb-atlas)
7. [Post-Deploy Checklist](#post-deploy-checklist)

---

## Railway

Railway is the easiest host for this bot. Zero config, auto-detects Node.js.

### Steps

1. **Push to GitHub** (create a private repo)

2. **Connect to Railway**
   - Go to https://railway.app → New Project → Deploy from GitHub
   - Select your repo

3. **Add environment variables** in Railway dashboard → Variables:

   ```
   NODE_ENV=production
   PORT=5000                              ← Railway ignores this; sets its own
   MONGODB_URI=mongodb+srv://...          ← from MongoDB Atlas
   SUPER_ADMIN_API_KEY=...               ← from npm run setup output
   ENCRYPTION_KEY=...                    ← 64 hex chars
   OPENAI_API_KEY=sk-...
   GROQ_API_KEY=gsk_...                  ← optional fallback
   BASE_URL=https://your-app.railway.app
   CORS_ORIGIN=https://your-dashboard.com
   SIMULATION_MODE=false                  ← IMPORTANT: false in production
   META_APP_SECRET=...                   ← fill in Phase 5
   META_WEBHOOK_VERIFY_TOKEN=...         ← fill in Phase 5
   ```

4. **Deploy** — Railway auto-runs `npm start` (which runs `node app.js`)

5. **Check health**: `https://your-app.railway.app/health`

---

## Render

1. New Web Service → connect GitHub repo
2. Build Command: `npm install`
3. Start Command: `node app.js`
4. Add environment variables in Render dashboard (same as Railway above)
5. Set **Health Check Path**: `/health`

---

## VPS / Ubuntu with PM2

Use this for DigitalOcean, Hetzner, AWS EC2, or any VPS.

### 1. Server setup

```bash
# Install Node.js 18+ via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 18
nvm use 18

# Install PM2 globally
npm install -g pm2
```

### 2. Deploy the app

```bash
# Clone or copy files to server
cd /var/www/
git clone https://github.com/yourname/dreamline-salesbot.git
cd dreamline-salesbot

# Install dependencies
npm install --production

# Create your env file
cp .env.example .env.production.local
nano .env.production.local   # fill in all values
```

### 3. Start with PM2

```bash
# Start production instance
pm2 start ecosystem.config.cjs --env production

# Save process list (survives reboot)
pm2 save

# Auto-start on server reboot
pm2 startup
# Run the command PM2 outputs (e.g. sudo env PATH=... pm2 startup systemd ...)

# Check status
pm2 status
pm2 logs dreamline-salesbot
```

### 4. Nginx reverse proxy (required for HTTPS)

Install nginx and certbot:

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

Create `/etc/nginx/sites-available/dreamline`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass         http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 5m;
    }
}
```

Enable and get SSL:

```bash
sudo ln -s /etc/nginx/sites-available/dreamline /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
```

### 5. Deploy updates

```bash
cd /var/www/dreamline-salesbot
git pull
npm install --production
pm2 reload dreamline-salesbot   # zero-downtime reload
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | Yes | `production` or `development` |
| `PORT` | No | HTTP port (default 5000; Railway/Render set this automatically) |
| `MONGODB_URI` | **Yes** | MongoDB connection string |
| `SUPER_ADMIN_API_KEY` | **Yes** | Protects /admin/* and /platform/* routes |
| `ENCRYPTION_KEY` | **Yes (prod)** | 64 hex chars for AES-256 token encryption |
| `OPENAI_API_KEY` | Recommended | Primary AI provider |
| `GROQ_API_KEY` | Optional | Fallback AI (free tier) |
| `BASE_URL` | Yes | Your full deployment URL, e.g. `https://mybot.railway.app` |
| `CORS_ORIGIN` | Yes (prod) | Comma-separated allowed browser origins |
| `SIMULATION_MODE` | No | `false` in production, `true` for local testing |
| `META_APP_SECRET` | Phase 5 | Webhook signature verification |
| `META_WEBHOOK_VERIFY_TOKEN` | Phase 5 | Webhook challenge |
| `SESSION_TTL_MINUTES` | No | Session timeout minutes (default 30) |
| `PAYMENT_SESSION_TTL_HOURS` | No | Payment session timeout (default 4) |
| `LOG_LEVEL` | No | `info` (prod) or `debug` (dev) |

---

## Meta WhatsApp Integration

**Only do this after your bot logic is fully tested locally.**

### Step 1: Create a Meta App
1. Go to https://developers.facebook.com/apps/
2. Create App → Business → Add WhatsApp product
3. Copy `App ID` → `META_APP_ID`
4. Copy `App Secret` → `META_APP_SECRET`

### Step 2: Set up webhook
1. In Meta dashboard → WhatsApp → Configuration
2. Webhook URL: `https://your-domain.com/webhook`
3. Verify token: set `META_WEBHOOK_VERIFY_TOKEN` to any secret string
4. Subscribe to messages, message_deliveries, message_reads

### Step 3: Get phone number credentials
1. Go to WhatsApp → API Setup
2. Copy Phone Number ID → `META_PHONE_NUMBER_ID`
3. Generate a permanent token → `META_WHATSAPP_TOKEN`
4. Set `META_API_VERSION=v21.0`

### Step 4: Run seed to register tenant
```bash
npm run seed
```

### Step 5: Test
Send a WhatsApp message to your number. Check `pm2 logs` or Railway logs.

---

## MongoDB Atlas

Free-tier cluster setup:

1. Go to https://www.mongodb.com/cloud/atlas
2. Create free M0 cluster (512 MB — enough for hundreds of businesses)
3. Database Access → Add user with read/write privileges
4. Network Access → Add IP: `0.0.0.0/0` (allow all) or your server IP
5. Connect → Drivers → copy connection string
6. Replace `<password>` with your password in the URI
7. Set as `MONGODB_URI` in your env

Connection string format:
```
mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/dreamline_bot?retryWrites=true&w=majority
```

---

## Post-Deploy Checklist

After deploying, verify each item:

- [ ] `GET /health` returns `{"status":"ok"}`
- [ ] `SIMULATION_MODE=false` in production env
- [ ] `ENCRYPTION_KEY` is set (64 hex chars)
- [ ] `CORS_ORIGIN` includes your dashboard URL
- [ ] MongoDB Atlas IP whitelist includes your server IP (or 0.0.0.0/0)
- [ ] `META_APP_SECRET` is set before going live with WhatsApp
- [ ] Logs are clean: `pm2 logs dreamline-salesbot` or Railway/Render log viewer
- [ ] Run `npm run migrate-apikey` if upgrading from v22 or earlier
- [ ] Run `npm run migrate-encrypt` if upgrading from v22 or earlier
- [ ] Set `APIKEY_MIGRATION_DONE=true` after migrations complete

---

## Troubleshooting

**Bot not responding on WhatsApp:**
- Check webhook URL is correct and HTTPS
- Verify `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` are set
- Check `pm2 logs` or platform logs for errors

**MongoDB connection refused:**
- Atlas: check Network Access IP whitelist
- Local: ensure `mongod` is running

**CORS errors in browser:**
- Set `CORS_ORIGIN` to your dashboard URL (e.g. `https://admin.mybot.com`)

**`ENCRYPTION_KEY` warning in logs:**
- Generate: `node -e "import('crypto').then(c=>console.log(c.randomBytes(32).toString('hex')))"`
- Set in your env and run `npm run migrate-encrypt`

**`SIMULATION_MODE=true` warning in production logs:**
- Set `SIMULATION_MODE=false` in your production environment variables
