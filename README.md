# DreamLine SalesBot — v16.0.0 (Combined Final)

**This is the authoritative combined release** merging all three sources:
- `DreamlineSalesBot_v13` — targeted patch package
- `DreamlineSalesBot_v14_fixed` — full codebase with v13 patches applied
- `DreamlineSalesBot_v14` — parallel branch with additional production hardening

> **Result:** v13 was fully applied inside v14_fixed (verified by clean diffs). The new v14 (original branch) was a parallel effort — all its unique fixes were already in v14_fixed except two: `package-lock.json` and the `UPSELL_COOLDOWN_MAX` eviction cap in `flowService.js`. Both are now included.

---

## What's in this build

### From v14_fixed (full codebase)
Full multi-tenant WhatsApp SalesBot with:
- 10 industry modes (`config/modes.js`)
- Groq AI integration with strict flow boundaries
- Deterministic intent engine (v7 philosophy)
- Analytics, scheduling, smart recommendations
- Lead capture, revenue engine, learning service
- Admin dashboard, orders, tenant management
- Onboarding flow + HTML onboarding UI
- Circuit breaker, message deduplication, rate limiting
- MongoDB multi-tenant with full schema

### From v13 patch package (all 4 critical fixes — confirmed applied)

| Fix | What it solves |
|-----|---------------|
| **PAY-F1** | `rejectPayment()` resets `paymentProof → null` so retry uploads work |
| **PAY-F2/F3** | Session-expired proof uploads recovered via `conversationMemoryService` |
| **SES-1** | PAYMENT_PROOF step extends session TTL to 4 hours (Wave payment latency) |
| **Bug-5** | `SUPPORT` intent routes to human handover, not FAQ bot |

### From v13 UX improvements (confirmed applied)

| Improvement | What changed |
|-------------|-------------|
| **Order summary** | Clean `✅ Your Order • Item × qty — GMD 2,400` format |
| **Quantities 11–20** | "twelve", "fifteen", "wan" all parse correctly |
| **Rotating upsell** | 4 natural upsell prompts instead of one static phrase |
| **Support phrases** | 36 triggers covering complaints, payment disputes, delivery, West African expressions |

---

## Quick Start

```bash
npm install
cp .env.development.local.example .env
# Fill in: MONGODB_URI, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
#           META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, GROQ_API_KEY
node seed.js    # Seed demo tenant
node app.js     # Start server
```

## Environment Variables

```env
SESSION_TTL_MINUTES=30          # Standard session TTL (default: 30)
PAYMENT_SESSION_TTL_HOURS=4     # TTL extension for PAYMENT_PROOF step (default: 4)
PROOF_ELIGIBLE_HOURS=48         # Hours an order can receive a proof upload (default: 48)
```

## Key Flows to Test After Deploy

- [ ] Order → Wave payment → screenshot → proof received ✅
- [ ] Order → wait 35 min (session expires) → screenshot → memory fallback works ✅
- [ ] Order → proof received → admin rejects → resend screenshot → second proof accepted ✅
- [ ] Type "complaint" → humanMode set, admin notified (not FAQ bot) ✅
- [ ] Type "twelve" → quantity 12 parsed ✅
- [ ] Order summary shows `✅ Your Order • Item × 12 — GMD 2,400` format ✅

## File Structure

```
├── app.js                        # Express entry point
├── seed.js                       # Demo tenant seeder
├── config/
│   ├── modes.js                  # 10 industry mode definitions
│   ├── database.js               # MongoDB connection
│   ├── logger.js                 # Winston logger
│   └── env.js                    # Env validation
├── controllers/
│   ├── webhookController.js      # Main WhatsApp webhook handler
│   ├── onboardingController.js   # Tenant onboarding
│   ├── businessController.js     # Business config CRUD
│   ├── dashboardController.js    # Admin dashboard
│   ├── ordersController.js       # Order management
│   ├── tenantController.js       # Tenant management
│   └── platformController.js     # Platform admin
├── services/
│   ├── brainService.js           # Intent engine
│   ├── flowService.js            # Conversation state machine
│   ├── paymentService.js         # Payment + proof handling (v13 fixes)
│   ├── sessionService.js         # Session management (4h TTL)
│   ├── conversationMemoryService.js  # Durable order anchoring (v13 new)
│   ├── groqService.js            # Groq AI integration
│   ├── analyticsService.js       # Analytics tracking
│   ├── schedulerService.js       # Scheduled jobs
│   ├── adminPaymentHandler.js    # Admin payment actions
│   ├── messageService.js         # Message dispatch
│   ├── leadCaptureService.js     # Lead management (tenant-scoped)
│   ├── onboardingService.js      # Onboarding logic
│   ├── modePresetService.js      # Industry mode presets
│   ├── smartRecommendationService.js
│   ├── revenueEngineService.js
│   ├── learningService.js
│   ├── templateService.js
│   ├── notificationService.js
│   ├── cryptoService.js
│   ├── faqService.js
│   └── businessService.js
├── models/                       # Mongoose schemas
├── middlewares/                  # Auth, rate limiting, error handling
├── routes/                       # Express routers
├── utils/                        # messageBuilders, matchEngine, phraseEngine
├── scripts/                      # DB migration scripts
└── public/
    └── onboarding.html           # Tenant onboarding UI
```

---

## Lineage

```
v7  (strict intent engine philosophy)
  └─► v11 (multi-tenant, Groq, 10 modes, analytics)
        └─► v12 (Flow Authority, Button-First UX, AI Boundary Hardening)
              └─► v12.1 (Master Spec Compliance — 10 additional UX/state fixes)
                    └─► v13 (4 critical payment/session/support fixes + UX improvements)
                          └─► v14_fixed (3-way merge, all fixes confirmed)
                                └─► v16.0.0 ← YOU ARE HERE (combined + verified)
```

---

## v17.0.0 — Three-way merge + Full Audit (this build)

### Third source merged: `DreamlineSalesBot_v14` (clean lightweight branch)

This branch was a completely different architecture (in-memory sessions, flows/ pattern, CommonJS, no MongoDB). Rather than a structural merge, the genuinely better pieces were extracted and integrated:

| Extracted from v14 clean branch | What it improves |
|---------------------------------|-----------------|
| **PHRASE_NUMBERS** | `parseQuantity` now handles "a dozen" → 12, "half dozen" → 6, "a couple" → 2, "a few" → 3, "several" → 4, "twenty five" → 25, and 30+ compound forms |
| **Large-order warning** | qty 21–100 now triggers "Just to confirm — 25 × Domoda?" with Yes/Change buttons before committing. Previously only >100 was caught. |
| **`tests/nlp.test.mjs`** | First test suite — 56 assertions covering phrase numbers, all v13 misspellings, matchEngine confidence levels, edge cases. Run with `npm test`. |
| **6 missing `.env` vars** | `ENCRYPTION_KEY`, `PAYMENT_SESSION_TTL_HOURS`, `PROOF_ELIGIBLE_HOURS`, `SESSION_TTL_MINUTES`, `SCHEDULER_ENABLED`, `TEMPLATE_LANGUAGE` — all documented with defaults and explanations |

### Audit fixes applied

- `QTY_LARGE_CONFIRM` / `QTY_LARGE_CHANGE` button IDs wired into QUANTITY case in flowService — previously the large-order buttons were generated but never handled
- `npm test` script added to package.json
- PHRASE_NUMBERS sorted longest-first at module load time (no runtime sort cost per message)
