# Webhook & Meta Dashboard Setup Guide

## The #1 Mistake (Root Cause of All Failures)

There are **two separate URLs** in Meta developer dashboard that are easy to confuse:

| URL | Purpose | Where to set it |
|-----|---------|----------------|
| `/webhook` | Receives WhatsApp messages + webhook verification | Meta dashboard → Use cases → Connect on WhatsApp → Configuration → Callback URL |
| `/onboarding/callback` | OAuth redirect after Embedded Signup | Meta dashboard → App Settings → Basic → Valid OAuth Redirect URIs |

**Setting `/onboarding/callback` as the webhook Callback URL is what causes the "callback URL or verify token couldn't be validated" error.**

---

## Correct Meta Dashboard Configuration

### Step 1 — Webhook (Configuration tab)
- **Callback URL:** `https://your-domain.com/webhook`
- **Verify Token:** value of your `META_WEBHOOK_VERIFY_TOKEN` env var

### Step 2 — OAuth Redirect URI (App Settings → Basic)
- **Valid OAuth Redirect URIs:** `https://your-domain.com/onboarding/callback`

---

## Local Development Setup

### 1. Ngrok
```bash
ngrok http --domain=awoke-ahead-boxer.ngrok-free.dev 5000
```

### 2. Meta dashboard webhook (for local testing)
- **Callback URL:** `https://awoke-ahead-boxer.ngrok-free.dev/webhook`
- **Verify Token:** `DreamLineBot2425`

### 3. Required `.env.development.local` values
```dotenv
META_APP_ID=1221180509938842
META_APP_SECRET=<get from App Settings → Basic>
META_WEBHOOK_VERIFY_TOKEN=DreamLineBot2425
META_REDIRECT_URI=https://awoke-ahead-boxer.ngrok-free.dev/onboarding/callback
BASE_URL=https://awoke-ahead-boxer.ngrok-free.dev
SKIP_WEBHOOK_SIGNATURE=true   # dev only — skips HMAC check for curl/Bruno testing
```

### 4. Onboard a tenant (after server starts)
```bash
curl -X PUT http://localhost:5000/register/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumberId": "1113468071851748",
    "accessToken": "<your permanent token>",
    "wabaId": "1515918663392133",
    "email": "admin@yourdomain.com"
  }'
```
Save the `apiKey` returned — you need it for Step 2.

---

## Render (Production) Setup

### Environment variables
Make sure Render has:
```
META_APP_ID=1221180509938842
META_APP_SECRET=<real secret>
META_WEBHOOK_VERIFY_TOKEN=DreamLineBot2425
META_REDIRECT_URI=https://salesbot-o0cg.onrender.com/onboarding/callback
BASE_URL=https://salesbot-o0cg.onrender.com
```
**No `SKIP_WEBHOOK_SIGNATURE` in production.**

### Meta dashboard webhook (Render)
- **Callback URL:** `https://salesbot-o0cg.onrender.com/webhook`
- **Verify Token:** `DreamLineBot2425`

---

## Bot Behaviour — When Does It Respond?

The bot **ONLY** responds when a customer sends a message first. It never:
- Sends proactive or scheduled messages
- Replies to its own outbound messages (echo guard added)
- Responds to system events or emoji reactions
- Initiates conversations

This is enforced in `controllers/webhookController.js` via:
1. `value.statuses` filter — skips delivery/read receipts
2. `skipTypes` guard — skips `message_echo`, `system`, `reaction`
3. `context.from` guard — skips echoes of bot's own messages
