# Dreamline Sales Bot v10 — Integration Guide

Multi-tenant WhatsApp Business SaaS Platform.

---

## What's New in v10

| Feature | Details |
|---------|---------|
| Revenue Engine | Upsell add-ons after order summary, revenue analytics tracking |
| Admin Payment Flow | WhatsApp-native Approve/Reject buttons for Wave payment verification |
| Cloudinary Image Uploads | Menu item images sent to customers on selection |
| Groq AI (model cascade) | `llama-3.1-8b-instant` → `llama-3.3-70b-versatile` failover |
| Atomic deduplication | `ProcessedMessage` collection prevents duplicate webhook processing |
| Full CRUD for orders/bookings | PATCH + DELETE endpoints for admin management |
| Platform notify | `POST /platform/tenants/:id/notify` — push WhatsApp message to any tenant's admin |
| shortId indexing | O(1) admin command lookups (`APPROVE ABC123`) via indexed `shortId` field |
| API key hashing | SHA-256 hashed keys — run `npm run migrate-apikey` then set `APIKEY_MIGRATION_DONE=true` |

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment

```bash
cp .env.development.local.example .env.development.local
# Edit .env.development.local and fill in your values
```

Required vars for development:

```
MONGODB_URI=mongodb://127.0.0.1:27017/DreamlineSalesBot?replicaSet=rs0
SUPER_ADMIN_API_KEY=<generate with: npm run gen-key>
META_APP_SECRET=<from Meta Developer Console>
META_WHATSAPP_TOKEN=<from Meta Developer Console>
META_PHONE_NUMBER_ID=<from Meta Developer Console>
GROQ_API_KEY=<from https://console.groq.com — free>
```

### 3. Seed the database (development only)

```bash
npm run seed
```

This creates a tenant + BusinessConfig and drops the stale `key_1` session index if present.

### 4. Run migrations (first deploy or upgrade)

```bash
# Hash existing plaintext API keys
npm run migrate-apikey

# Back-fill shortId on existing orders (for admin APPROVE/REJECT commands)
npm run migrate-shortid
```

After running `migrate-apikey`, set `APIKEY_MIGRATION_DONE=true` in your env to disable the plaintext fallback.

### 5. Start the server

```bash
npm run dev   # development (nodemon + debug logging)
npm start     # production
```

---

## Onboarding Flows

### Simple (2 requests)

```
PUT  /register/whatsapp     → Step 1: validate Meta credentials + create tenant → returns apiKey (ONCE)
POST /register/business     → Step 2: configure bot (requires x-api-key header)
GET  /register/status       → check onboarding progress (requires x-api-key)
```

### Unified (1 request)

```
POST /register/full         → Step 1 + 2 combined → returns apiKey (ONCE)
```

### Meta Embedded Signup (OAuth)

```
GET  /onboarding/callback   → Meta redirects here after user grants access
GET  /register/callback     → Same handler, aliased for backward compat
```

### Legacy (backward compat)

```
POST /register              → Old email/name-first registration
```

---

## Route Reference

### Webhook
```
GET  /webhook                  → Meta webhook verification (bare URL)
GET  /webhook/:phoneNumberId   → Meta webhook verification (phone-scoped)
POST /webhook                  → Incoming messages
POST /webhook/:phoneNumberId   → Incoming messages (phone-scoped)
```

### Business Config (requires x-api-key)
```
POST   /business                        → Create business config
GET    /business                        → Get business config
PUT    /business                        → Update business config
GET    /business/analytics              → Analytics summary
POST   /business/human-mode            → Toggle human mode { phone, active: bool }
POST   /business/apply-mode            → Apply mode preset { mode: RESTAURANT|SALON|RETAIL }
GET    /business/setup-checklist        → Setup completion status
GET    /business/default-config?mode=  → Starter config template

POST   /business/menu                   → Update full menu array
POST   /business/menu/upload-image      → Upload menu item image (multipart, field: image)
POST   /business/hours                  → Update business hours
POST   /business/payment               → Update payment config
POST   /business/faq                   → Update FAQ entries
POST   /business/settings              → Update settings/tone/nlp/botEnabled

GET    /business/orders                 → List orders (paginated)
GET    /business/orders/export          → CSV export
GET    /business/orders/pending-payment → Orders awaiting Wave verification
GET    /business/orders/:id             → Single order
PATCH  /business/orders/:id             → Update order (status, paymentStatus, notes)
DELETE /business/orders/:id             → Delete order
POST   /business/orders/:id/confirm-payment → Confirm Wave payment
POST   /business/orders/:id/reject-payment  → Reject Wave payment

GET    /business/bookings               → List bookings (paginated)
GET    /business/bookings/export        → CSV export
GET    /business/bookings/:id           → Single booking
PATCH  /business/bookings/:id           → Update booking (status, date, time, notes)
DELETE /business/bookings/:id           → Delete booking
```

### Dashboard (requires x-api-key, allows PENDING tenants)
```
GET    /dashboard                → Overview summary
GET    /dashboard/profile        → Tenant profile
PUT    /dashboard/profile        → Update name/adminPhone
GET    /dashboard/bot            → Business config
PUT    /dashboard/bot            → Update bot config
PUT    /dashboard/bot/menu       → Replace full menu
POST   /dashboard/bot/menu       → Add menu item
DELETE /dashboard/bot/menu/:id   → Remove menu item
PUT    /dashboard/bot/hours      → Update hours
POST   /dashboard/bot/faq        → Add FAQ entry
DELETE /dashboard/bot/faq/:id    → Remove FAQ entry
GET    /dashboard/stats          → Orders/bookings/revenue stats
POST   /dashboard/rotate-key     → Generate new API key
```

### Platform (requires SUPER_ADMIN_API_KEY)
```
GET    /platform/stats                  → Platform-wide stats
POST   /platform/reset-usage            → Reset monthly usage counters
GET    /platform/tenants                → List tenants (paginated, filterable)
GET    /platform/tenants/:id            → Tenant detail
PUT    /platform/tenants/:id/plan       → Change plan { plan: FREE|STARTER|PRO|ENTERPRISE }
PUT    /platform/tenants/:id/status     → Change status { status: ACTIVE|SUSPENDED|PENDING }
POST   /platform/tenants/:id/notify     → Send WhatsApp message to tenant's admin { message }
```

### Admin Tenant Management (requires SUPER_ADMIN_API_KEY)
```
GET    /admin/tenants/                      → List all tenants
POST   /admin/tenants/register              → Register new tenant
POST   /admin/tenants/:id/connect-whatsapp  → Connect WhatsApp manually
GET    /admin/tenants/:id                   → Get tenant
PUT    /admin/tenants/:id                   → Update tenant
POST   /admin/tenants/:id/rotate-key        → Rotate API key
PUT    /admin/tenants/:id/status            → Set status
DELETE /admin/tenants/:id                   → Delete tenant + all data
```

### Admin Messages (requires x-api-key)
```
GET    /admin/messages/failed-messages            → List unreplayed failed messages
POST   /admin/messages/failed-messages/:id/replay → Replay a failed message
```

---

## Business Modes

| Mode | Flows | Use Case |
|------|-------|----------|
| `RESTAURANT` | ORDER + BOOKING | Food ordering + table reservations |
| `SALON` | BOOKING only | Appointment booking |
| `RETAIL` | ORDER only | Product/item sales |

Set via `POST /business/apply-mode` with `{ mode: "RESTAURANT" }`.

---

## Payment Flow (Wave Mobile Money)

1. Customer confirms order → bot sends Wave payment instructions
2. Customer sends payment screenshot → `receiveProof()` stores it
3. Admin receives WhatsApp notification with Approve/Reject buttons
4. Admin taps button (or types `APPROVE <shortId>` / `REJECT <shortId>`)
5. Customer receives real-time confirmation

Configure Wave phone: `POST /business/payment` with `{ payment: { wavePhone: "2207XXXXXX" } }`.

---

## Environment Variables

See `.env.development.local.example` and `.env.production.local.example` for the full list.

Key vars:

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` | ✅ | MongoDB connection string |
| `SUPER_ADMIN_API_KEY` | ✅ | Platform-owner API key |
| `META_APP_SECRET` | ✅ (prod) | HMAC webhook signature verification |
| `GROQ_API_KEY` | Recommended | AI fallback replies |
| `CLOUDINARY_*` | Optional | Menu image uploads |
| `ADMIN_PHONES` | Optional | Global admin phone list for payment alerts |
| `SKIP_WEBHOOK_SIGNATURE` | Dev only | Skip HMAC check for local testing |
| `APIKEY_MIGRATION_DONE` | After migration | Disable plaintext API key fallback |

---

## MongoDB — First Deploy Notes

The `key_1` index on the `sessions` collection is a stale artifact from an older schema version. Run `npm run seed` once (dev) or manually drop it in production:

```js
// In mongosh:
db.sessions.dropIndex("key_1")
```

All other required indexes are defined in the Mongoose schemas and created automatically on first connect.

---

## Scripts

```bash
npm start                       # Start production server
npm run dev                     # Start with nodemon (auto-restart)
npm run seed                    # Seed dev database
npm run gen-key                 # Generate a new random API key
npm run migrate-apikey          # Hash existing plaintext API keys → apiKeyHash
npm run migrate-shortid         # Back-fill shortId on existing orders
npm run fix-orders              # Fix order compound index issues
npm run fix-phonenumber-index   # Fix phoneNumberId index issues
```
