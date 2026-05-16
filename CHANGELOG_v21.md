# DreamlineSalesBot v21.0 — Audited Perfect Version

## Critical Bug Fixes

### BUG-1 — Session wipe when greeting mid-flow with awaiting_question active
**File:** `controllers/webhookController.js`  
**Impact:** CRITICAL — customer loses their entire ORDER or BOOKING if they tap "Ask a Question"
mid-flow and then say "hi" as their question.

**Root cause:** The `awaiting_question` greeting reset at step 7c ran `clearSession()` unconditionally,
regardless of whether a flow was active. A customer ordering who also asked a question,
then sent "hi", would lose their entire cart.

**Fix:** Branch on `session.currentFlow`:
- No active flow → clear session and show welcome (correct reset)
- Active flow → clear only `mode: 'awaiting_question'`, re-prompt the current step via
  `handleStepReprompt()`. Order/booking state is fully preserved.

---

### BUG-2 — PAYMENT_PROOF 4h TTL overwritten by 30min TTL touch on every message
**File:** `services/flowService.js`  
**Impact:** HIGH — payment sessions expired mid-upload. Customer uploads screenshot, session
expires before admin verifies, customer loses payment proof link.

**Root cause:** `handleFlow()` touches `expiresAt` on every message to extend idle TTL.
It hardcoded 30 minutes, which overwrote the 4-hour TTL that `_stepHint: 'PAYMENT_PROOF'`
set via `sessionService`. Every text message during PAYMENT_PROOF reset the clock to 30min.

**Fix:** Detect `session.step === 'PAYMENT_PROOF'` and use `4 * 60 * 60 * 1000` (4h) for
that step; all other steps use the standard 30-minute idle TTL.

---

## Professional Communication Fixes (20 messages rewritten)

The bot must never sound casual, apologetic-informal, or surprise the customer with
resets. All messages now follow a clear standard: direct, warm, businesslike.

| Location | Old (casual) | New (professional) |
|----------|-------------|-------------------|
| `flowService` — ORDER item selected (×3) | `Great choice 👍\n\nHow many...` | `How many *X* would you like?` |
| `flowService` — BOOKING service selected (×3) | `Great! *X* selected ✅\n\n...` | `*X* confirmed.\n\n[prompt]` |
| `flowService` — DATE_CONFIRM confirmed | `Got it — *date* ✅\n\n...` | `Date confirmed: *date*.\n\n...` |
| `flowService` — DATE_CONFIRM re-enter | `No problem! Let's try again.` | `Of course. What date would you like?` |
| `flowService` — TIME_CONFIRM re-enter | `No problem! Let's try again.` | `Of course. What time would you prefer?` |
| `flowService` — BOOKING default (unknown step) | `Let's start over 😊\n\nWhat date...` | `What date would you like to book?` |
| `flowService` — INTERRUPT resume booking (×3) | `No problem! Continuing your booking.` | `Continuing your booking.` |
| `flowService` — INTERRUPT resume order | `No problem! Continuing your order.` | `Continuing your order.` |
| `flowService` — INTERRUPT switch to booking | `Sure! Let's set up your booking 📅` | `What date would you like for your booking?` |
| `flowService` — startBookingFlow starter | `Sure 👍\n\n[prompt] 📅` | `[prompt]` (clean, no filler) |
| `flowService` — QUANTITY re-prompt after large-qty change | `No problem! How many... 🛒` | `How many *X* would you like?` |
| `flowService` — PAYMENT_PROOF 3-retry support | `It looks like you might need help...🙏` | `Please contact us at *X* for payment assistance.` |
| `flowService` — gracefulRetryUI (Order/Booking save error) | `We're having a little trouble right now 🙏...not your fault!` | `We were unable to complete your request due to a technical issue.` |
| `flowService` — generic step reprompt fallback | `😊 What would you like to do next? Type *cancel* to stop or continue...` | `Please continue with your response, or type *cancel* at any time to stop.` |
| `flowService` — upsell accepted summary | `D${finalTotal}` (hardcoded currency) | `${currency} ${finalTotal}` (dynamic, respects business config) |
| `webhookController` — image at wrong time (×2) | `I can only understand text messages right now 😊` | `Please send a text message to continue.` |
| `webhookController` — non-text guard | `I can only understand text messages right now 😊` | `Please send a text message to continue.` |
| `webhookController` — REJECTION_RESEND | `No problem — please send a new screenshot...📸` | `Understood. Please send a new screenshot...` |
| `webhookController` — REJECTION support | `🤝 *Support*\n\nOur team will assist you...` | `*Payment Support*\n\nA member of our team will follow up...` |
| `webhookController` — over-limit | `We're currently experiencing high demand...🙏` | `We are unable to process your message at this time.` |
| `webhookController` — REPEAT_ORDER | `Tap *Order* to place a new order!` | `Tap *Order* to place a new order.` |

---

## No-Initiation Guarantee (unchanged)

The bot **never** sends the first message. Every `dispatch()` call is inside a webhook
handler triggered by the customer's own inbound message. Zero proactive or unsolicited
messages exist in this codebase.

## Flow Integrity Guarantee

Sessions are **never** cleared mid-flow unless the customer explicitly cancels (taps
❌ Cancel or types "cancel"). Specifically:
- Saying "hi" mid-order does NOT reset the order (BUG-1 fix)
- Asking a question mid-booking does NOT reset the booking (ENQUIRY handled without clearSession)
- PAYMENT_PROOF sessions survive for 4 hours so customers can upload late screenshots (BUG-2 fix)
- SHOW_MENU and REJECT_FLOW mid-flow go through buildCancelUI (one-tap confirm) not silent wipe
- Loop detection resets the counter only, never the flow

