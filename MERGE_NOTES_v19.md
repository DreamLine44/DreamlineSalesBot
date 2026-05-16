# DreamlineSalesBot v19.0 — Perfect Merge (v14 + v18)

## What this is
A clean, conflict-free merge of **DreamlineSalesBot_v14** (May 15) and **DreamlineSalesBot_v18_combined** (May 12).
Each file was individually reviewed; the version with the most complete implementation was selected.

---

## File-by-file merge decisions

### Base: v18_combined
v18 was used as the base because it is the more feature-complete codebase for most files.

### Files taken from v14 (v14 had the newer implementation)

| File | Reason |
|------|--------|
| `services/groqService.js` | v14 is v13.0: prompt-injection sanitization, HUMAN_ESCALATION intent, G-3 stricter booking/cancel rules, G-7 timeout raised to 12 s, G-4 max_tokens 280 for ENQUIRY, dynamic currency (not hardcoded 'D') |
| `services/schedulerService.js` | v14 is v13.0: SC-1 batched DB lookups, SC-2 booking date fix, SC-3 48h payment window, SC-4 allSettled for inner loops, SC-5 startup logging |

### Files taken from v18 (v18 had the newer implementation)

| File | Reason |
|------|--------|
| `services/flowService.js` | v18 is v13.0: word-number selection, extended isCancel phrases, upsell cooldown, levenshtein fuzzy match, buildOrderSummaryText, PHRASE_NUMBERS, PAY-F3 anchor |
| `controllers/webhookController.js` | v18: conversationMemoryService (PAY-F3 proof fallback), HUMAN_ESCALATION routing, monthly usage auto-reset, _stepHint 4h TTL, sanitiseWelcomeBody, menu acknowledgement messages |
| `services/paymentService.js` | v18 v13.0: PAY-F1 paymentProof reset on rejection, PAY-F2 payment_failed status query, PAY-F3 conversationMemoryService fallback |
| `services/adminPaymentHandler.js` | v18: encrypted token decryption, RESUME BOT admin WhatsApp command, admin confirmation workflow |
| `services/sessionService.js` | v18 v13.0: SES-1 4h TTL for PAYMENT_PROOF step, SES-2 _stepHint option |
| `app.js` | v18: graceful shutdown (SIGTERM/SIGINT), MongoDB connection cleanup, scheduler stop on exit |
| `controllers/onboardingController.js` | v18: encrypts accessToken at rest |
| `services/leadCaptureService.js` | v18: direct tenantId query (no session join), ObjectId-typed tenantId, .lean() |
| `utils/messageBuilders.js` | v18: exports sanitiseWelcomeBody (used by webhookController), personalised cancelUI with business name |
| `utils/matchEngine.js` | v18: latest revision |
| `utils/sanitize.js` | v18-only file: prompt-injection sanitizer used by groqService |
| `services/conversationMemoryService.js` | v18-only: persistent order memory across session expiry for proof uploads |
| `models/UserProfile.js` | v18: ObjectId tenantId with proper index; fixes lead isolation across tenants |

### Files merged (best of both)

| File | What was merged |
|------|----------------|
| `models/Booking.js` | v18 base (customerName, partySize, admin confirmation workflow) + v14's `parsedDate` field for accurate scheduler reminder timing |
| `package.json` | v18 version/test scripts + v14's dev/seed/utility scripts (gen-key, fix-orders, migrate-*) |

### Unchanged (identical in both versions)
All other files (routes, middlewares, config, other models, scripts, utils/helpers, utils/phraseEngine, static assets) were identical between v14 and v18 and were taken as-is.

---

## New in v19.0 (neither version had this alone)

- `models/Booking.js` now has **both** `parsedDate` (v14) and `customerName`/`partySize`/`adminConfirmation` (v18)
- `package.json` has the **complete script set** from both versions
- Version bumped to `19.0.0` to reflect the merged state

