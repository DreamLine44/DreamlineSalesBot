# DreamLine SalesBot v13.0.2 — Final Merge Changelog

## Merge summary

This release is the authoritative 3-way merge of `dreamline_v13` (v13_1 branch)
and `DreamlineSalesBot_v13_merged` (v13_merged branch). Each file was audited
individually; the best version of every conflict was selected.

---

## What changed from each branch

### From v13_merged (kept)
| Tag | File | Description |
|---|---|---|
| PAY-F1 | paymentService.js | `rejectPayment()` resets `paymentProof → null` so retry uploads work |
| PAY-F2 | paymentService.js | `receiveProof()` includes `payment_failed` in status filter |
| PAY-F3 | paymentService.js, webhookController.js | Memory fallback via `conversationMemoryService` when session TTL has expired |
| PAY-F4 | paymentService.js | `buildPaymentInstructions()` anchors order ID in reference |
| PAY-F5 | paymentService.js | `initiatePayment()` persists reference on Order document |
| SES-1 | sessionService.js | `PAYMENT_PROOF` step extends TTL to 4h (env: `PAYMENT_SESSION_TTL_HOURS`) |
| SES-2 | sessionService.js | `updateSession()` accepts `_stepHint` to trigger TTL extension without writing step |
| SES-3 | sessionService.js | `createSession()` preserves `customerName` across GREET resets |
| Bug-5 | webhookController.js | Dedicated `SUPPORT` action case — sets `humanMode`, notifies admin |
| BRAIN | brainService.js | Expanded support keyword list; SUPPORT intent routes to `SUPPORT` action (not ENQUIRY) |
| NEW | conversationMemoryService.js | New service: durable order anchoring across session expiry |
| LEARN | learningService.js | Added `getRecommendation()` function |
| REV | revenueEngineService.js | Added `selectUpsell()`, `applyUpsell()`, `buildRevenueSummary()` helpers |

### From v13_1 (kept / restored)
| Tag | File | Description |
|---|---|---|
| FLOW-1 | flowService.js | v13.0 header preserved with correct changelog |
| FLOW-2 | flowService.js | Safe cancel detection: exact array match + `startsWith` guard (no substring false-positives) |
| FLOW-LEAD | flowService.js | `lastItem` sourced from `UserProfile.favoriteItems` (persists across session resets) |
| FLOW-RECO | flowService.js | `recommendedThisSession` tracking preserved on upsell recommendation |
| LEAD-SEC | leadCaptureService.js | Tenant-scoped lead query via Session lookup — prevents cross-tenant data leakage |
| LAST-ITEM | webhookController.js | `UserProfile.findOne` restored for returning-customer greeting (was regressed to `session.data`) |

### Merged (best of both)
| Tag | File | Description |
|---|---|---|
| FLOW-4 | flowService.js | `buildOrderSummaryText()` replaces inline template — currency-aware, locale-formatted |
| FLOW-5 | flowService.js | Rotating upsell copy (4 natural prompts, randomly selected) |
| FLOW-6 | flowService.js | `anchorOrderToCustomer()` called at PAYMENT_PROOF entry for PAY-F3 support |
| SES-HINT | flowService.js | `_stepHint: 'PAYMENT_PROOF'` passed to `updateSession()` → 4h TTL |

---

## New environment variables

| Variable | Default | Description |
|---|---|---|
| `PROOF_ELIGIBLE_HOURS` | `48` | Hours an order remains eligible for proof upload |
| `PAYMENT_SESSION_TTL_HOURS` | `4` | Session TTL extension for PAYMENT_PROOF step |
| `SESSION_TTL_MINUTES` | `30` | Standard session TTL |

---

## Files changed

```
controllers/webhookController.js   — SUPPORT handler, PAY-F3 fallback, UserProfile lastItem
services/conversationMemoryService.js  — NEW: durable order memory layer
services/brainService.js           — expanded SUPPORT keywords, SUPPORT action routing
services/flowService.js            — buildOrderSummaryText, rotating upsell, anchor call, _stepHint
services/paymentService.js         — PAY-F1..F5, _notifyAdmin refactor, memory fallback
services/sessionService.js         — SES-1..3 (payment TTL, stepHint, customerName)
services/leadCaptureService.js     — tenant-scoped lead query (security)
services/learningService.js        — getRecommendation() added
services/revenueEngineService.js   — upsell helpers added
utils/messageBuilders.js           — buildOrderSummaryText() exported
package.json                       — version 13.0.2
```
