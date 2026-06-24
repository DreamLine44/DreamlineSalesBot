# WhatSalesAgent

Multi-tenant WhatsApp Business AI automation backend. Businesses (restaurants, salons, bakeries, electronics, retail, and more) connect their WhatsApp Business accounts and get a fully automated sales and support bot.

## Architecture

```
Webhook → Intent Engine → Module Router → Flow Engine → WhatsApp Dispatcher
```

- **Webhook** (`webhookController.js`) — verifies Meta signatures, deduplicates messages, enforces business hours and human-mode, routes to the pipeline
- **Intent Engine** (`core/intents/intentEngine.js`) — resolves intent from button ID → keyword → AI, in that priority order
- **Module Router** (`core/conversations/moduleRouter.js`) — dispatches to the registered action handler for the tenant's business mode
- **Flow Engine** (`core/conversations/flowEngine.js`) — manages multi-step conversation state via session
- **WhatsApp Dispatcher** (`core/whatsapp/dispatcher.js`) — formats and sends messages via the Meta Cloud API

### Business Modes

| Mode | Flows |
|---|---|
| RESTAURANT | ORDER, BOOKING, QUESTION |
| RETAIL | ORDER, PRODUCT_QUERY |
| DELIVERY | ORDER |
| BAKERY | ORDER, BOOKING, CAKE_CUSTOMIZATION |
| SALON / BARBERSHOP | BOOKING, WALKIN, ORDER, QUESTION |
| FASHION | ORDER |
| COSMETICS | ORDER, BOOKING, SKINCARE_ADVICE |
| ELECTRONICS | ORDER, SPEC_REQUEST, COMPARE, WARRANTY, QUESTION |
| SERVICES | ENQUIRY, BOOKING, QUOTE_FOLLOW, QUESTION |
| GENERAL | QUESTION, ENQUIRY, BOOKING, ABOUT |

### Data Models

- **Tenant** — WhatsApp credentials (encrypted), plan, status, onboarding step
- **BusinessConfig** — menu/services/bot config, business hours, payment settings
- **Session** — active conversation state (TTL-based, per customer per tenant)
- **Order / Booking** — transaction records
- **UserProfile** — customer memory (name, order history, preferences)

## Setup

### Prerequisites

- Node.js 18+
- MongoDB 6+ (replica set required for transactions)
- Meta Business account with a WhatsApp Business App

### Install

```bash
npm install
```

### Environment Variables

Copy `.env.example` and fill in all values:

```bash
cp .env.example .env
```

Key variables:

| Variable | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string (replica set) |
| `ENCRYPTION_KEY` | 32-char hex key for AES-256-GCM credential encryption |
| `SUPER_ADMIN_API_KEY` | Master key for tenant management endpoints |
| `META_APP_ID` | Your Meta app ID |
| `META_APP_SECRET` | Your Meta app secret |
| `META_WEBHOOK_VERIFY_TOKEN` | Token set in Meta webhook configuration |
| `GROQ_API_KEY` | Groq API key for AI fallback replies |
| `NOTIFICATION_WEBHOOK_URL` | (Optional) Webhook for onboarding status notifications |

### Generate a super admin key

```bash
npm run genKey
```

### Seed a test tenant

```bash
npm run seed
```

### Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

### Health check

```bash
npm run health
# or: GET /health
```

## Deployment

### Railway (recommended)

`railway.json` is pre-configured. Set env vars in the Railway dashboard and deploy — Railway uses `node src/app.js` directly.

### Koyeb / Procfile platforms

`npm start` now correctly points to `src/app.js`. Deploy normally.

### Environment

The app validates all required env vars at startup (`src/config/env.js`) and exits with a clear error if any are missing.

## API Overview

All endpoints require either `x-api-key: <SUPER_ADMIN_API_KEY>` or `x-api-key: <tenant_api_key>` depending on the route.

| Prefix | Auth | Purpose |
|---|---|---|
| `/webhook` | Meta signature | Incoming WhatsApp messages |
| `/api/tenant` | Super admin | Tenant CRUD, activation |
| `/api/business` | Tenant | BusinessConfig management |
| `/api/dashboard` | Tenant | Orders, bookings, analytics |
| `/api/onboarding` | Tenant | WhatsApp credential setup |
| `/simulate` | Tenant | Test bot without real WhatsApp |
| `/health` | None | Uptime check |

## Adding a New Business Module

1. Create `src/modules/<mode>/flows/index.js` and export your flow handlers
2. Import and register flows in `src/core/shared/moduleRegistry.js`
3. Add the mode to `src/config/modes.js` MODE_MAP if it needs a custom config
4. Add the mode's intent patterns to `src/core/intents/patterns.js` if needed

## Repo Notes

- `Others/` — scratch files, not part of the application
- `.env.example` — complete reference for all environment variables
- Simulation mode (`SIMULATION_MODE=true`) lets you test flows without a real WhatsApp connection
