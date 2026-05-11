# Dreamline Sales Bot v11.0 — Upgrade Guide

Multi-tenant WhatsApp Business SaaS Platform — v11.0

---

## What's New in v11

| Feature | File | Details |
|---------|------|---------|
| **Conversation history (multi-turn AI)** | `services/groqService.js`, `models/Session.js`, `services/sessionService.js` | Groq now receives last 10 messages (5 turns) as context. AI replies are coherent across multi-step support conversations. |
| **WhatsApp template messages** | `services/templateService.js` (new) | Solves the 24h session window. 5 templates: abandoned cart, order confirmed, booking reminder, payment reminder, re-engagement. |
| **Abandoned cart recovery** | `services/schedulerService.js` (new) | Background job finds sessions that expired with pending orders and sends a WhatsApp follow-up template. |
| **Booking day-before reminder** | `services/schedulerService.js` | Sends a WhatsApp appointment reminder the evening before each confirmed booking. |
| **Payment proof nudge** | `services/schedulerService.js` | Reminds customers who placed an order but haven't sent Wave payment proof after 30 minutes. |
| **Credential encryption (AES-256-GCM)** | `services/cryptoService.js` (new), `models/Tenant.js` | WhatsApp `accessToken` encrypted at rest. Transparent pre-save hook + virtual getter. |
| **Soft-delete on orders/bookings** | `models/Order.js`, `models/Booking.js` | `deletedAt` / `deletedBy` fields. Preserves audit trail. No data permanently lost. |
| **Usage limit enforcement** | `controllers/webhookController.js` | Already existed in earlier versions; now documented and verified in the guard chain. |
| **Migration: encrypt tokens** | `scripts/migrate-encrypt-tokens.js` (new) | One-time script encrypts existing plaintext accessTokens. Idempotent and dry-run safe. |

---

## Breaking Changes

None. v11 is fully backward-compatible. All new features are either additive (new fields) or opt-in via env vars.

---

## Upgrade Steps

### 1. Install dependencies (no new packages needed)

```bash
npm install
```

### 2. Set new environment variables

Copy the new vars from `.env.development.local.example`:

```env
ENCRYPTION_KEY=<64 hex chars — generate with npm run gen-key>
TOKEN_ENCRYPTION_ENABLED=false   # set true AFTER running migration
SCHEDULER_ENABLED=false          # set true to activate background jobs
TEMPLATE_LANGUAGE=en_US
```

### 3. Encrypt existing accessTokens (strongly recommended)

```bash
# Preview first (no writes)
DRY_RUN=true npm run migrate-encrypt-tokens

# Apply
npm run migrate-encrypt-tokens

# After verifying bot still works:
# Set TOKEN_ENCRYPTION_ENABLED=true in your .env
```

### 4. Register WhatsApp templates in Meta Business Manager

Templates must be pre-approved by Meta before they can be sent. Register these 5 templates:

| Template name | Use case |
|---|---|
| `dreamline_abandoned_cart` | Abandoned cart recovery |
| `dreamline_order_confirmed` | Post-payment order confirmation |
| `dreamline_booking_reminder` | Day-before appointment reminder |
| `dreamline_payment_reminder` | Payment proof nudge |
| `dreamline_reengagement` | Generic re-engagement |

See template body text in `services/templateService.js` → `TEMPLATE_DEFINITIONS`.

**Template registration steps:**
1. Go to [Meta Business Manager](https://business.facebook.com) → WhatsApp → Message Templates
2. Create each template with the exact body text from `templateService.js`
3. Wait for Meta approval (typically 24-48h for utility templates)
4. Once approved, set `SCHEDULER_ENABLED=true` and restart

### 5. Activate the scheduler

```env
SCHEDULER_ENABLED=true
```

Jobs run on these schedules:
- **Abandoned cart**: every 15 minutes
- **Payment reminder**: every 20 minutes  
- **Booking reminder**: hourly (only runs 18:00–20:00)

### 6. Update MongoDB indexes

No manual index changes needed — all new fields are optional or unindexed.

Soft-delete: add this index for efficient list queries (run in mongosh):
```js
db.orders.createIndex({ tenantId: 1, deletedAt: 1 })
db.bookings.createIndex({ tenantId: 1, deletedAt: 1 })
```

---

## Architecture Changes

### Conversation History Flow

```
Customer WhatsApp message
    ↓
webhookController.js (STEP 12/13)
    ↓
addToHistory(from, tenantId, 'user', messageText)   ← new
    ↓
handleFlow() / groqService.getAIReply()
    ↑
session.conversationHistory → last 10 msgs → injected into Groq API call
    ↓
dispatch(from, reply, tenant)
    ↓
addToHistory(from, tenantId, 'assistant', replyBody) ← new
```

### Template Message Flow

```
Background job (schedulerService.js)
    ↓
Finds stale orders/bookings in MongoDB
    ↓
templateService.sendTemplate()
    ↓
Meta Graph API POST /messages (type: template)
    ↓
Customer's WhatsApp receives approved template message
```

### Encryption Flow

```
onboardingController stores Meta accessToken
    ↓
Tenant.pre('save') → cryptoService.encrypt(token)
    ↓
MongoDB stores: "iv:authTag:ciphertext" (hex-encoded)

messageService reads tenant
    ↓
tenant.decryptedAccessToken virtual getter
    ↓
cryptoService.decrypt() → plaintext token
    ↓
Used in Authorization header for WhatsApp API calls
```

---

## New Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENCRYPTION_KEY` | Recommended | — | 64 hex chars. AES-256-GCM key for accessToken encryption. |
| `TOKEN_ENCRYPTION_ENABLED` | After migration | `false` | Set `true` after running migrate-encrypt-tokens. |
| `SCHEDULER_ENABLED` | Optional | `false` | Set `true` to activate background jobs. |
| `TEMPLATE_LANGUAGE` | Optional | `en_US` | Language code for WhatsApp templates. |
| `TEMPLATE_NAMESPACE` | Optional | — | Meta template namespace (leave blank for default). |

---

## New npm Scripts

```bash
npm run migrate-encrypt-tokens   # Encrypt existing plaintext accessTokens
```

---

## File Manifest — New Files

```
services/
  cryptoService.js          ← AES-256-GCM credential encryption
  templateService.js        ← WhatsApp template message sender (5 templates)
  schedulerService.js       ← Background jobs: abandoned cart, reminders

scripts/
  migrate-encrypt-tokens.js ← One-time accessToken encryption migration

UPGRADE_GUIDE_v11.md        ← This file
```

## File Manifest — Modified Files

```
models/
  Tenant.js         ← Added encrypt/decrypt pre-save hook + virtual getter
  Session.js        ← Added conversationHistory field
  Order.js          ← Added deletedAt, deletedBy, abandonedCartAt, paymentReminderSentAt
  Booking.js        ← Added deletedAt, deletedBy, reminderSentAt

services/
  groqService.js         ← Inject conversation history into Groq API calls
  messageService.js      ← Use tenant.decryptedAccessToken
  sessionService.js      ← Added addToHistory() export

controllers/
  webhookController.js   ← Import addToHistory, wire history tracking post-dispatch

app.js                   ← Import + call startScheduler() after DB connect
package.json             ← Version 11.0.0, new migrate-encrypt-tokens script
.env.development.local.example  ← New v11 env vars documented
```
