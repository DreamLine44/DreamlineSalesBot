# AI Knowledge Base — Index

`.ai/` sits at the repo root, beside `src/`. **All paths referenced inside
these documents are relative to `src/`** — see the path-resolution note at
the top of `README.md` if a referenced path doesn't resolve.

## Start here (in this order)

1. `README.md` — the 5 non-negotiable rules + audit methodology. Read this
   before touching any code.
2. `GLOSSARY.md` — every acronym used elsewhere in these docs (AOR, POL,
   MFQ, FSI, WA Catalog, etc.)
3. `PROJECT_OVERVIEW.md` — what WhatSales is, the vertical list, top-level
   file map
4. `ARCHITECTURE.md` — the full numbered message-handling pipeline

## Business

- `business/DATA_MODELS.md` — every Mongoose schema + the #1 recurring bug
  pattern (undeclared schema fields)
- `business/SESSION_RULES.md` — TTL rules, humanMode, and the product rules
  FT enforces strictly (no upselling/loyalty/fabricated data)

## Flows

- `flows/INTENT_DETECTION.md` — how a message becomes an action
- `flows/FLOW_ENGINE.md` — the step-machine + "add a new vertical" checklist
- `flows/BOOKING_FLOW.md` — the shared booking engine (8 of 11 verticals)
- `flows/POST_FLOW.md` — postFlowAck, Active Order Resolver, Pending Order
  Lock, mid-flow question/switch intercepts

## Modules

- `modules/BUSINESS_MODULES.md` — every vertical's flows, steps, quirks
- `modules/CATALOG.md` — the WhatsApp Commerce Catalog integration

## WhatsApp transport

- `whatsapp/DISPATCHER_AND_LIMITS.md` — UIResponse shapes, real Meta API
  limits, silent-failure guards

## Services

- `services/ADMIN_COMMANDS.md` — the admin WhatsApp command vocabulary
- `services/PAYMENTS.md` — the payment-proof flow, customer + admin sides
- `services/BACKGROUND_JOBS.md` — scheduled reminders + lead capture

## Controllers / APIs

- `controllers/ADMIN_APIS.md` — dashboard, tenant CRUD, WhatsApp onboarding

## Development

- `development/FILE_STRUCTURE.md` — directory-by-directory responsibility map
- `development/TESTING.md` — test conventions + known stale/failing tests
- `development/DEBUGGING.md` — symptom → likely cause lookup
- `development/CODE_EXAMPLES.md` — real code snippets to copy the shape of

## Reference

- `references/RECURRING_BUG_PATTERNS.md` — the 10 bug classes that keep
  recurring
- `references/MULTI_TENANT_SECURITY.md` — auth + tenant-isolation
  enforcement
- `references/ANALYTICS_AND_UTILS.md` — analytics events, fuzzy matching,
  rate limits
- `references/RAILWAY_ENV.md` — deployment + environment variables
- `references/FRONTEND_CONTRACT.md` — the API contract `whatsales-frontend`
  (separate repo) expects from this backend; read before renaming/removing
  any dashboard-facing response field

## Prompts (copy-paste starting points)

- `prompts/BUG_FIX.md`
- `prompts/FEATURE_REQUEST.md`
- `prompts/SAFE_REFACTOR.md`
- `prompts/CODE_REVIEW.md`
- `prompts/RELEASE_CHECKLIST.md`
