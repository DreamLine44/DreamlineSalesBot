# WhatsBotLyn v5.0 — Upgrade Notes

## What Changed

### 🤖 Groq AI (FULLY ACTIVE)
- **Model cascade**: tries `llama-3.1-8b-instant` first (fastest), auto-falls back to `llama-3.3-70b-versatile`
- **Health check on startup**: validates API key is live BEFORE first customer message arrives
- **Auto-retry**: exponential back-off on 429/5xx errors (max 2 retries per model)
- **Structured logging**: every Groq call logs model used, latency, tokens
- **Graceful degradation**: if Groq is unreachable, returns smart "Order / Book" fallback (not a crash)
- **`GROQ_API_KEY` is now REQUIRED in production** — server won't start without it

### 📋 Onboarding (Improved)
- Step 2 (bot config) no longer requires WhatsApp to be connected first
- Businesses can set up menu, hours, payment WHILE waiting for Meta approval
- Status endpoint now returns % complete + per-step sub-checks
- Duplicate email gives actionable hint (not just "already exists")
- Valid modes documented in response: `ORDER`, `BOOKING`, `BOTH`, `RETAIL`
- Step 2 sample body now includes `payment` and `hours` fields

### 💳 Payment (Fully Active)
- Payment reference format: `WBL-MMDD-XXXX` (easier for admin tracking)
- `initiatePayment` is now idempotent (safe to call twice)
- `receiveProof` ignores orders older than 24h (prevents ghost submissions)
- `DONE` keyword support for businesses with `requireProof: false`
- `getPendingPayments` returns `minutesPending` for each order
- Payment proof now routed through `paymentService.receiveProof()` (consistent)

### 🔄 Flows (Improved)
- `looksLikeDate` now recognises ordinal dates: `6th`, `1st of June`, etc.
- All session loop guards preserved
- CANCEL at CONFIRM step correctly goes through flowService (not brain short-circuit)

### 🔒 Security
- Production startup refuses to run without `META_APP_SECRET`, `SUPER_ADMIN_API_KEY`, `MONGODB_URI`, `GROQ_API_KEY`
- Webhook signature verification unchanged (HMAC-SHA256)

---

## Migration from v4.x

1. Update your `.env` file — copy `.env.development.local.example`
2. Make sure `GROQ_API_KEY` is set (get free key at https://console.groq.com)
3. Run `npm install` (no new dependencies)
4. Start with `npm run dev` and check logs for `[Groq] Ready`

## Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `GROQ_API_KEY` | ✅ Prod / optional Dev | Get free at console.groq.com |
| `META_APP_SECRET` | ✅ Prod | For webhook signature verification |
| `SUPER_ADMIN_API_KEY` | ✅ Prod | Generate with `npm run gen-key` |
| `MONGODB_URI` | ✅ Always | Atlas connection string |
| `META_WHATSAPP_TOKEN` | Stored per-tenant | Only needed for single-tenant dev |
| `META_PHONE_NUMBER_ID` | Stored per-tenant | Only needed for single-tenant dev |
