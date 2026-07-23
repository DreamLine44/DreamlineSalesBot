# services/PAYMENTS.md

Source: `services/paymentService.js`, `services/adminCommandService.js`
(`confirmPayment`/`rejectPayment`), pipeline steps 9/10/10.5/14.41 in
`webhookController.js`.

## Payment channels

`BusinessConfig.payment.channels` supports multiple named channels (Wave,
GT Bank, EcoBank, Trust Bank, cash, card, other — see the
`paymentMethod` enum in `models/Order.js`). `payment.requireProof`
(boolean) controls whether a screenshot is mandatory before an order is
treated as paid.

## Customer-side flow

1. Order reaches checkout → `buildPaymentInstructionsUI(business,
   totalPrice, shortId, storedRef?)` builds the payment instructions
   message (account/number to pay to, amount, reference code).
   - **`storedRef`** — if the order already has a `paymentReference` saved
     in the DB, that exact value is reused rather than recomputed. This
     matters because reference generation is date-boundary-sensitive (an
     order placed at 23:55 and a reminder sent at 00:05 would otherwise
     generate two different references for the same order).
   - Date formatting inside reference generation uses explicit zero-padded
     arithmetic (`padStart`), not `Intl.DateTimeFormat`/
     `toLocaleDateString` — both vary across Node ICU builds/locales, which
     previously made generated references non-deterministic across
     environments.
2. Customer sends a payment screenshot → pipeline step 9 →
   `receiveProof(customerPhone, tenantId, imageId, tenantDoc)`.
   - Forwards the image to the admin **before** the approval card, then
     waits ~500ms — sending both concurrently used to let the approval
     card arrive first, confusing about which order it was for.
   - Lookup window: `PROOF_ELIGIBLE_HOURS` (default 4,
     `PROOF_WINDOW_HOURS`) from `createdAt` **OR** from
     `paymentReviewedAt`. The second branch exists because
     `rejectPayment()` reactivates a rejected order for retry by resetting
     `paymentStatus` back to `unpaid` and stamping `paymentReviewedAt` —
     without also matching on that timestamp, an admin reviewing/rejecting
     an order more than 4 hours after it was originally placed (common —
     admins don't always respond fast) would cause the customer's RETRY
     screenshot to fail to match any order, since only the stale
     `createdAt` was being checked.
3. If `payment.requireProof === false` (cash/no-proof tenants), customer
   can instead type "done" → pipeline step 10 → `handleDonePayment()`.
4. While awaiting proof (`PAYMENT_PROOF`/`PAYMENT_CONFIRM`/
   `AWAITING_PAYMENT` steps), stray text doesn't derail the flow (pipeline
   step 10.5's strict text guard), and the session gets an extended 4h TTL
   (see `.ai/business/SESSION_RULES.md`).

## Admin-side flow (`adminCommandService.js`)

`APPROVE <shortId>` / `REJECT <shortId>` — see
`.ai/services/ADMIN_COMMANDS.md` for the full command reference and the
atomic-guard concurrency pattern both handlers use.

- **`confirmPayment()`** — atomically transitions the order to confirmed,
  checking both `status` and `paymentStatus` in the guard so an
  already-cancelled/rejected order can't be resurrected by a stray/late
  APPROVE tap.
- **`rejectPayment()`** — resets `order.status` back to `pending` (not
  leaving it at a dead-end `payment_failed`) so the retry window stays
  open: `paymentStatus='unpaid' + status='pending'` means "order alive,
  retry open." Stores the rejection reason on the order (surfaced later by
  `activeOrderResolver` / `postFlowHandler`'s `ORDER_REJECTED` case). The
  session's `PAYMENT_PROOF` step restoration is `await`ed (not
  fire-and-forget) — a transient DB error here used to silently break the
  customer's ability to retry.

## Retry path — `RESEND_PROOF`

Pipeline step 14.41: a customer whose payment was rejected can tap
`RESEND_PROOF` to re-enter the proof-upload step for the same order. This
is what makes the `paymentReviewedAt`-based lookup window (above) necessary
— without it, a retry more than `PROOF_ELIGIBLE_HOURS` after the ORIGINAL
order timestamp would silently fail to find the order.

## Related session fields

`session.paymentRetryCount`, `session.data` (holds working state during the
proof-upload step). See `.ai/business/DATA_MODELS.md` for the full `Order`
payment-related field list (`paymentMethod`, `paymentStatus`,
`paymentProof`, `paymentInitiatedAt`/`proofReceivedAt`,
`paymentReviewedBy`/`paymentReviewedAt`, `verifiedBy`/`verifiedAt`,
`rejectedNote`, `paymentReference`, `paymentReminderSentAt`).

## If you add a new payment channel

1. Add it to `Order.paymentMethod`'s enum (Rule 2 in `.ai/README.md`).
2. Add it to `BusinessConfig.payment.channels`.
3. Update `buildPaymentInstructionsUI()` to render its instructions.
4. Confirm `services/schedulerService.js`'s payment-reminder job (see
   `.ai/services/BACKGROUND_JOBS.md`) still builds a sensible
   `paymentContact` value for the new channel — it's a generic field name
   specifically because it now needs to hold either a phone number (Wave)
   or a bank account number (GT Bank/EcoBank/Trust Bank).
