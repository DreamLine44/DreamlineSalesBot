# flows/BOOKING_FLOW.md

Source: `core/conversations/bookingFlow.js` (920 lines — one of the largest
and most-reused files in the codebase; shared by RESTAURANT, SALON,
BARBERSHOP, BAKERY, COSMETICS, DELIVERY, SERVICES, GENERAL — 8 of 11
verticals). Registered generically (`registerGenericFlow('BOOKING',
handleBookingFlow)`) in `moduleRegistry.js`, and per-mode for every mode in
that list. SALON/BARBERSHOP additionally register their OWN dedicated
`BOOKING` handler (`handleSalonBooking`, with a stylist-selection pre-step)
that overrides this generic one — see `.ai/modules/BUSINESS_MODULES.md`.

## `handleBookingFlow({ session, message, business, tenant, isInteractive })`

Step machine, `switch(step)`:

```
SELECT_SERVICE → [PARTY_SIZE] → DATE → DATE_CONFIRM → TIME → TIME_CONFIRM → BOOKING_CONFIRM
```

- **`SELECT_SERVICE`** — customer picks from `business.services[]`
  (or, for modes without a services list, the module's own service concept).
- **`PARTY_SIZE`** — only reached for modes where group size matters
  (e.g. RESTAURANT table bookings); skipped entirely for modes like SALON
  where it's not applicable.
- **`DATE`** — free-text or quick-pick date entry. Parsed via
  `tryParseDate(dateStr, tz)`.
- **`DATE_CONFIRM`** — confirms the parsed date back to the customer before
  moving on (protects against a misparsed date silently being booked).
- **`TIME`** / **`TIME_CONFIRM`** — same pattern for time.
- **`BOOKING_CONFIRM`** — final confirmation step; on confirm, writes the
  `Booking` document via `services/bookingService.js` `saveBooking()` and
  calls `flowEngine.completeFlow()`.

## `tryParseDate(dateStr, tz)`

Exported specifically so it's independently testable and reusable. Parses
natural-language and quick-pick date strings **against the business's
configured timezone** (`Intl.DateTimeFormat`), not server UTC — same class
of timezone-correctness requirement as `isWithinBusinessHours()`. See
`.ai/references/RECURRING_BUG_PATTERNS.md` #7 for why this matters and how
it's tested. If you touch date parsing anywhere in this file, verify the
fix still resolves "today"/"tomorrow"/weekday names against `tz`, not the
server's local clock.

## Admin notification

On a new booking, an admin alert is dispatched using
`buildAdminBookingAlertBody({ customerPhone, date, time, service, business,
shortId, staff, bookingType })` (exported from
`services/adminCommandService.js`) as an **interactive buttons** message
(`CONFIRM_BOOK_<shortId>` / `DECLINE_BOOK_<shortId>`), not a typed-command
footer — see `.ai/services/ADMIN_COMMANDS.md`. There used to be a second,
now-removed `buildAdminBookingAlert()` (dead code, exported but never
called) — don't resurrect that name; `bookingFlow.js` builds its own
buttons array around `buildAdminBookingAlertBody()`'s text.

## Cancellation

`flowEngine.cancelFlow()` (not this file) owns booking cancellation — it
cancels the customer's most recent `pending`/`confirmed` `Booking` in the
DB in addition to clearing session state. Do not add a second,
bookingFlow-local cancellation path; route all "customer wants to cancel
their booking" UX through `cancelFlow()`. See
`.ai/flows/FLOW_ENGINE.md` and `.ai/references/RECURRING_BUG_PATTERNS.md` #10.

## Adding a new booking-capable vertical

If the new vertical's booking needs match the generic flow (service → date
→ time → confirm, optionally party size), just add its mode string to the
generic registration list in `moduleRegistry.js` — do not write a new
booking flow file. Only write a dedicated flow (like SALON's) if you need a
genuinely different step sequence (e.g. a stylist/resource-selection step
before date/time).
