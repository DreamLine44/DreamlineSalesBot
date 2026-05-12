# DreamLine SalesBot — v15.0.0 (Combined Final)

**This is the authoritative combined release** merging `DreamlineSalesBot_v14_fixed` (full codebase) with `DreamlineSalesBot_v13` (targeted patch package).

> **Result:** v13 was already fully applied inside v14_fixed. This build is v14_fixed with the version bumped to 15.0.0 and this README added for clarity. No code was changed — only confirmed.

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
                                └─► v15.0.0 ← YOU ARE HERE (combined + verified)
```
