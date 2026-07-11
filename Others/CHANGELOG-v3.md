# CHANGELOG — v3 (Merge of v1 + v2, plus a fresh systematic audit)

## Merge
Compared every file in the two uploaded zips (`whatsales-backend-v1.zip`,
`whatsales-backend-v2.zip`). They were identical except:

- `src/core/whatsapp/dispatcher.js` — v2 contains `[AUDIT-FIX-DISPATCH-FALSE-SUCCESS]`,
  fixing `dispatchMessage()` returning a truthy `Response` object on a 4xx/5xx
  Meta API failure. v2's version kept (superset).
- `src/tests/dispatchMessageFailureReturn.test.mjs` — new in v2, regression test
  for the fix above. Kept.

v2 shipped as a `src/`-only tree (no `package.json`). Merge result = v1's
project scaffolding (`package.json`, `package-lock.json`) + v2's `src/` tree.

**Baseline after merge, before this audit's changes: 337/337 tests passing.**

## This audit's scope
Since `whatsales-backend-v2` had already done a full pass over every WA
Catalog-critical file, this round focused on everything *outside* that scope:
all 11 vertical flow modules end-to-end, session management, intent
detection, auth/encryption, webhook signature verification, the multi-item
cart engine in `orderService.js`, and the admin command/analytics paths —
checked against every recurring bug family previously found in this
codebase's history (per its own changelogs/comments): stale `postFlowAck`,
`completeFlow()` signature drift, positional-vs-named analytics args, field
name mismatches (`totalAmount`/`totalPrice`, `businessName`/`business.name`),
and missing `button` labels on WhatsApp list messages.

## Bug found and fixed: missing `button` label on three WhatsApp list messages
**Files:** `src/modules/services/flows/index.js` (2 occurrences),
`src/modules/retail/flows/index.js` (1 occurrence)

`core/whatsapp/dispatcher.js`'s list-message builder falls back to a generic
`'Choose option'` label whenever `ui.button` is not set:

```js
button: String(ui.button || ui.buttonLabel || 'Choose option').slice(0, 20),
```

This is the exact same bug class already fixed once in this codebase for
`activeOrderResolver.js` (`[FIX-AOR-BTNLABEL]`) — three more instances had
never been given an explicit label:

- `handleEnquiryFlow()`'s INIT branch (services module — "Get a Quote" service
  type picker) — customers saw a generic "Choose option" button instead of
  something purpose-specific.
- `_askServiceType()` (services module) — same list, reached again later in
  the flow (e.g. after an unrecognised free-text reply).
- `_buildCategoryUI()` (retail module) — the shop-category picker shown at
  the start of every retail order.

**Fix:** added explicit `button: 'Choose service'` / `button: 'Choose
category'` labels, matching this codebase's established convention.

**Regression test:** `src/tests/auditFixListButtonLabel.test.mjs` (4 tests) —
targeted checks on all three fixed call sites, plus a general scan across
every list-message builder in the flow modules confirming none of them are
missing a `button` field (verified to fail pre-fix and pass post-fix).

## Areas audited and found clean
Read in full and checked against the recurring bug families above, no issues found:
- `sessionService.js` — `postFlowAck`/`postFlowData` reset on session recreation
  (already fixed, `[FIX-SES-9]`).
- `completeFlow()` — every call site across all 11 vertical modules matches its
  `(session, completedFlow, business, tenant)` signature.
- `analyticsService.js` — `trackOrderAnalytics()`/`recordRevenue()` call sites
  all use correct positional/named argument shapes.
- `Order.js` field naming — `totalPrice` used consistently; stray `totalAmount`
  references are only in already-fixed-bug comments, not live code.
- `businessName`/`business.name` — used consistently with correct fallback
  chains everywhere it appears on `BusinessConfig`/`Tenant`-backed data;
  `WhatsAppConnectionRequest.businessName` is a genuinely distinct field on a
  different model.
- `activeOrderResolver.js` 7-state priority ladder — payment-status gating
  logic intact, matches its own extensive inline documentation.
- `orderService.js` multi-item cart stock decrement — per-line loop with a
  hard cap sanity check, no signature drift from the single-item path.
- `intentEngine.js` — full detection pipeline (button/emoji/numeric/keyword/
  direct-phrase/Levenshtein/AI-classify/fallback) reviewed end-to-end; no
  ordering or fallback bugs found.
- `authMiddleware.js` / `tenantController.js` — constant-time key comparison,
  AES-256-GCM token encryption/decryption (correct IV/auth-tag handling),
  Bearer + legacy x-api-key dual auth path, role-check bypass rules — all
  intentional and correctly implemented.
- `webhookController.js` HMAC verification — per-tenant secret resolution
  with documented global-env fallback, `timingSafeEqual` used correctly
  (length-checked first to avoid a throw on mismatched buffer sizes).

## Test suite
**341/341 tests passing** (`node --test "src/tests/**/*.test.mjs"`) — 337
pre-existing + 4 new for this round's fix.

## Delivery contents
Full project: `package.json`, `package-lock.json`, `src/`.
