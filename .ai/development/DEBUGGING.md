# development/DEBUGGING.md

Quick lookup: symptom → where to look first. This codebase's dominant bug
class is **silent failure** (data dropped, message never sent, action never
wired) — so "nothing happened and there's no error" is the normal failure
mode here, not the exception. Start with this file before adding new
logging or assuming the reporter is mistaken.

## "A customer's tap/message got no reply at all"

1. Check `core/whatsapp/dispatcher.js` logs for `[Dispatch] ✗` — malformed
   payload (`buildPayload` returned `null`), missing credentials, or a Meta
   4xx/5xx. `dispatchMessage()` is supposed to fall back to plain text
   rather than truly go silent, so if there's genuinely nothing in the
   Dispatch logs, the pipeline never reached dispatch at all — check step 2
   below.
2. Check whether the button ID is in `BUTTON_ID_MAP` (`core/intents/patterns.js`)
   or, if it's a flow-internal step button, in `isFlowPassthroughId()` /
   `STEP_VALID_BUTTONS` (`controllers/webhookController.js`) — an unmapped
   interactive ID inside an active flow becomes `CONTINUE_FLOW`, which the
   flow handler may not expect from that step.
3. Check `flowEngine.advance()` — did the handler throw? It swallows
   exceptions into a generic "Something went wrong" reply and logs
   `[FlowEngine] Handler threw` — that log line, if present, is your actual
   stack trace source.
4. Check whether a new field this code path writes is actually declared in
   its Mongoose schema (see `.ai/business/DATA_MODELS.md`) — a silently
   dropped field can produce state that looks internally inconsistent two
   or three steps later, not at the point of the actual write.

## "A field/setting the operator configured has no effect"

Almost always Rule 1 (undeclared schema field) or Rule 2 (value not in an
enum). Grep the model file for the field name; if it's not there, that's
the bug. Second most common cause: a nested-object `$set` replacing an
entire subdocument instead of merging (see the `waCatalogPartialUpdate`
fix pattern in `.ai/development/TESTING.md`) — check whether the update
uses dot-notation flattening for nested objects.

## "A menu/list message is missing items, or Meta returned a 400"

Check `.ai/whatsapp/DISPATCHER_AND_LIMITS.md` — almost certainly the
10-rows-total (not per-section) or 30-products-total (not per-section) cap.
Confirm the caller isn't pre-truncating with its own (possibly wrong)
assumption about the limit; let `dispatcher.js` enforce it.

## "Business hours / booking date-time logic looks wrong near a timezone
boundary"

Check whether the code is resolving "today"/weekday against the SERVER
clock (`new Date().getDay()`) instead of the BUSINESS's configured
timezone (`Intl.DateTimeFormat` with `business.hours.timezone`). See
`tests/businessHours.test.mjs` for the exact pattern this bug takes and how
it's tested.

## "An admin action (confirm/reject order or booking) had a side effect on
an unrelated session setting (e.g. human-mode TTL reset)"

Check `core/sessions/sessionService.js` `updateSession()` — specifically
whether the TTL recompute path is correctly looking up existing
`humanMode` from the DB when the current patch doesn't mention `humanMode`
explicitly. See `.ai/business/SESSION_RULES.md`.

## "A flow was cancelled but a stale Booking/Order record is still showing
as active"

Check `flowEngine.cancelFlow()` — confirm the DB-side cancellation
(`Booking.findOneAndUpdate(..., { status: 'cancelled' })`) actually runs;
this exact bug (session cleared but DB record left `pending`/`confirmed`)
has recurred more than once in this codebase's history via botched merges
of the fix.

## "Something about WA Catalog looks broken for one tenant but not others"

Check `isCatalogEnabled(business)` — requires `enabled && catalogId &&
lastSyncedAt && syncedRetailerIds.length > 0`, NOT just
`enabled && catalogId`. A tenant that toggled the feature but never
completed a successful sync should behave identically to a tenant who
never enabled it at all — if it doesn't, that's the bug. See
`.ai/modules/CATALOG.md`.

## General debugging workflow for this codebase

1. Reproduce via `SIMULATION_MODE=true` + `POST /api/message`
   (`controllers/simulateController.js`) rather than a live WhatsApp
   round-trip where possible — much faster iteration.
2. Read the actual code path with `grep`/`view`, don't guess from a
   filename or a comment — comments in this codebase are unusually
   detailed and trustworthy, but the underlying behavior is still ground
   truth.
3. Once you've found the real bug, write the regression test FIRST (so you
   can confirm it fails pre-fix), then apply the surgical fix, tagged
   `[AUDIT-FIX-<NAME>]` or similar, per `.ai/README.md`'s methodology.
4. Run the full suite before considering it done.
