## [v4.0.0] — 2026-04-30

### ✨ Perfect Merge — v1.2 + v3.3 + Groq Enhancements

This release merges `WhatsBotLyn_v1_2_merged` and `WhatsBotLyn_v3_3_final` into a
single production-ready codebase, with all v1.2 bug fixes preserved and Groq
significantly improved.

**Groq improvements (`services/groqService.js`):**
- `[G-RETRY]` Automatic retry with exponential back-off on 429/5xx errors (max 2 retries, 400ms base delay)
- `[G-FALLBK]` Model cascade: `llama-3.1-8b-instant` → `llama-3.3-70b-versatile` — bot never silently dies if primary model is overloaded
- `[G-HEALTH]` `groqHealthCheck()` exported and called on startup — validates API key before first customer message
- `[G-LOG]` Structured log on every Groq call: model, latency, tokens — enables regression tracking in production
- `[G-SAFE]` `GROQ_API_KEY` absence handled in one place; all exported functions gracefully degrade

**All v1.2 critical fixes preserved:**
- `[FIX-DUP]` Atomic MongoDB dedup via `ProcessedMessage` collection
- `[FIX-ROUTE]` `POST /:phoneNumberId` webhook route
- `[FIX-STATUS]` Early skip of WhatsApp delivery/read status updates
- `[FIX-7]` ObjectId cast in `businessService.getBusiness()`
- `[FIX-4]` `startBookingFlow` skips `SELECT_SERVICE` when no services configured
- `[FIX-1]` `buildServicesUI` includes `adminPhone` contact hint in empty-services message
- `[FIX-PAYMENT-PROOF]` Accepts proof for `payment_pending_verification` status too

---

## [v1.2.0-merged] — 2026-04-30

### 🔀 Full Merge of v1.0 and v1.1

This release merges `WhatsBotLyn_v1_0_FIXED` and `WhatsBotLyn_v1_1_fixed` into a
single codebase, preserving all bug fixes from both versions and resolving conflicts.

**Changes from v1.1 (kept):**
- `[FIX-DUP]` Atomic MongoDB dedup via `ProcessedMessage` collection — eliminates the race condition where Meta retries could create duplicate replies. `isDuplicate()` now uses `findOneAndUpdate` with `$setOnInsert` + an in-memory `Set` fast path.
- `[FIX-ROUTE]` Added `POST /:phoneNumberId` webhook route — Meta sometimes sends to the phone-number-scoped path which previously had no handler and silently dropped messages.
- `[FIX-STATUS]` Explicitly skip delivery/read status updates early in the webhook handler.
- Meta API version updated to `v21.0` (was `v18.0` in v1.0).

**Restored from v1.0 (were dropped in v1.1):**
- `[FIX-7]` ObjectId cast in `businessService.getBusiness()` — Mongoose does not auto-coerce strings to ObjectId for embedded queries; a plain string silently never matched. Fixed by casting with fallback.
- `[FIX-4]` `startBookingFlow` and `handleInterrupt` now skip `SELECT_SERVICE` and jump straight to `DATE` when no services are configured, preventing an infinite empty-list loop.
- `[FIX-5]` `handleBooking SELECT_SERVICE` handler similarly skips to `DATE` when `services.length === 0`.
- `[FIX-1]` `buildServicesUI` empty-services message now includes the business `adminPhone` as a contact hint (e.g. "Please contact us at *+220…* to book.") instead of a generic static string.

---

## [v3.1.0] — 2026-04-29

### 🐛 Critical Bug Fixes (merged from v2.6)

**[FIX-3] "We're having a little trouble right now" — root cause fixed**

The confirm button's "❌ Cancel" tap was being intercepted by brainService (which
classified the id:"CANCEL" payload as a CANCEL action) BEFORE flowService could
process it. This caused `handleFinalize()` to run with a cleared session, hitting
the graceful-retry guard and showing the error message to the customer.

Fix: in `webhookController.js`, CANCEL from brain is now ignored when
`session.step === 'CONFIRM'`. The message falls through to `handleFlow()` which
processes the cancellation correctly via the single, correct code path.

**[FIX-1] tenantId ObjectId cast in `loadBusiness()`**

`session.tenantId` is stored as a plain String by sessionService, but
`BusinessConfig.tenantId` is a Mongoose ObjectId. A string→ObjectId mismatch
caused `findOne()` to silently return `null`, which made the confirm handler
unable to load the business document — triggering `gracefulRetryUI('ORDER')`.

Fix: cast `session.tenantId` to `ObjectId` before querying `BusinessConfig`.

**[FIX-2] Null business guard in `handleFinalize()`**

`handleFinalize()` only checked `tenant?._id` but not `business?._id`. If
`loadBusiness()` returned null (due to [FIX-1] above), `Order.create()` would
crash with an unhandled TypeError instead of showing the graceful retry UI.

Fix: explicit `business?._id` null guard added to both ORDER and BOOKING paths.

### ✨ v3.0 Features (preserved)
- `buildSmartFallbackUI` / `buildLoopFallbackUI` — never a dead-end message
- Button-based confirmations throughout (date, time, item, order confirm)
- `REJECT_FLOW` action — graceful "no thanks" flow exit
- `getModeRestrictionMessage()` — polite, mode-aware restriction replies
- `applyMode` / `getSetupChecklist` / `getDefaultConfig` business API endpoints
- Expanded NLP keywords (haircut, nails, hours, price, cost, etc.)
- `loopFallback` custom message field in BusinessConfig

# WhatsBotLyn Changelog

---

## v3.0.0 — Business Modes, Smart UX & Self-Configuration System

### 🚀 What's New for Business Owners

#### 1. Business Modes (Plug-and-Play Setup)
Three ready-made modes. Pick one and your bot is configured automatically:

- **🍔 RESTAURANT** — Food ordering + table booking + FAQ. Friendly tone with emoji buttons.
- **💇 SALON** — Appointment booking with service selection + FAQ. Professional tone.
- **🛍️ RETAIL** — Product ordering + FAQ. Clean and professional.

**How to use:** `POST /business/apply-mode` with `{ "mode": "RESTAURANT" }`

#### 2. Setup Checklist
Know exactly what's configured and what's missing — no guessing:

`GET /business/setup-checklist`

Returns a checklist with plain-English tips:
- ✅ Business name set
- ✅ Menu items added
- ⬜ Admin phone number missing → tip: "Set adminPhone to receive order alerts"

#### 3. Starter Config Template
Get a ready-to-fill template for any mode:

`GET /business/default-config?mode=RESTAURANT`

Returns a complete JSON template. Fill in your details and POST it to `/business`.

#### 4. Smart Fallback UX
The bot NEVER sends a dead-end "I don't understand" message again.

**Before (v2.x):** "I don't understand. Try: Order to order food, or Book to reserve a table."

**After (v3.0):** Shows mode-appropriate tap buttons:
```
I didn't quite catch that 😊
[🍔 Order]  [📅 Book]
```

#### 5. Better Confirmation UX
Date and time confirmations now use tap buttons instead of text:
```
Just to confirm — did you mean *25 June*? 📅
[✅ Yes, that date]  [❌ No, re-enter]
```

#### 6. Smarter Loop Recovery
When a customer sends the same message 3+ times, the bot now shows helpful action buttons instead of repeating itself.

---

### 🔧 Technical Changes (for developers)

#### config/modes.js
- Added `fallbackButtons` per mode — used by `buildSmartFallbackUI()`
- Added `loopFallback` label per mode — used by `buildLoopFallbackUI()`
- Added `getModeRestrictionMessage(business, flow)` — polite, mode-aware restriction replies
- All mode labels fully documented

#### utils/messageBuilders.js
- **NEW** `buildSmartFallbackUI(business)` — replaces all dead-end fallback text with mode-appropriate buttons
- **NEW** `buildLoopFallbackUI(business)` — graceful loop recovery with action buttons
- `buildFallbackUI()` is now an alias for `buildSmartFallbackUI()` (backward-compat)
- Date/time confirmation prompts now return `{ type: 'buttons' }` instead of plain text
- Low-confidence item match now returns a buttons UI instead of plain text

#### services/flowService.js
- Loop recovery: tries AI first, then `buildLoopFallbackUI()` (never dead-end text)
- Low-confidence item match: returns buttons UI for confirmation
- All date/time confirm steps: return buttons UI
- Fully mode-aware throughout — reads from `getModeConfig(business)`

#### services/brainService.js
- Mode restriction replies use `getModeRestrictionMessage()` for consistency
- Added `product` and hair-related keywords to base keyword sets
- Improved detection for retail and salon scenarios

#### services/modePresetService.js (NEW)
- `applyModePreset(phoneNumberId, mode)` — one-call mode setup with smart defaults
- `validateBusinessConfig(data)` — plain-English validation (no jargon)
- `buildSetupChecklist(business)` — % complete + per-item tips for owners
- `getDefaultConfig(mode)` — starter template for any mode

#### controllers/businessController.js
- **NEW** `applyMode` → `POST /business/apply-mode`
- **NEW** `getSetupChecklist` → `GET /business/setup-checklist`
- **NEW** `getDefaultConfig` → `GET /business/default-config?mode=...`

#### models/BusinessConfig.js
- Added `loopFallback` to `customMessages` (override the loop recovery message)
- All `customMessages` fields now have inline comments for non-technical owners

#### routes/businessRoutes.js
- `POST /business/apply-mode` — apply a mode preset
- `GET /business/setup-checklist` — get setup completion status
- `GET /business/default-config` — get starter config template

---

## v2.5.0 — Previous Release
See previous CHANGELOG entries below.

---

### Bug Fix: List tap treated as quantity input (silent wrong-order bug)

**Symptom (from screenshots):**
1. User opens menu list → taps "Grilled Chicken" → bot asks "How many?"
2. WhatsApp keeps the list message interactive — user taps "Grilled Fish" (row 4)
3. Bot silently parses row ID "4" as quantity → Order Summary: Grilled Chicken ×4 = D600
4. User never typed a quantity. They had no idea why their order showed 4 items.

**Root cause:**
WhatsApp list messages remain tappable after being sent. Any tap fires a
`list_reply` webhook with the row's numeric ID ("1", "2", "4", etc.). At
the QUANTITY step, `parseQuantity("4")` returns 4 — indistinguishable from
the user typing the digit 4. The [FIX-A] comment in the code says "numbers
are ALWAYS quantity inputs" at this step, which is correct for typed text but
catastrophically wrong for interactive list selections.

The `isInteractive` flag already existed on every message extracted by
`webhookController` — it just was never passed into `flowService`.

**Fix — 3 changes:**

1. **`controllers/webhookController.js`**
   `handleFlow(session, messageText, tenantDoc)` →
   `handleFlow(session, messageText, tenantDoc, isInteractive)`

2. **`services/flowService.js` — handleFlow + handleOrder signatures**
   Both now accept `isInteractive = false` and thread it to the ORDER handler.

3. **`services/flowService.js` — QUANTITY case [FIX-Q]**
   Added guard at the top of the QUANTITY case:
   ```js
   if (isInteractive) {
     return `Please *type* a number for the quantity of *${item}* 😊`;
   }
   ```
   If the message came from a list tap or button tap, the quantity step
   now ignores it and prompts the user to type a plain number. This prevents
   any interactive ID from being silently parsed as a quantity.

**Before:**
```
User taps "Grilled Fish" (row 4) while bot waits for quantity
→ Order: Grilled Chicken ×4 = D600  ← silent wrong order
```

**After:**
```
User taps "Grilled Fish" while bot waits for quantity
→ "Please type a number for the quantity of Grilled Chicken 😊"
→ User types 2
→ Order: Grilled Chicken ×2 = D300  ← correct
```

## v2.4 — 2026-04-28  (Full Audit Release)

Complete audit of all 45 source files. Every issue found and fixed.

---

### A. Logging — console.* eliminated across entire codebase

`console.error/warn/log` was being used in 9 service and controller files instead
of the project's structured `config/logger.js`. In production mode the logger emits
JSON (Datadog/Papertrail-compatible); `console.*` emits unstructured stderr noise
that cannot be searched, filtered, or alerted on.

**Files migrated to `logger`:**
`services/analyticsService.js`, `services/learningService.js`,
`services/groqService.js`, `services/messageService.js`,
`services/businessService.js`, `controllers/businessController.js`,
`controllers/ordersController.js`, `controllers/tenantController.js`,
`middlewares/authMiddleware.js`, `config/database.js`

---

### B. `config/database.js` — used `console.log/error` for DB connection

DB connect/fail messages went to raw stdout. Now uses `logger.info` / `logger.error`
with structured metadata. Consistent with rest of app startup.

---

### C. `middlewares/errorHandler.js` — exposed `err.message` to HTTP clients

**Before:** `res.json({ message: err.message })` — internal stack traces and DB
error strings were visible to any API consumer in production.

**After:** In `NODE_ENV=production`, returns a generic safe message
(`"An unexpected error occurred"`). In development, still shows `err.message`
for faster debugging. Full details always go to `logger.error`.

---

### D. `services/groqService.js` — read legacy `business.mode` field

`buildSystemPrompt` and `standardFallback` both read `business?.mode` (the old
`ORDER/BOOKING/BOTH` enum, deprecated in v15 in favour of `businessMode`).
For v15 businesses this field is `null`, so `canOrder` and `canBook` were always
`false` — Groq was generating responses that never mentioned food or booking.

**Fix:** Both functions now call `getModeConfig(business)` and use
`cfg.flows.includes('ORDER')` / `cfg.flows.includes('BOOKING')` — the same
authoritative source used by every other service.

---

### E. `controllers/businessController.js` — ALLOWED fields incomplete

`createBusiness` and `updateBusiness` both had an `ALLOWED` whitelist that
was missing three fields introduced in v15:
- `businessMode` — the canonical mode field; without it, owners couldn't set SALON/RETAIL
- `wavePhone` — Wave payment number; without it, Wave flow never activated
- `services` — Salon service list; without it, salons couldn't configure their services

All three fields are now in both `createBusiness` and `updateBusiness` ALLOWED lists.

---

### F. `services/messageService.js` — dispatch sent `[object Object]` on null body

If a UI object reached the `dispatch()` default branch with an undefined `body`,
the fallback `String(ui)` produced `"[object Object]"` as the message text —
which would be sent to the customer verbatim.

**Fix:** `dispatch()` now explicitly checks `ui.body ?? null`. If no body exists,
the message is suppressed with a `logger.warn` instead of sending garbage.

---

### G. `utils/logger.js` — duplicate logger (winston) alongside `config/logger.js`

The project had two loggers: a full winston instance at `utils/logger.js` and
a lean custom logger at `config/logger.js`. `paymentService.js` imported the
winston one; everything else used the custom one. The winston logger was not
configured consistently and added an extra dependency.

**Fix:** `paymentService.js` now imports from `config/logger.js`.
`utils/logger.js` is replaced with a thin re-export of `config/logger.js`
for backward-compatibility. Winston is still in `package.json` but no longer
directly instantiated outside the compatibility shim.

---

### H. `app.js` — version string said "v12"

Startup log said `WhatsBotLyn v12 running on port …`. Updated to `v2.4`.

## v2.3 — 2026-04-28

### Critical: Zero client-visible error strings (full audit)

This release audits and eliminates every internal error string that could
reach a WhatsApp customer. The rule is simple: **clients never see system
messages**. Errors go to the logger; customers get a graceful UI.

---

#### Bug 1 — ORDER/BOOKING save failure showed raw technical message to client
**Symptom:** After tapping "Yes, confirm", customer received:
> "There was a problem saving your order. Please try again. Type Order to restart."

**Root cause:** `handleFinalize()` in `flowService.js` returned plain strings
on catch blocks. These are development/ops messages, not customer-facing copy.

**Fix:** `handleFinalize` now builds a `gracefulRetryUI(flow)` helper that
returns a warm, blame-free message ("We're having a little trouble right now 🙏")
with the business name and a clear CTA. All internal details go to `logger.error`.

---

#### Bug 2 — "Your session expired ⏱" shown to confused follow-up messages
**Symptom:** User typed "why" after a failed order → bot replied
> "Your session expired ⏱ No worries — type Order, Book, or Hi to start fresh."

**Root cause:** `wasExpired` in `webhookController` triggered whenever a message
arrived with no active session AND the text wasn't in `KNOWN_STARTS`. "why" is
not in that set, so the expiry message fired. This is internal jargon — the
customer has no idea what a "session" is.

**Fix:** `wasExpired` now dispatches `buildWelcomeUI(business)` instead — the
exact same soft welcome the user would see on a fresh start. No expiry language.

---

#### Bug 3 — REJECT_FLOW mutated shared UI object (unsafe)
**Root cause (v2.2):** The `REJECT_FLOW` handler did
`rejectionReply.body = 'No problem 👍\n\n' + rejectionReply.body` — direct
mutation of the object returned by `buildWelcomeUI`. If the function ever
returns a cached reference, all future callers would see the mutated body.

**Fix:** Now clones via `{ ...baseUI, body: '...' }` before dispatching.

---

#### Bug 4 — `console.error` used in flowService instead of structured logger
All four `console.error` calls in `flowService.js` replaced with `logger.error`
(structured JSON in production, coloured text in development). `logger` is now
imported at the top of the file.

---

#### Bug 5 — Internal guard error strings leaked to client
Two additional guard paths in `handleFinalize` (`!item || !quantity` and
`!tenant?._id`) returned plain English strings. These are now logged and the
same `gracefulRetryUI` is returned instead.

## v2.2 — 2026-04-28

### Bug Fix: Global rejection intent layer (flow intelligence fix)

**Problem:** When a user typed "i dont want to book" (or any rejection phrase) while
inside a protected step like `DATE`, the bot responded with:
> "Sorry, I couldn't understand 'i dont want to book' as a date 📅"

This happened because `PROTECTED_STEPS` in `brainService.js` blocked ALL intent
detection — including rejection intent — causing flowService to treat the message
as invalid step input rather than a user decision.

**Root cause:** Intent priority was inverted. Step input validation ran BEFORE
global intent checks. The correct order is: rejection/cancel intent FIRST, then
step validation.

**Fix — 3 files changed:**

1. **`services/brainService.js`**
   - Added `REJECTION_PHRASES` array covering "dont want", "not interested",
     "never mind", "changed my mind", "go back", "start over", etc.
   - Added `isRejectionPhrase(text)` helper.
   - In `think()`: rejection check now fires **before** the `PROTECTED_STEPS` gate,
     returning `{ action: 'REJECT_FLOW' }` instead of `CONTINUE_FLOW`.

2. **`controllers/webhookController.js`**
   - Added Step 10b: handles `action === 'REJECT_FLOW'` by clearing the session,
     prepending "No problem 👍" to the welcome UI body, and dispatching it.
   - Placed before the existing `CANCEL` handler to maintain priority order.

**Before:**
```
User: "i dont want to book"   (step = DATE)
Bot:  ❌ "Sorry, I couldn't understand 'i dont want to book' as a date"
```

**After:**
```
User: "i dont want to book"
Bot:  ✅ "No problem 👍\n\nWelcome to [Business]! What would you like to do?"
      [Order] [Book] [Help]
```

# WhatsBotLyn v2.1 — Changelog

## Merged from v15 + v2 | Bug fixes from screenshot audit

### New files (from v2, not in v15)
- `services/modePresetService.js` — RESTAURANT/SALON/RETAIL onboarding presets
- `services/paymentService.js` — Wave payment confirm/reject admin API

### Bug Fixes

#### [FIX-1] Double-send / welcome screen mid-flow (Images 4 & 5)
**Root cause:** webhookController ran `handleFlow()` AND the `action` switch for the same message.
When brain returned `CONTINUE_FLOW` for a mid-flow message, the code fell through to the action
switch and ran `START_ORDER` or showed the welcome screen again.
**Fix:** When `session.currentFlow` is active, ONLY `handleFlow()` runs. The action switch is
fully skipped. INTERRUPT/CANCEL/SHOW_MENU are handled before reaching the active-flow branch.

#### [FIX-2] Wrong previousStep stored on INTERRUPT (Image 3/4)
**Root cause:** `updateSession` overwrote `session.step` to `'INTERRUPT'` in the same call that
read `session.step` as `previousStep`. DB write timing meant `previousStep` could equal `'INTERRUPT'`.
**Fix:** `previousStep` is captured from the in-memory `session.step` BEFORE the `updateSession`
call that changes it.

#### [FIX-3] List item selection mid-QUANTITY step (Image 3)
**Root cause:** When user was at `step: 'QUANTITY'` and tapped a new item from the menu list,
the list reply ID (e.g. `"2"`) was sent through brain which returned `CONTINUE_FLOW`. Then
`handleFlow` was called with the message `"2"` at `step: 'QUANTITY'`. But `SELECT_ITEM` handler
also ran because the switch fell to default and reset to `SELECT_ITEM`.
**Fix:** At `step: 'QUANTITY'`, numbers are ALWAYS treated as quantity input. No item-selection
logic runs at this step. `buildMenuUI` list row IDs never re-trigger `SELECT_ITEM` when step
is `QUANTITY` or `CONFIRM`.

#### [FIX-4] Stale session data causing wrong step (general)
**Root cause:** Session was read once at start, then `lastWamid` was written, but the stale
in-memory session object was used for all subsequent logic.
**Fix:** Session is re-fetched from DB after the `lastWamid` write so brain/flow always
sees the latest persisted state.

#### [FIX-5] Payment proof accepted at wrong step (Image 4/5)
**Root cause:** Image handler fired for any image at any step when `currentFlow === 'ORDER'`,
clearing the session prematurely.
**Fix:** Image is only accepted as payment proof when `step === 'PAYMENT_PROOF'` exactly.

#### [FIX-6] Session cleared before success message returned
**Root cause:** In some paths, session was cleared after the success message was dispatched,
leaving a brief window where a duplicate message could re-trigger a new flow.
**Fix:** Session is cleared before returning the success UI object so the cleared state is
written to DB before the customer reply is dispatched.

### Architecture maintained (no regressions)
- Brain (Layer 1) → Flow (Layer 2) → Delivery (Layer 3) separation is intact
- `messageBuilders.js` never imports from services
- `flowService.js` never calls `dispatch()` for customer messages (only admin alerts)
- All user-facing strings come from `getLabel(business, key)` or `BusinessConfig.customMessages`
- Nothing is hardcoded — multi-tenant safe
- Loop prevention is DB-persisted (`Session.loopCount`)
- Stable button IDs: ORDER, BOOK, CONFIRM, CANCEL, SWITCH_YES, SWITCH_NO

---

## [3.2.0-merged] — 2026-04-29

### Merged: v4 structural additions + v3.1 Sales Assistant improvements

**From v3.1 (overlaid — later timestamps, Sales Assistant overhaul):**
- `config/modes.js` — v3.1 upsell config, payment labels, cancelMsg redirection, SA improvements
- `services/brainService.js` — SA-B1 clarification-first fallback, SA-B2 UPSELL intent, SA-B3 QUESTION intent, SA-B4 anti-spam, SA-B5 revenue-boosting intent order
- `services/flowService.js` — FIX-1/FIX-2/FIX-3 bug fixes + upsell flow + payment UI builders
- `services/groqService.js` — newer version with additional improvements
- `services/paymentService.js` — updated payment handling
- `utils/messageBuilders.js` — SA-MB1 buildUpsellUI, SA-MB2 buildPaymentInstructionsUI, SA-MB3/4 payment status builders, SA-MB4 buildClarificationUI
- `models/Session.js` — updated schema (upsellSent tracking, etc.)

**From v4 (base — structural additions):**
- `controllers/webhookController.js` — larger/more complete version
- `models/Order.js` — richer Order schema
- `scripts/fix-order-index.js` — database maintenance script
- `UPGRADE_NOTES.md` — upgrade documentation
- Full `node_modules/` dependency tree with `package-lock.json`
