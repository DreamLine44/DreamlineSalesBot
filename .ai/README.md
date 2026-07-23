# STOP AND READ THIS FIRST

You are an AI coding assistant (Claude Code, Cline, Continue, Cursor, Copilot
Agent, Gemini CLI, Windsurf, or similar) about to work on **WhatSales**
(repo: `DreamLine44/DreamlineSalesBot`), a multi-tenant WhatsApp-first
e-commerce and business-automation SaaS platform.

Before writing a single line of code:

1. Read this file completely.
2. Read `.ai/PROJECT_OVERVIEW.md` and `.ai/ARCHITECTURE.md`.
3. Read whichever `.ai/modules/`, `.ai/flows/`, or `.ai/business/` doc covers
   the area you're about to touch.
4. Never assume. Verify against the actual source file before editing it —
   these docs describe the architecture as of the last audit pass; the owner
   (FT) runs frequent audit passes and the code is ground truth, not this
   doc. If something here looks wrong, trust the code and flag the mismatch.

This project has been through **many rounds of deep audits** that found and
fixed dozens of "silently broken" bugs — features that were fully built but
never wired up, schema fields that were written but never declared (so
MongoDB's strict mode silently discarded the data), and routing collisions
that swallowed customer replies with no error anywhere. The five rules below
exist because each one was learned the hard way, in production, more than
once. Breaking any of them reintroduces a bug class that has already cost
real debugging time.

## The 5 non-negotiable rules

### 1. Every session/business field you write MUST be declared in its Mongoose schema
Mongoose's default `strict` mode **silently drops** any field on `$set`
that isn't declared in the schema — no error, no warning, no log line. This
codebase has been bitten by this repeatedly:
- `pendingCatalogQueue` / `multiItemCart` written throughout the catalog flow
  but absent from `BusinessConfig.js` — all cart data silently discarded.
- `variants` written throughout the menu-item flow but absent from
  `menuItemSchema` — all variant writes silently discarded.
- `address` written by `ABOUT` handlers but absent from `BusinessConfig.js`.

**Rule:** before you write `session.data.someNewField = x` or add any new
key to an `updateSession(...)` / `BusinessConfig` `$set` payload, open the
relevant model in `models/` and confirm the field is declared. If it isn't,
add it there FIRST, in the same change.

### 2. Every enum you write MUST already contain that value
Same failure mode as Rule 1, but for `enum: [...]` constraints (e.g.
`Order.status`, `Booking.status`, `businessMode`). Writing a value not in
the enum throws a `ValidationError` at save time — sometimes swallowed by a
`.catch(() => {})` elsewhere in the call chain, again looking like a silent
no-op. Check the enum list in the model before introducing a new status,
mode, or category string anywhere in application code.

### 3. Express route mount order is load-bearing — never reorder `app.js` blindly
`app.js` mounts routes in a very specific order for a reason, documented
inline there:
- `/admin/tenants` (super-admin-key-only) **must** be mounted before the
  broader `/admin` (tenant-api-key) mount, or `/admin/tenants/*` gets
  silently caught by the wrong auth middleware.
- `whatsappOnboardingRoutes` (`/api/whatsapp/*`, `/admin/whatsapp/*`) must be
  mounted before the broad `/admin` catch-all for the same reason.
- `POST /admin/rotate-super-key` is registered directly on `app` before the
  `/admin` mount so it isn't shadowed.
- `/webhook` uses `express.raw()` for signature verification; the JSON body
  parser explicitly skips `/webhook` to avoid double-parsing the stream.

If you add a new route, read the ordering comments in `app.js` first and
place it correctly, or it can become unreachable or unintentionally open to
the wrong auth tier.

### 4. `core/whatsapp/dispatcher.js` is the ONLY file allowed to call the Meta Graph API
Business logic (modules, services, controllers) must never call
`fetch('https://graph.facebook.com/...')` directly. All outbound messages go
through `dispatchMessage(to, uiResponse, tenant)`. This keeps the transport
swappable and keeps Meta's real, non-obvious limits (10 rows total per
interactive list — not per section; 30 product items total per
`product_list` message — not per section) enforced in exactly one place.
`dispatchMessage` also guarantees it never returns a falsy/`null` result as
if it were a success — a Meta 4xx/5xx must propagate as `null`, or callers
like `sendCatalogMessage` will think a message was delivered when it wasn't
and skip their fallback path.

### 5. Interactive buttons always win over typed text and over AI classification
The intent-detection order in `core/intents/intentEngine.js` is strict and
intentional: button/list-reply IDs are trusted immediately with zero
ambiguity, before any keyword matching, Levenshtein "did you mean," or AI
classification runs. AI **never** triggers a flow directly — it only
returns an intent that the deterministic router then acts on. If you add a
new interactive button, its ID must be added to `BUTTON_ID_MAP` (or to
`STEP_VALID_BUTTONS` / `isFlowPassthroughId()` in `webhookController.js` if
it's a flow-internal step button), or the tap will silently fall through to
`CONTINUE_FLOW` handling instead of doing what the button promised.

## Map of the `.ai/` knowledge base

| File | Covers |
|---|---|
| `PROJECT_OVERVIEW.md` | What WhatSales is, verticals, top-level file map |
| `ARCHITECTURE.md` | The full numbered message pipeline, subsystems, auth model |
| `flows/INTENT_DETECTION.md` | `intentEngine.js` detection order, name extraction, negation guard |
| `flows/FLOW_ENGINE.md` | `flowEngine.js` / `moduleRouter.js` / `moduleRegistry.js` mechanics, "add a vertical" checklist |
| `flows/POST_FLOW.md` | `postFlowAck` state machine, MFQ/FSI mid-flow intercepts, Active Order Resolver, Pending Order Lock |
| `whatsapp/DISPATCHER_AND_LIMITS.md` | UIResponse shapes, real Meta API hard limits, silent-failure guards |
| `modules/BUSINESS_MODULES.md` | Every vertical's registered flows, steps, and quirks |
| `modules/CATALOG.md` | The WA Commerce Catalog (Meta product catalog) integration |
| `business/DATA_MODELS.md` | Every Mongoose schema and the "field missing from schema" bug pattern |
| `business/SESSION_RULES.md` | Session TTL rules, humanMode, postFlowAck/postFlowData, product rules FT enforces |
| `development/FILE_STRUCTURE.md` | Directory-by-directory responsibility map |
| `development/TESTING.md` | Test conventions, how to write a regression test here |
| `development/DEBUGGING.md` | Where to look first for common symptom classes |
| `references/RECURRING_BUG_PATTERNS.md` | The bug classes that keep recurring, so you can grep for them proactively |
| `references/RAILWAY_ENV.md` | Deployment, environment variables, `.env` requirements |
| `prompts/*.md` | Ready-to-use prompt templates for bug fixes, features, refactors, reviews, releases |

## FT's audit methodology (follow this for any non-trivial change)

1. Establish a green test baseline (`npm test`) before touching anything.
2. Identify real bugs via deep file reading and `grep` tracing — never guess
   at behavior from a filename or a comment; read the actual code path.
3. Apply surgical fixes only, each tagged with a comment like
   `[AUDIT-FIX-<SHORT-NAME>]` explaining the root cause and the fix.
4. Write a regression test for each fix, in `tests/*.test.mjs`, using
   `node:test` + `node:assert/strict`, following the existing source-text/
   behavior-guard pattern already used throughout `tests/`.
5. Syntax-check every modified file.
6. Confirm zero regressions against the full suite.
7. Deliver a versioned zip containing only the `src/` directory (or in this
   environment, the equivalent output directory).

Match this discipline. Do not perform sweeping rewrites, renames, or
"while I'm here" cleanups on files you weren't asked to touch — this
codebase's stability comes from small, well-documented, single-purpose
diffs.
