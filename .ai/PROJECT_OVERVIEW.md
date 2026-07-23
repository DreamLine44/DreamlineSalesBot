# PROJECT_OVERVIEW.md

## What WhatSales is

WhatSales (internal names: WhatSalesAgent / WhatSalesAgent2 / WhatSalesBot /
DreamlineSalesBot) is a **multi-tenant WhatsApp-first e-commerce and business
automation SaaS platform**, built for businesses in The Gambia and similar
markets. Each tenant (a business) gets:

- A WhatsApp Business number wired to this app via the Meta Cloud API.
- A conversational bot that takes orders, books appointments, answers
  questions, and escalates to a human when needed.
- An admin dashboard (separate frontend repo, `whatsales-frontend`) for
  managing menu/services, viewing orders/bookings, and configuring the bot.

Originally built single-tenant for **DreamLine Restaurant**, then evolved
into the current multi-tenant architecture. `Tenant` is the SaaS account
(WhatsApp credentials, plan, usage limits); `BusinessConfig` is that
tenant's storefront config (menu, services, hours, messaging).

## Business verticals ("modes")

Each tenant has exactly one `businessMode`, set on `BusinessConfig`. The
mode selects which module's flows, config, and UI copy apply
(`config/modes.js` → `MODE_MAP`):

| Mode | Primary flows | Notes |
|---|---|---|
| `RESTAURANT` | ORDER, BOOKING, QUESTION | Table booking + food ordering |
| `RETAIL` | ORDER, PRODUCT_QUERY | Dedicated flows, not generic wrappers |
| `DELIVERY` | ORDER | Delivery-address + slot-scheduling flow |
| `BAKERY` | ORDER, BOOKING, CAKE_CUSTOMIZATION | Custom cake builder |
| `SALON` / `BARBERSHOP` | BOOKING, WALKIN, ORDER, QUESTION | Stylist selection, walk-in queue (no date/time) |
| `FASHION` | ORDER | Includes `SELECT_COLOR` size/color step |
| `COSMETICS` | ORDER, BOOKING, SKINCARE_ADVICE | AI skincare Q&A |
| `ELECTRONICS` | ORDER, SPEC_REQUEST, COMPARE, WARRANTY | Tech spec Q&A, side-by-side compare |
| `SERVICES` | ENQUIRY, BOOKING, QUOTE_FOLLOW, QUESTION | Quote-capture business (no fixed menu) |
| `GENERAL` | QUESTION, ENQUIRY, BOOKING, ABOUT | Fallback/catch-all vertical |

`FOOD` and `CAFE` are aliases that resolve to `RESTAURANT_CONFIG`.

## Architecture in one sentence

**Intent Engine → Module Router → Flow Engine → (module flow handler | AI
fallback) → Dispatcher → Meta WhatsApp Cloud API**, all gated by a very long
and deliberately ordered pipeline in `controllers/webhookController.js`
(see `.ai/ARCHITECTURE.md` for the full numbered walkthrough).

## Top-level file map

```
app.js                     Express app: middleware, route mounting, startup/shutdown
config/                    env validation, logger, DB connection, Cloudinary, modes registry
controllers/                webhookController (huge — the pipeline), tenant/business/dashboard/
                             admin-user/simulate/whatsapp-onboarding/menu-image controllers
core/
  ai/providers/             aiRouter (provider-agnostic facade), groqProvider, mockProvider
  analytics/                analyticsService — event tracking
  conversations/            flowEngine, moduleRouter, bookingFlow (shared booking state machine)
  intents/                  intentEngine, patterns (keyword/button/emoji maps), negationGuard
  memory/                   customerMemory — cross-session customer facts
  sentiment/                emotionEngine — pre-flow emotion detection + tone application
  sessions/                 sessionService — the Session document CRUD + TTL logic
  shared/                   moduleRegistry (wires every module at boot), uiOptionsHelper
  whatsapp/                 dispatcher — the ONLY file that calls the Meta Graph API
middleware/                 auth, rate limiting, error handling, webhook signature, upload, onboarding validation
models/                     Mongoose schemas — see business/DATA_MODELS.md
modules/                    One directory per business vertical + modules/catalog (WA Commerce Catalog)
routes/                     Express routers, one per API surface
scripts/                    One-off/maintenance scripts (migrations, key gen, health check, seed)
services/                   Cross-cutting business logic used by controllers/flows
tests/                      node:test + node:assert/strict, one *.test.mjs per fix/feature
utils/                      parseQuantity, matchEngine (small pure helpers)
```

## Deployment

- Backend: Railway (Node.js/Express, MongoDB via Mongoose).
- Frontend (`whatsales-frontend`, separate repo): React/Vite, deployed on
  Vercel.
- WhatsApp transport: Meta WhatsApp Cloud API, per-tenant credentials
  (`Tenant.whatsapp.*`), decrypted via `tenantController.decryptToken()`.
- AI: Groq (`llama-3.3-70b-versatile` for customer-facing replies,
  `llama-3.1-8b-instant` for intent classification/greetings), with a
  deterministic `mockProvider` fallback so the bot degrades gracefully with
  no live AI provider.

## Related project

FT also maintains a separate, unrelated portfolio website project for
developer Baba L Tarawally — not part of this codebase.
