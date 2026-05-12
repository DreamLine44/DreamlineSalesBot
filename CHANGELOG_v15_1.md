# DreamLine SalesBot v15.1.0 — Bug-Fix Release

## Summary

Targeted bug-fix pass over the v15.0.0 codebase. No new features. All changes
are backward-compatible — no migration required.

---

## Bugs Fixed

### BUG-1 · `paymentService.receiveProof()` — sessionOrderId silently dropped
**File:** `services/paymentService.js`

`webhookController` passes a 6th argument (`sessionOrderId`) to `receiveProof()` so
the payment can be matched to a specific order by `_id` instead of a loose
`customerPhone + paymentStatus` query. The v15.0 function signature only accepted
5 arguments, so the `sessionOrderId` was silently dropped on every call.

**Fix:** Added optional `sessionOrderId` 6th parameter. When provided, the primary
query filters by `_id` (most precise), falling back to the broad phone-based query
only when `sessionOrderId` is absent (e.g. memory-fallback path).

**Impact:** Prevents any edge case where two orders from the same customer land
at `payment_pending_verification` simultaneously and the wrong one gets the screenshot
attached to it.

---

### BUG-2 · `brainService` — over-broad ORDER intent triggers
**File:** `services/brainService.js`

`STRICT_INTENTS.ORDER` contained three single-word entries: `'food'`, `'get'`,
`'purchase'`. These caused false positives on very common customer messages:

- `"do you have food?"` → matched `'food'` → `START_ORDER` instead of `ENQUIRY`
- `"can I get info?"` → matched `'get'` → `START_ORDER` instead of `ENQUIRY`

**Fix:** Removed `'food'`, `'get'`, and `'purchase'` from `STRICT_INTENTS.ORDER`.
Customers who type these single words now correctly flow to ENQUIRY or AI_FALLBACK.

---

### BUG-3 · `flowService` SELECT_ITEM — AI reply leaves customer stranded
**File:** `services/flowService.js`

When a customer at the `SELECT_ITEM` step typed an off-topic message (e.g. "what
are your opening hours?"), the bot correctly called Groq and answered the question.
However, it then returned only the AI text response, leaving the customer with no
visible menu to pick from. They had to type something else to get the menu back.

**Fix:** When AI answers at `SELECT_ITEM`, the return value is now an array:
`[{ type: 'text', body: aiReply }, buildMenuUI(business)]`.
`messageService.dispatch()` already handles arrays (v12 fix), so both messages are
sent sequentially: AI answer → interactive menu. Customer always has a clear next action.

---

### BUG-4 · `webhookController` — redundant `updateSession` before `clearSession` in `awaiting_question` reset
**File:** `controllers/webhookController.js`

When a customer in `awaiting_question` mode sent a greeting word, the handler called
`updateSession({ mode: null })` immediately followed by `clearSession()`. The `clearSession`
deletes the session document entirely, making the preceding `updateSession` a wasted
DB write (and a potential race under high load if the two DB calls interleaved badly).

**Fix:** Removed the redundant `updateSession` call. `clearSession` followed by
`createSession` is the correct and complete reset sequence.

---

### BUG-5 · `groqService` — hardcoded CTA keywords ignore business capabilities
**File:** `services/groqService.js`

The `STRICT_GROQ_RULE` in the Groq system prompt always ended with:
`"Type *order*, *book*, or *question* to continue."` — even for booking-only businesses
(which have no Order flow) and order-only businesses (which have no Booking flow).

**Fix:** `ctaKeywords` is now built dynamically from `cfg.flows` before being
interpolated into `STRICT_GROQ_RULE`, so:
- Order + Booking: `type *order*, *book*, *question* to continue`
- Order only: `type *order*, *question* to continue`
- Booking only: `type *book*, *question* to continue`

---

## Files Changed

```
services/paymentService.js     — BUG-1: sessionOrderId param added to receiveProof()
services/brainService.js       — BUG-2: 'food', 'get', 'purchase' removed from ORDER triggers
services/flowService.js        — BUG-3: SELECT_ITEM AI reply now includes menu follow-up
controllers/webhookController.js — BUG-4: removed redundant updateSession before clearSession
services/groqService.js        — BUG-5: capability-aware CTA keywords in system prompt
package.json                   — bumped version to 15.1.0
```

---

## Upgrade

No database migrations needed. No environment variable changes. Drop-in replacement.

```bash
npm install   # deps unchanged — just making sure
node app.js
```
