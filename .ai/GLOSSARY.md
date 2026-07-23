# GLOSSARY.md

Every acronym/short-name used across the `.ai/` docs, defined once here.
If you're an AI reading these docs for the first time, skim this before
`README.md` — it removes the need to reverse-engineer meaning from context.

| Term | Meaning | Where it lives |
|---|---|---|
| **AOR** | Active Order Resolver — DB-driven "does this customer have an active order right now, and what should we say" check that runs before intent detection. | `services/activeOrderResolver.js`, `.ai/flows/POST_FLOW.md` |
| **POL** | Pending Order Lock — narrows a customer's session to a small allowed action set while their order/booking awaits admin confirmation. | pipeline step 11.7 in `webhookController.js`, `.ai/flows/POST_FLOW.md` |
| **MFQ** | Mid-Flow Question — intercept that offers to answer a question typed mid-flow without losing flow position. | pipeline step 15.1, `.ai/flows/POST_FLOW.md` |
| **FSI** | Flow-Switch Intercept (also "mid-Flow Switch Intercept" in some comments) — confirms before switching a customer from an in-progress order to a booking (or vice versa). | pipeline steps 15.1d/e, `.ai/flows/POST_FLOW.md` |
| **WA Catalog** / **Commerce Catalog** | Meta's native WhatsApp product-browsing/checkout UI, integrated per-tenant. Never call this bare "catalog" in code — that term is already used for `BusinessConfig.menuItems` matching. | `modules/catalog/*`, `.ai/modules/CATALOG.md` |
| **UIResponse** | The common return shape `{ type, body, buttons?, rows?, sections?, ... }` every flow handler/router/action produces, consumed by `dispatcher.js`. | `.ai/ARCHITECTURE.md` |
| **TTL** | Time-to-live — the `Session.expiresAt` window, dynamically computed based on step/humanMode. | `core/sessions/sessionService.js`, `.ai/business/SESSION_RULES.md` |
| **humanMode** | Session flag meaning an admin has taken over the conversation; the bot stays silent except for admin commands. | `.ai/business/SESSION_RULES.md` |
| **postFlowAck** | Session field recording "what flow/action just completed," consumed by the ack state machine so the next customer message gets a contextual reply. | `services/postFlowHandler.js`, `.ai/flows/POST_FLOW.md` |
| **wamid** | WhatsApp Message ID — Meta's unique ID per inbound message, used for de-duplication via `ProcessedMessage`. | pipeline step 1 |
| **shortId** | Short, customer-facing reference code for an `Order`/`Booking` (used in admin commands like `APPROVE <shortId>`). | `models/Order.js`, `models/Booking.js`, `.ai/services/ADMIN_COMMANDS.md` |
| **AI_DECIDES / ALWAYS_OFFER / MANUAL_ONLY** | The three `waCatalog.mode` values controlling when WA Catalog is automatically offered. | `.ai/modules/CATALOG.md` |
| **BUTTON_ID_MAP** | The map from every interactive button/list-row ID to an action string. | `core/intents/patterns.js`, `.ai/flows/INTENT_DETECTION.md` |
| **ACTION_REGISTRY** | The map of action name → handler, populated by `registerAction()` calls in `moduleRegistry.js`. | `core/conversations/moduleRouter.js`, `.ai/flows/FLOW_ENGINE.md` |
| **FLOW_REGISTRY / GENERIC_REGISTRY** | Maps of `mode:flow` (or bare `flow` for shared flows) → step-handler function. | `core/conversations/flowEngine.js`, `.ai/flows/FLOW_ENGINE.md` |
| **STEP_VALID_BUTTONS** | Per-step allowlist of valid interactive button IDs, used to reject a stray tap that doesn't belong to the customer's current step. | `controllers/webhookController.js` |
| **DIRECT_INTENT_EXCLUDE_RE / ORDER_DIRECT_RE / BOOKING_DIRECT_RE** | Shared regexes (single source of truth, imported not re-implemented) used by both `intentEngine.js` and the FSI detector. | `core/intents/intentEngine.js` |
| **`[AUDIT-FIX-*]` / `[FIX-*]`** | Comment-tag convention marking a specific bug fix with its root cause explained inline. Load-bearing documentation — don't strip these during a refactor. | throughout the codebase |
| **BusinessConfig** | The per-tenant storefront config document (menu, hours, messaging, mode). Distinct from `Tenant` (the SaaS account/credentials). | `models/BusinessConfig.js` |
| **Tenant** | The SaaS account document — WhatsApp credentials, plan, usage limits, status. | `models/Tenant.js` |
| **businessMode / mode** | `businessMode` = the vertical (`RESTAURANT`, `SALON`, etc.). `mode` = whether the tenant does `ORDER`/`BOOKING`/`BOTH`. Two different fields — don't confuse them. | `models/BusinessConfig.js` |
| **resolveOrderFields()** | Pure function deciding single-item vs. multi-item order shape and computing `totalPrice` consistently. | `services/orderService.js` |
| **AI classify / classifyIntent** | The Groq-backed last-resort intent classifier, only reached when no deterministic step in `intentEngine.js` matched and no flow is active. | `core/ai/providers/groqProvider.js` |
| **SIMULATION_MODE** | Dev-only mode where `dispatchMessage()` resolves an in-memory "sim slot" instead of calling the real Meta API, enabling `POST /api/message` synchronous testing. | `core/whatsapp/dispatcher.js`, `controllers/simulateController.js` |
