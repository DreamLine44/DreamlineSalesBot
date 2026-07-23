# services/ADMIN_COMMANDS.md

Source: `services/adminCommandService.js` (~1000 lines — one of the most
heavily audit-fixed files in the codebase; its header comment is
effectively a complete changelog worth reading in full before editing it).

## Command vocabulary

Admins issue commands either by typing them as plain WhatsApp text, or by
tapping an interactive button whose ID encodes the same command
(`APPROVE_<shortId>`, `REJECT_<shortId>`, etc.) — both paths converge on
the same underlying functions.

| Typed command | Button ID prefix | Handler |
|---|---|---|
| `APPROVE <shortId>` | `APPROVE_<shortId>` | `confirmPayment()` |
| `REJECT <shortId>` | `REJECT_<shortId>` | `rejectPayment()` |
| `CONFIRM BOOK <shortId>` | `CONFIRM_BOOK_<shortId>` | `confirmBooking()` |
| `DECLINE BOOK <shortId> [reason]` | `DECLINE_BOOK_<shortId>` | `declineBooking()` |
| — | `READY_<shortId>` | `markOrderReady()` |
| `RESUME BOT <phone>` | `RESUME_BOT_<phone>` | `resumeBot()` |
| `RESUME BOT` (no phone) | — | `resumeBot()` — resumes the most recent human-mode session, warns if more than one is still active |

`shortId` regex: `[A-Z0-9]{4,24}` (alphanumeric, not hex-only — widened
after a real bug where non-hex shortIds like `A1B2G3` were silently
rejected). `RESUME BOT <phone>` accepts dashed/parenthesised formats
(`+220-353-2423`, `(220) 353-2423`) via `[\d+\s().\-/]+`, then strips all
non-digit characters for lookup.

Entry points: `handleAdminButtonReply(buttonId, tenantId, adminPhone,
tenantDoc, business)` and `handleAdminTextCommand(text, tenantId,
adminPhone, tenantDoc, business)`. `handleAdminTextCommand` explicitly
detects "looks like a command but didn't match" (`/^(APPROVE|REJECT|CONFIRM|
DECLINE|RESUME|MARK)\b/i`) and returns a help message rather than silently
dropping it — **never make an admin command path return `null`/silence on
a malformed-but-recognizable command; return an explicit error instead.**

## `isAdminPhone(senderPhone, tenantId, business?, tenantDoc?)`

Accepts optional pre-fetched `business`/`tenantDoc` — `webhookController.js`
already has both loaded by the time it checks admin phones, so passing them
through avoids 3 redundant DB reads on every single admin message. If you
add a new call site, pass these through if you already have them.

## Concurrency / idempotency guarantees (`[FIX-CMD-14]`)

`confirmPayment` / `rejectPayment` / `confirmBooking` / `declineBooking`
each use a **single atomic `findOneAndUpdate` with the guard condition
baked into the filter** — not a separate `findOne` then `updateOne`. This
closes two real bugs:
- A double-tapped admin button (slow network, impatience) firing two
  concurrent calls that both pass an in-memory guard check before either
  write lands — previously caused duplicate customer notifications and
  double-run session/analytics updates.
- `confirmPayment` previously only checked `paymentStatus` (not `status`),
  so an already-cancelled order could be resurrected by `APPROVE`;
  `rejectPayment` previously only checked `status` (not `paymentStatus`),
  so an already-confirmed order could be reverted by `REJECT`. Both guards
  now check both fields.

**If you add a new admin state-transition command, follow this exact
pattern** — single atomic `findOneAndUpdate` with the full guard condition
in the filter, checking every field that defines "is this transition even
valid from the current state," not just the one field that happens to be
top of mind.

## Failure handling (`[FIX-CMD-15]`)

Every one of the four core commands is wrapped in try/catch. Previously an
unguarded DB call that threw propagated up through
`webhookController.js`'s `.catch(() => null)`, meaning the admin's button
tap produced **zero response** — no success message, no error, nothing.
Now every failure path returns an explicit "something went wrong" message.
**Any new admin command handler must follow this same rule: never let an
admin action fail silently.**

## `resumeBot(customerPhone, tenantId, tenantDoc)`

Clears `humanMode` and dispatches a message to the customer confirming the
bot is active again (a customer should never be left in limbo not knowing
whether a human or the bot will respond next). `RESUME BOT` with no phone
resolves the most recent human-mode session and, if more than one customer
is currently in human-mode, tells the admin the count so they know others
are still waiting — previously only one was resumed with zero indication
others existed.

## What NOT to do here

- Don't reintroduce a `findOne`-then-`updateOne` pattern for any new
  approve/reject/confirm/decline-shaped command — see the concurrency note
  above.
- Don't let a new command handler return `null`/silence on any failure
  path — every admin action needs an explicit outcome message.
- Don't hand-roll a new payment/booking state guard without checking both
  the `status` AND `paymentStatus` fields (for orders) the way
  `[FIX-CMD-14]` does — checking only one field is exactly how the
  resurrection/reversion bugs happened.
