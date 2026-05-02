# WhatsBotLyn v03 — Bug Fix Integration Guide

All 9 missing/incomplete items from the audit have been implemented.
Below is how each file maps to each fix and how to integrate them.

---

## Fix Summary

| # | Issue | File(s) Changed |
|---|-------|----------------|
| 1 | Business hours enforcement | `webhookController.js` |
| 2 | Order/Booking retrieval API | `routes/businessRoutes.js`, `controllers/ordersController.js` |
| 3 | Cold start recovery message | `webhookController.js` |
| 4 | Webhook deduplication (wamid) | `webhookController.js` |
| 5 | Token expiry detection | `services/messageService.js` |
| 6 | "Done." raw string bug | `webhookController.js` |
| 7 | Bot OFF per business hours | `webhookController.js` (same as Fix 1) |
| 8 | FAQ map / custom Q&A | `services/faqService.js`, `services/groqService.patch.js`, `config/BusinessConfig.js` |
| 9 | Persistent failed message log | `models/FailedMessage.js`, `services/messageService.js`, `controllers/ordersController.js` |

---

## Integration Steps

### Step 1 — Copy new files into your project

```
fixes/controllers/webhookController.js   → src/controllers/webhookController.js
fixes/controllers/ordersController.js    → src/controllers/ordersController.js  (new)
fixes/services/messageService.js         → src/services/messageService.js
fixes/services/faqService.js             → src/services/faqService.js           (new)
fixes/models/FailedMessage.js            → src/models/FailedMessage.js          (new)
fixes/routes/businessRoutes.js           → src/routes/businessRoutes.js         (merge)
fixes/config/BusinessConfig.js           → reference only — merge fields
```

### Step 2 — Apply groqService patch

Open `src/services/groqService.js` and make these 3 changes:

1. **Add import** at the top:
   ```js
   const { resolveFaq, buildFaqContext } = require('./faqService');
   ```

2. **Add FAQ short-circuit** at the start of `processMessage()`:
   ```js
   const faqReply = resolveFaq(messageText, business);
   if (faqReply) return { type: 'FAQ', message: faqReply };
   ```

3. **Replace the loose `customMessages` dump** in `buildSystemPrompt()` with:
   ```js
   const faqContext = buildFaqContext(business);
   // ... include faqContext in the prompt string
   ```

### Step 3 — Add routes to app.js

```js
const businessRoutes = require('./routes/businessRoutes');
const adminRoutes    = require('./routes/adminRoutes'); // if separate

// Authenticated business owner routes
app.use('/business', authMiddleware, businessRoutes);

// Admin replay endpoints (add to existing admin router or new one)
app.get('/admin/failed-messages',       authMiddleware, ordersController.listFailedMessages);
app.post('/admin/failed-messages/:id/replay', authMiddleware, ordersController.replayFailedMessage);
```

### Step 4 — Add faq field to your Business/Tenant Mongoose schema

```js
// In your existing schema file, add:
faq: [
  {
    trigger: { type: String, required: true },
    reply:   { type: String, required: true },
    enabled: { type: Boolean, default: true },
  }
]
```

### Step 5 — Install json2csv (needed for CSV export)

```bash
npm install json2csv
```

### Step 6 — Verify environment variables

The following must be set:
```
WEBHOOK_VERIFY_TOKEN=...     # already exists
WA_API_VERSION=v18.0         # optional, defaults to v18.0
```

---

## Behavior Changes by Fix

### Fix 1 & 7 — Business Hours
- When `business.hours.enabled = true` and the current time is outside `open`/`close`, the bot sends `closedMessage` and stops.
- Per-day overrides via `hours.days.monday = false` etc. are respected.
- Timezone-aware using `hours.timezone` (IANA, e.g. `"Africa/Banjul"`).

### Fix 2 — Order/Booking API
- `GET /business/orders` — paginated list with optional `status`, `from`, `to` filters.
- `GET /business/orders/:id` — single order.
- `GET /business/orders/export` — CSV download.
- Same 3 endpoints for `/business/bookings`.

### Fix 3 — Cold Start Recovery
- If a customer sends an unrecognised message after their session expired (e.g. `"jollof rice"` with no active session), they receive: *"Your session has expired. Please type Order or Book to start again…"* before the brain processes the message.

### Fix 4 — Webhook Deduplication
- Incoming messages are deduplicated by `wamid` (WhatsApp message ID) using an in-memory TTL map with 5-minute expiry.
- For multi-process deployments, replace `processedWamids` Map with a Redis SET with TTL.

### Fix 5 — Token Expiry
- 401 responses from the Graph API trigger: admin WhatsApp alert + `FailedMessage` record + no retry.
- `tokenUpdatedAt` on the Tenant model can be used in future to proactively warn before expiry.

### Fix 6 — "Done." Bug
- `handleConfirm()` no longer returns the raw string `"Done."`.
- Unknown `currentFlow` now clears the session and sends `buildWelcome(business)`.

### Fix 8 — FAQ
- Business owners can add FAQ entries to `business.faq` array: `{ trigger: "wifi", reply: "Password is GuestPass" }`.
- Comma-separated triggers supported: `"wifi, wi-fi, password"`.
- FAQ is checked before Groq — matching entries are returned instantly, saving API calls.

### Fix 9 — Persistent Failed Messages
- All terminal send failures write a `FailedMessage` document to MongoDB.
- Admin can list unplayed failures at `GET /admin/failed-messages`.
- Admin can replay individual messages at `POST /admin/failed-messages/:id/replay`.
