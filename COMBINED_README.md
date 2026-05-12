# DreamLine SalesBot — Combined v14 + v15.1 (Complete Fixed Version)

## What This Is

This is the complete combined codebase merging:

| Source | Version | Contribution |
|--------|---------|--------------|
| `DreamlineSalesBot_v15_1_fixed` | **v15.1.0** | Primary codebase — multi-tenant SaaS, MongoDB, ESM, Groq AI, all 5 bug fixes |
| `DreamlineSalesBot_v14` | **v14.0.0** | Legacy flows engine — standalone flows, in-memory session store, NLP engine, test suite |

---

## Project Structure

```
.                              ← v15.1 primary codebase (ESM, MongoDB multi-tenant)
├── app.js                     ← Main entry point (v15.1)
├── package.json               ← v15.1 deps + npm run test:nlp script added
├── seed.js                    ← DB seed for demo tenant
│
├── controllers/               ← v15.1: REST API controllers
│   ├── webhookController.js   ← BUG-4 fixed: removed redundant updateSession
│   ├── businessController.js
│   ├── dashboardController.js
│   ├── onboardingController.js
│   ├── ordersController.js
│   ├── platformController.js
│   └── tenantController.js
│
├── services/                  ← v15.1: all core services
│   ├── brainService.js        ← BUG-2 fixed: 'food','get','purchase' removed from ORDER intents
│   ├── flowService.js         ← BUG-3 fixed: SELECT_ITEM AI reply includes menu follow-up
│   ├── groqService.js         ← BUG-5 fixed: capability-aware CTA keywords
│   ├── paymentService.js      ← BUG-1 fixed: sessionOrderId 6th param in receiveProof()
│   ├── messageService.js      ← ESM message sender with retry queue
│   ├── sessionService.js      ← MongoDB-backed sessions with payment TTL extension
│   ├── adminPaymentHandler.js
│   ├── analyticsService.js
│   ├── businessService.js
│   ├── conversationMemoryService.js
│   ├── cryptoService.js
│   ├── faqService.js
│   ├── leadCaptureService.js
│   ├── learningService.js
│   ├── modePresetService.js
│   ├── notificationService.js
│   ├── onboardingService.js
│   ├── revenueEngineService.js
│   ├── schedulerService.js
│   ├── smartRecommendationService.js
│   └── templateService.js
│
├── models/                    ← v15.1: MongoDB models
│   ├── Analytics.js
│   ├── Booking.js
│   ├── BusinessConfig.js
│   ├── FailedMessage.js
│   ├── Order.js
│   ├── ProcessedMessage.js
│   ├── Session.js
│   └── UserProfile.js
│       └── Tenant.js
│
├── controllers/               ← v15.1 REST controllers
├── routes/                    ← v15.1 route definitions
├── middlewares/               ← v15.1 auth, error handler, rate limiter
├── config/                    ← v15.1 logger, modes, db, env
├── utils/                     ← v15.1 messageBuilders, matchEngine, phraseEngine, helpers
├── public/                    ← v15.1 onboarding UI
├── scripts/                   ← v15.1 migration scripts
│
└── legacy/                    ← v14 standalone engine (CJS, in-memory)
    ├── index.js               ← v14 standalone entry point
    ├── src/
    │   └── messageRouter.js   ← v14 routing logic (CJS)
    ├── flows/                 ← v14 flow handlers
    │   ├── welcomeFlow.js
    │   ├── orderFlow.js
    │   ├── bookingFlow.js
    │   ├── paymentFlow.js
    │   ├── helpFlow.js
    │   └── mediaFlow.js
    ├── services/
    │   ├── sessionStore.js    ← v14 in-memory session store with TTL
    │   └── waSender.js        ← v14 WhatsApp sender with retry
    ├── utils/
    │   ├── nlp.js             ← v14 NLP engine (intent detection, fuzzy matching, qty parsing)
    │   └── helpers_v14.js     ← v14 helpers (formatCurrency, generateOrderId, etc.)
    ├── config/
    │   └── businessConfig.js  ← v14 single-tenant restaurant config (reference/example)
    └── tests/
        └── nlp.test.js        ← v14 NLP test suite
```

---

## v15.1 Bug Fixes Included

All 5 bugs from the v15.1 release are present in this build:

| Bug | File | Fix |
|-----|------|-----|
| BUG-1 | `services/paymentService.js` | `sessionOrderId` 6th param added to `receiveProof()` |
| BUG-2 | `services/brainService.js` | `'food'`, `'get'`, `'purchase'` removed from `STRICT_INTENTS.ORDER` |
| BUG-3 | `services/flowService.js` | `SELECT_ITEM` AI reply returns `[aiText, buildMenuUI()]` array |
| BUG-4 | `controllers/webhookController.js` | Redundant `updateSession` removed before `clearSession` |
| BUG-5 | `services/groqService.js` | CTA keywords built dynamically from `cfg.flows` |

---

## Setup (v15.1 — Production)

```bash
npm install
cp .env.development.local.example .env
# Fill in:
#   MONGODB_URI, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
#   META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, GROQ_API_KEY
#   ENCRYPTION_KEY (32-byte hex — run: npm run gen-key)

node seed.js     # Seed a demo tenant
node app.js      # Start server
```

## Running v14 NLP Tests

The v14 NLP engine test suite can be run independently:

```bash
# From project root
npm run test:nlp

# Or directly
node --input-type=commonjs legacy/tests/nlp.test.js
```

## Running v14 Standalone (single-tenant, no MongoDB)

If you need to run v14's standalone in-memory bot:

```bash
cd legacy
cp ../.env.example .env
# Fill in: WHATSAPP_TOKEN, VERIFY_TOKEN, PORT
node index.js
```

---

## Key Architecture Differences: v14 vs v15.1

| Aspect | v14 | v15.1 |
|--------|-----|-------|
| Module system | CommonJS (`require`) | ESM (`import`) |
| Session store | In-memory (Map + TTL timers) | MongoDB (`Session` model) |
| Tenancy | Single-tenant | Multi-tenant (Tenant model) |
| NLP/Intent | Custom NLP engine (`utils/nlp.js`) | `brainService.js` + `matchEngine.js` |
| WhatsApp sender | `services/waSender.js` | `services/messageService.js` |
| Flow routing | `src/messageRouter.js` → `flows/*.js` | `controllers/webhookController.js` → `services/flowService.js` |
| AI | None | Groq (`services/groqService.js`) |
| Analytics | None | `services/analyticsService.js` + `models/Analytics.js` |
| Admin UI | None | `public/onboarding.html` |
| Payment | Manual proof | `services/paymentService.js` with Cloudinary |

---

## Migration Path: v14 → v15.1

To migrate a v14 single-tenant deployment to v15.1 multi-tenant:

1. Run `node seed.js` to create a tenant document in MongoDB
2. Copy your menu/config from `legacy/config/businessConfig.js` into the `BusinessConfig` MongoDB document via the onboarding UI (`/onboarding`)
3. Set up your env vars from `.env.development.local.example`
4. Deploy `app.js`

The v14 `flows/` logic is fully superseded by `services/flowService.js` in v15.1 — do not mix them.
