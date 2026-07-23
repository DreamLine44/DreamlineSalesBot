# flows/POST_FLOW.md

Source: `services/postFlowHandler.js`, `services/activeOrderResolver.js`,
pipeline steps 11.7 and 14–14.6/15.1 in `controllers/webhookController.js`.

## `postFlowAck` state machine (`services/postFlowHandler.js`)

Extracted from `webhookController.js` (originally ~600 lines inline) so each
state is independently testable. `session.postFlowAck` is set by
`flowEngine.completeFlow()` and by admin actions (order confirmed/rejected,
booking confirmed/declined, order ready) to remember "what just finished"
so the customer's very next message ("thanks!", "ok", "how long?") gets a
contextual reply instead of either being misrouted or dumping the full
welcome menu.

`handlePostFlowMessage({ ackCtx, flowData, session, messageText, ... })`
switches on `ackCtx`:

| ackCtx | Meaning |
|---|---|
| `ORDER_CONFIRMED` | Admin confirmed the order. ETA uses `business.settings.estimatedDeliveryMinutes` if set, else a generic "we'll update you" message — never a hardcoded restaurant-only "20–30 minutes". |
| `ORDER_REJECTED` | Admin rejected. Shows `rejectReason` if the admin supplied one. |
| `ORDER_READY` | Order ready for pickup/delivery. |
| `QUESTION` / `SPEC_REQUEST` / `WARRANTY` | AI-answered follow-up, mode-aware context passed to the AI system prompt. |
| `BOOKING_CONFIRMED` / `BOOKING_DECLINED` | Admin acted on a booking. |
| `APPOINTMENT_REMINDER` | Scheduled reminder follow-up. |
| `WALKIN` / `WALKIN_CONFIRMED` | Salon/barbershop walk-in queue ack. |
| `SKINCARE_ADVICE` | Cosmetics AI follow-up. |
| `ORDER_COLLECTED` | Pickup confirmation follow-up. |
| `ENQUIRY` / `QUOTE_FOLLOW` / `ABOUT` / `ORDER` / `BOOKING` | Generic completions. |
| `MFQ_RESUME` | Customer resuming their original flow after a mid-flow question was answered. |

`postFlowAck`/`postFlowData` are cleared at the top of
`handlePostFlowMessage()` **before** dispatch to any specific case — any
handler that needs to preserve context restores it explicitly. This
prevents a stale ack context from leaking into an unrelated future message
if a handler throws partway through.

Sentiment classification (`classifyPostFlowSentiment`) buckets the reply
into `ACK | COMPLIMENT | COMPLAINT | QUESTION` to pick the right tone —
independent of, and complementary to, the emotion detection in
`core/sentiment/emotionEngine.js`.

Unknown/unexpected `ackCtx` values are treated as `[PFH-2]`: clear the ack
and show a gentle menu rather than falling through to full intent detection
(which would risk wiping useful customer context on a stale/future-state
value).

## Active Order Resolver (AOR) — `services/activeOrderResolver.js`

Runs at pipeline step 14.4, **before** intent detection, AI replies, or
welcome menus. Database is the sole source of truth (never session state),
so order context survives session TTL expiry, server restarts, and human
handoff resets. Resolution priority (highest wins):

```
1. PAYMENT_REJECTED
2. PAYMENT_PENDING          (proof_received | payment_pending_verification)
3. PAYMENT_VERIFIED         (confirmed/self_confirmed/paid + status=confirmed)
4. PREPARING
5. READY
6. OUT_FOR_DELIVERY
7. DELIVERED (within past 2h — DELIVERED_CONTEXT_WINDOW_MS)
8. MULTIPLE_ACTIVE_ORDERS
9. NO_ACTIVE_ORDER
```

Returns `{ order, orders, state, shouldIntercept, uiResponse }`. This same
"active order" definition (non-terminal status / 24h pending cutoff) is
reused elsewhere (e.g. the `TRACK_ORDER` action handler in
`moduleRegistry.js`) specifically so "active" means the same thing
everywhere in the app — don't introduce a second, slightly-different
definition somewhere else.

Throttled via `session.lastAorInterceptAt` so the same reminder doesn't fire
on every single message — `startFlow()` resets this on every fresh flow
start so a new order/booking always gets a clean reminder cycle.

## Pending Order Lock (POL) — pipeline step 11.7

While an order/booking is `payment_pending_verification` / awaiting admin
confirmation, the customer's session is narrowed to a small allowed set:
cancel escape, support escape, quick status check, acknowledgement
classifier, frustration-signal reassurance. Everything else gets a
full-lock reminder. This exists specifically to prevent a customer from
accidentally starting a second, parallel order while their first is still
awaiting confirmation.

## Mid-Flow Question (MFQ) intercept — pipeline step 15.1

Detected by `_detectMidFlowQuestion()` in `webhookController.js`. A
customer typing what looks like a question while inside an active flow step
gets offered "answer it now, or continue where you left off" rather than
either (a) the question being swallowed as if it were the expected flow
input, or (b) the flow being silently abandoned. Never fires on
`MFQ_FREE_TEXT_STEPS` or `MFQ_DATE_TIME_STEPS` (see the sets defined near
the top of `webhookController.js`) — those steps expect arbitrary free text
as their real answer, so question-detection there would misfire constantly.
Sub-cases 15.1a–15.1c handle: button response (yes/no), the `MFQ_RESUME`
flow button, and the free-text question-detection itself.

## Flow-Switch Intercept (FSI) — pipeline step 15.1d/e

Detected by `_detectMidFlowSwitchRequest()`. If a customer mid-order
suddenly types something that reads like a booking request (or vice versa),
the bot asks for explicit confirmation before switching, rather than either
silently ignoring the request or silently abandoning the in-progress flow.
Shares its regex source of truth with `intentEngine.js`'s
`DIRECT_INTENT_EXCLUDE_RE`/`ORDER_DIRECT_RE`/`BOOKING_DIRECT_RE` (imported,
not re-implemented) so the two detectors can't drift apart.

## Quick STATUS command — pipeline step 14.6

A single, always-available "check my order/booking status" path that works
regardless of session state or active flow — the one and only place this
logic lives (see the header comment in `webhookController.js`:
"single source of truth").
