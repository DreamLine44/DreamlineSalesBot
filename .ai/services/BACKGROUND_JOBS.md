# services/BACKGROUND_JOBS.md

Source: `services/schedulerService.js`, `services/leadCaptureService.js`.

## Scheduler (`schedulerService.js`)

Opt-in via `SCHEDULER_ENABLED=true`. `startScheduler()` (called from
`app.js` `start()`) registers 4 `setInterval` jobs; `stopScheduler()`
clears them on graceful shutdown.

| Job | Interval | Purpose |
|---|---|---|
| `runAbandonedCartJob` | 15 min | Reminds customers who left an order mid-flow (`abandonedAt`/`abandonedFlow`/`abandonedItem` on `Session`, or `abandonedCartAt` on `Order`). |
| `runBookingReminderJob` | 60 min | Reminds customers of an upcoming confirmed booking. |
| `runPaymentReminderJob` | 20 min | Reminds customers who haven't completed payment. |
| `runPostAppointmentFollowUpJob` | 6h | 3 days after a completed booking, checks in and offers to rebook (`[v15-FOLLOWUP]`, uses `Booking.followUpSentAt`). |

### Template requirement — this is the one that bites in production

Every scheduler target is, by definition, a "cold" contact — the customer
hasn't messaged in a while, which is exactly what makes them due for a
reminder. Meta's WhatsApp API **silently drops plain-text messages to
contacts outside the 24-hour conversation window** — it does not error,
the send call appears to succeed. So:

- `WHATSAPP_TEMPLATES_ENABLED=true` + a real, Meta-approved template name
  per job (`TEMPLATE_ABANDONED_CART`, `TEMPLATE_BOOKING_REMINDER`,
  `TEMPLATE_PAYMENT_REMINDER`) is required for the scheduler to actually
  reach anyone in production. `config/env.js`'s `validateEnv()` makes
  `SCHEDULER_ENABLED=true` without `WHATSAPP_TEMPLATES_ENABLED=true` a hard
  **startup error** in production for exactly this reason — see
  `.ai/references/RAILWAY_ENV.md`.
- Each `build*Components()` helper (`buildAbandonedCartComponents`,
  `buildBookingReminderComponents`, `buildPaymentReminderComponents`)
  builds the `{{1}}, {{2}}, ...` parameter array for its template. **These
  must match the parameter slots and order of whatever template you
  actually got approved by Meta** — if you change/re-approve a template
  with a different parameter shape, update the corresponding builder in
  the same change, or the scheduler will silently send template messages
  with misaligned/garbage parameter values.
- Payment reminder's third parameter is `paymentContact`, deliberately
  generic (not `waveNo`) because the platform supports multiple channels —
  see `.ai/services/PAYMENTS.md`.

### If you add a 5th scheduled job

Register it the same way: a `setInterval(() => runXJob().catch(e =>
logger.error(...)), intervalMs)` push into `_timers`, so `stopScheduler()`
automatically clears it on shutdown. Don't create a separate un-tracked
timer — it'll leak past graceful shutdown.

## Lead capture (`leadCaptureService.js`)

Off by default (`BusinessConfig.leadCapture.enabled`), zero behavior
change for tenants who haven't opted in. Triggered from
`flowEngine.completeFlow()` per the explicit `AFTER_ORDER`/`AFTER_BOOKING`
allowlist described in `.ai/flows/FLOW_ENGINE.md` — not every flow
completion.

`handleLeadCapture(session, message, business, tenantDoc)` — step machine
keyed on `session.step`:
- **`CAPTURE_NAME`** — captures/validates the customer's name.
- **`CAPTURE_EMAIL`** — captures/validates email, if
  `leadCapture.fields` includes `'email'`.
- `LEAD_SKIP` button ID is accepted at every step (no need to type "skip").
- `finaliseLead()` returns the mode-appropriate welcome buttons so the
  customer lands back in a normal, navigable state.
- `business.leadCapture.notifyAdmin === true` sends the admin a WhatsApp
  message for every newly captured lead — this flag existed in the schema
  for a while before it was actually checked here; if you add a new
  `leadCapture.*` config flag, confirm this file (not just the schema)
  actually reads and acts on it, per the "built but never wired" bug class
  in `.ai/references/RECURRING_BUG_PATTERNS.md` #3.

`shouldCaptureLead(business, session, trigger)` — the gate `completeFlow()`
consults before starting the sequence at all (respects `enabled` and
`triggerOn`).
