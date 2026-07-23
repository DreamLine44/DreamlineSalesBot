# ARCHITECTURE.md

## Layer diagram

```
Meta WhatsApp Cloud API
        │  POST /webhook  (raw body, HMAC-verified)
        ▼
routes/webhookRoutes.js  →  controllers/webhookController.js
        │
        │  receiveWebhook() parses the Meta payload, resolves tenant by
        │  phoneNumberId, then calls handleIncomingMessage() per message.
        ▼
handleIncomingMessage()  ── the pipeline (18+ ordered gates, see below)
        │
        ├─► core/intents/intentEngine.js   detectIntent()
        │
        ▼
core/conversations/moduleRouter.js  route({ action, intent, ... })
        │
        ├─► ACTION_REGISTRY handlers (registered in core/shared/moduleRegistry.js)
        │
        ▼
core/conversations/flowEngine.js  advance() / startFlow()
        │
        ▼
modules/<vertical>/flows/*.js   (per-step flow handler)  →  UIResponse object
        │
        ▼
core/whatsapp/dispatcher.js  dispatchMessage(to, uiResponse, tenant)
        │
        ▼
Meta Graph API  POST /{phoneNumberId}/messages
```

A **UIResponse** is the common return shape every flow handler, router case,
and action produces: `{ type: 'text'|'buttons'|'list'|'image'|'catalog_message'|
'product_list'|'template', body, buttons?, rows?, sections?, footer?, header?, ... }`.
`dispatcher.js`'s `buildPayload()` is the single place that turns a
UIResponse into a real Meta Graph API payload — see
`.ai/whatsapp/DISPATCHER_AND_LIMITS.md`.

## The `handleIncomingMessage()` pipeline (controllers/webhookController.js)

This is the most important function in the codebase. It runs, in this exact
order, for every inbound WhatsApp message. Each numbered step is a real
comment marker in the source (`grep -n "// ── [0-9]" controllers/webhookController.js`
to jump straight to any of them). Read this before touching pipeline
ordering — steps often exist specifically to run BEFORE or AFTER another
step for a documented reason.

1. **De-duplicate** — Meta can (and does) redeliver the same webhook;
   dedupe via `ProcessedMessage` on the message's `wamid`.
2. **Empty guard** — bail out on messages with no usable content.
3. **Load business** — fetch the tenant's `BusinessConfig` by `tenantId`.
4. **Session** — `getSession()` / `createSession()` (composite key
   `phone_tenantId`).
   - **4.5 Rapid-message suppression** — identical text repeated within a
     short window is silently ignored (prevents double-processing from
     flaky client retries).
   - **4.6 WA Catalog checkout** — Meta's native `type: 'order'` cart
     message from the WA Commerce Catalog is intercepted here and handed to
     `handleCatalogOrderMessage()` before anything else sees it.
5. **Business hours enforcement** — `isWithinBusinessHours(hours)` resolves
   the current weekday **in the business's configured timezone**, not the
   server's — this was a real bug (day-specific hours resolving against
   server/UTC weekday). See `tests/businessHours.test.mjs`.
6. **Admin commands** — checked BEFORE the humanMode guard, so an admin can
   always issue commands (confirm/reject order, resume bot, etc.) even while
   the bot is in human-takeover mode for that customer.
7. **Human mode** — if `session.humanMode === true`, the bot stays silent
   (admin is handling the conversation) except for the admin-command path
   above.
8. **Loop prevention** — detects a customer stuck repeating the same input
   against the same step and breaks the loop with a different response.
   - **8.5 Non-text image guard** — images outside the payment-proof step
     get a "I can only understand text" style reply.
9. **Payment proof image** — routes an uploaded image to
   `services/paymentService.js` `receiveProof()` when the session is
   awaiting one.
10. **DONE payment** — customer typed "done" after paying, gated on
    `payment.requireProof === false` (cash/no-proof-required tenants).
    - **10.5 PAYMENT_PROOF strict text guard** — while awaiting a proof
      image, stray text doesn't derail the flow.
11. *(Admin button replies handled earlier, at step 6.)*
    - **11.5 AWAIT_ADMIN_CONFIRM guard.**
    - **11.7 PENDING ORDER LOCK** — while an order/booking awaits admin
      confirmation, the customer's session is "locked" to a narrow set of
      allowed actions (cancel, support escape, status check,
      acknowledgement) so they can't accidentally start a second parallel
      order.
12. **LEAD_CAPTURE active flow** — if a lead-capture sequence is running
    (post order/booking name/contact capture), it owns the input.
13. **ENQUIRY active flow** — generic AI-answered question flow.
14. **Post-flow acknowledgement / `postFlowAck` state machine** — see
    `.ai/flows/POST_FLOW.md`. Handles "thanks"/"ok" after a completed
    order/booking without dumping the full welcome menu.
    - **14.4 Active Order Resolver (AOR) gate** — decides whether to
      proactively remind the customer of an in-flight order/booking.
    - **14.41 RESEND_PROOF** button tap (retry a rejected payment).
    - **14.42 ORDER_STATUS_\*** button tap (disambiguating among multiple
      active orders).
    - **14.5 COLLECTED_\*** button tap (pickup confirmation).
    - **14.6 Quick STATUS command** — works from any state, no active flow
      required.
15. **Active flow** — if `session.currentFlow` is set, this is the main
    per-step dispatch into the vertical's flow handler via
    `flowEngine.advance()`.
    - Interactive-button validation against `STEP_VALID_BUTTONS` — a button
      ID that doesn't belong to the current step is rejected rather than
      silently misinterpreted.
    - **15.1 MFQ (Mid-Flow Question) intercept** — a customer typing a
      question mid-flow ("does it come with cheese?") gets offered an
      answer without losing their place in the flow. Sub-steps 15.1a–15.1c
      handle the button/typed variants.
    - **15.1d/15.1e FSI (mid-Flow Switch Intercept)** — a customer mid-order
      who suddenly asks to book instead (or vice versa) is offered an
      explicit switch confirmation instead of the switch being silently
      ignored or silently overriding their current flow.
16. **Intent → module router** — no active flow (or the flow explicitly
    passed through): `detectIntent()` → `moduleRouter.route()`.

Only after all of this does a `UIResponse` get built and handed to
`dispatchMessage()`.

## Core subsystems

### `core/intents/intentEngine.js`
The single decision brain for "what does this message mean." See
`.ai/flows/INTENT_DETECTION.md` for the full detection order. Golden rules:
buttons always win; AI never triggers a flow directly (it only returns an
intent/confidence pair that a human-written router decides how to act on);
short/numeric input inside an active flow is always `CONTINUE_FLOW`.

### `core/conversations/moduleRouter.js`
`route({ action, intent, session, message, business, tenant, isInteractive,
suggestion })` — a big `switch` on `action` (GREET, SHOW_MENU, CANCEL,
CANCEL_ALL, TRACK_ORDER, SUPPORT, ABOUT, ENQUIRY, QUESTION, PAYMENT, etc.)
plus a fallback to `ACTION_REGISTRY` (registered by
`core/shared/moduleRegistry.js`) for anything module-specific
(`START_ORDER`, `START_BOOKING`, `WALKIN`, `REPEAT_ORDER`, `SPEC_REQUEST`,
`COMPARE`, `WARRANTY`, `QUESTION`, `ABOUT`, `QUOTE_FOLLOW`, `PRODUCT_QUERY`,
`TRACK_ORDER`, `SKINCARE_ADVICE`, `CAKE_CUSTOMIZATION`). Some switch cases
deliberately check `ACTION_REGISTRY` first before falling back to an inline
default — this lets a module override generic behavior (e.g. `GENERAL`'s
dedicated `ABOUT` flow vs. the generic inline About text every other mode
gets).

### `core/conversations/flowEngine.js`
The reusable step-machine. `FLOW_REGISTRY` maps `${businessMode}:${flowName}`
→ handler; `GENERIC_REGISTRY` maps `${flowName}` → handler for flows shared
across modes (e.g. `BOOKING`, generic `ORDER`). `advance()` looks up the
mode-specific handler first, falling back to the generic one.
`startFlow({ flowName, session, business, tenant })` resets session state
and calls the handler once with `message: null` to produce the first-step
UI. `cancelFlow()` also cancels any in-progress `Booking` DB record — this
was a real, twice-broken bug (see `.ai/references/RECURRING_BUG_PATTERNS.md`).
`completeFlow()` writes `postFlowAck` and may trigger lead capture.

### `core/shared/moduleRegistry.js`
Runs once at boot (`registerAllModules()`, called from `app.js` `start()`).
Every vertical module registers its flow handlers and any custom action
handlers here. **Adding a new vertical = import it + call `registerFlow` /
`registerAction` here. Nothing else needs to change** — see
`.ai/flows/FLOW_ENGINE.md` for the full "add a vertical" checklist.

### `core/whatsapp/dispatcher.js`
Isolated transport adapter. See Rule 4 in `.ai/README.md` and
`.ai/whatsapp/DISPATCHER_AND_LIMITS.md`.

### `core/sessions/sessionService.js`
CRUD + TTL logic over the `Session` model. TTL is dynamic:
- default 30 min (`SESSION_TTL_MINUTES`)
- 4h while awaiting payment proof (`PAYMENT_SESSION_TTL_HOURS`)
- 24h while `humanMode === true` (`HUMAN_MODE_SESSION_TTL_HOURS`)
`updateSession()` supports both a `$set` patch and an atomic `$inc` (for
counters like `messageCount`) in the same `findOneAndUpdate`, and correctly
recomputes TTL even when a patch changes `step`/`currentFlow` without
mentioning `humanMode` explicitly (it looks up the session's *existing*
`humanMode` in that case rather than defaulting the TTL calculation to
`false`).

### `core/sentiment/emotionEngine.js`
`detectPreFlowEmotion(rawMessage)` and `applyEmotionTone(reply, emotion)` —
adjusts the tone/prefix of AI-generated replies based on detected customer
emotion (frustration, urgency, gratitude, etc.). Wired into the pipeline for
AI-fallback replies.

### `core/memory/customerMemory.js`
Cross-session customer facts (top ordered item, returning-customer flag,
name) — **not** the same thing as the per-conversation `Session` document.
Explicitly NOT used to personalize the initial GREET message with the
customer's name (see the "No-name greeting policy" in
`.ai/business/SESSION_RULES.md`) — it exists for mid-conversation and
analytics use, not to make the opening message feel presumptuous.

### `core/ai/providers/aiRouter.js`
Provider-agnostic facade (`getAIReply`, `generateGreeting`, `aiHealthCheck`).
Delegates to `groqProvider.js` (primary) with `mockProvider.js` as a
deterministic fallback so the bot never has a hard dependency on a live AI
provider. Two Groq models: `llama-3.3-70b-versatile` for customer-facing
replies, `llama-3.1-8b-instant` for fast intent classification/greetings.

## Auth model

- **Tenant API key** (`x-api-key` header) — `requireApiKey` middleware —
  used by `/business`, `/dashboard`, `/admin` (broad mount), and tenant-scoped
  onboarding routes. Validated against `Tenant.apiKeyHash`.
- **Super-admin key** (`x-api-key` header checked against
  `SUPER_ADMIN_API_KEY` env var) — `requireSuperAdminKey` middleware — used
  by `/admin/tenants/*` (tenant CRUD across the whole platform) and
  `POST /admin/rotate-super-key`.
- **Simulation key** (`x-sim-key`) — dev-only, only mounted when
  `NODE_ENV !== 'production' && SIMULATION_MODE === 'true'`.
- **Meta webhook signature** — `middleware/webhookSignature.js`
  `verifyMetaSignature` validates the `X-Hub-Signature-256` HMAC on
  `POST /webhook` using the raw (unparsed) body, per-tenant secret resolved
  via `_verifyTenantWebhookSignature()` in `webhookController.js`.

## Route mount order (see also Rule 3 in `.ai/README.md`)

```
/health, /                                     (no auth)
/webhook            webhookLimiter, [sig verify inside routes]
/api                (dev + SIMULATION_MODE only) createRateLimiter(300)
/business           createRateLimiter(120), requireApiKey
/dashboard          createRateLimiter(120), requireApiKey
POST /admin/rotate-super-key   adminLimiter, requireSuperAdminKey   ← before broad /admin mount
/ (whatsappOnboardingRoutes)                                        ← before broad /admin mount
/admin/tenants      adminLimiter, requireSuperAdminKey              ← before broad /admin mount
/admin              adminLimiter, requireApiKey                    (broad catch-all — mounted LAST)
```
