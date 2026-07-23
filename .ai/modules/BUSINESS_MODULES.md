# modules/BUSINESS_MODULES.md

Every vertical follows the same shape: `modules/<vertical>/flows/index.js`
exports `<VERTICAL>_CONFIG` (steps, ui, persona, messages) plus the flow
handler function(s); some also split into `configs/`, `flows/`, `handlers/`
subdirectories (restaurant, electronics). Registered in
`core/shared/moduleRegistry.js`. Each flow handler is a `switch(step)` state
machine, called with `message: null` on first entry (via `startFlow()`) to
produce the initial UI, then with the customer's next reply on each
subsequent call.

## RESTAURANT
- Flows: `ORDER`, `BOOKING` (generic), `QUESTION`.
- `ORDER` steps: `SELECT_ITEM → QUANTITY → CONFIRM` (+ internal
  `SUGGESTION_CONFIRM`, `UPSELL`).
- `handleOrderFlow` also exports `handleRestaurantQuestion`.
- Generic `ORDER` flow (`registerGenericFlow('ORDER', handleOrderFlow)`) —
  this file is the source of the shared/generic order flow other simple
  verticals fall back to when they don't register their own `ORDER`
  handler.
- Welcome UI uses a single Interactive List (`ui.welcomeList`) rather than
  the older 3-button + "⋯ More" pattern (`ui.welcomeButtons` /
  `moreMenuButtons` are kept only because other call sites across the
  codebase — post-order "what next?", About, Cancel-All, payment
  confirmations, lead capture — still reuse that exact 3-button set; do not
  delete them).

## RETAIL (dedicated, not generic)
- Flows: `ORDER`, `PRODUCT_QUERY`.
- `ORDER` steps: `BROWSE_CATEGORY → SELECT_ITEM → SELECT_VARIANT →
  QUANTITY → FULFILMENT → CONFIRM`.
- Numeric taps inside a category browse must resolve against the
  **category-scoped** list, not the full unfiltered catalogue — this was a
  real order-accuracy bug (customer taps "2" meaning the 2nd item in the
  category they're browsing; a naive implementation resolved it against the
  full menu instead).

## DELIVERY (dedicated)
- Flow: `ORDER` only.
- Steps: `SELECT_ITEM → QUANTITY → DELIVERY_ADDRESS → DELIVERY_SLOT →
  CONFIRM`.
- Welcome buttons: Order Now / View Menu (`VIEW_MENU`, not `SHOW_MENU` —
  see `.ai/references/RECURRING_BUG_PATTERNS.md`) / Track My Order.
  Question access is via `SUPPORT`, not a 4th welcome button (Meta caps
  interactive buttons at 3; the dispatcher silently `.slice(0,3)`s any
  extra).

## BAKERY
- Flows: `ORDER`, `BOOKING` (generic — schedule a collection), dedicated
  `CAKE_CUSTOMIZATION`.
- `ORDER` steps: `BROWSE_CATEGORY → SELECT_ITEM → QUANTITY → CONFIRM`.
- `CAKE_CUSTOMIZATION` is its own registered flow/action — do not route
  cake-builder requests through generic `START_BOOKING` (a past bug did
  exactly this).

## SALON / BARBERSHOP
- Flows: dedicated `BOOKING`, `WALKIN`, `ORDER` (product sales), `QUESTION`
  — all four registered per-mode via `handleSalonBooking`,
  `handleSalonWalkIn`, `handleSalonProductOrder`, `handleSalonQuestion`
  (shared handler functions, registered separately for SALON and
  BARBERSHOP).
- `BOOKING` steps: `SELECT_SERVICE → SELECT_STYLIST → DATE → DATE_CONFIRM →
  TIME → TIME_CONFIRM → CONFIRM`.
- `WALKIN` steps: `SELECT_SERVICE → SELECT_STYLIST → CONFIRM` — deliberately
  no date/time step (walk-in queue entry is immediate).
- `QUESTION` flow has its own aftercare-detection regex and AI context
  (`AFTERCARE`, `AVAILABILITY_CHECK` intents both route here, not to
  generic `ENQUIRY`, specifically so the AI has salon/barbershop context
  rather than none).
- Welcome buttons capped at 3 (Book / Walk-In / Question); `ORDER`
  (retail-style product sales) is reachable via typing or the Question
  flow, not a 4th welcome button.

## FASHION
- Flow: `ORDER` only.
- Steps: `BROWSE_CATEGORY → SELECT_ITEM → SELECT_SIZE → SELECT_COLOR →
  QUANTITY → CONFIRM`. `SELECT_COLOR` was previously declared in config but
  never actually implemented in the flow handler — it now is; if you touch
  the fashion order flow, confirm `SELECT_COLOR` still has a real handler
  branch and isn't silently skipped.

## COSMETICS
- Flows: `ORDER`, `BOOKING` (generic — consultation), dedicated
  `SKINCARE_ADVICE`.
- `ORDER` steps: `SELECT_ITEM → QUANTITY → CONFIRM`.
- `SKINCARE_ADVICE` is AI-backed and routes through its own registered
  action — `RECOMMENDATION`/`SKINCARE_ADVICE` intents must map here, not to
  generic `ENQUIRY` (a past bug routed these to `ENQUIRY`, stripping all
  skin/product context from the AI prompt).

## ELECTRONICS
- Flows: `ORDER`, `SPEC_REQUEST`, `COMPARE`, `WARRANTY`.
- `ORDER` steps: `BROWSE_CATEGORY → SELECT_ITEM → ITEM_DETAIL → QUANTITY →
  FULFILMENT → CONFIRM`.
- `COMPARE` steps: `SELECT_FIRST → SELECT_SECOND → SHOW_COMPARISON`.
- `WARRANTY` steps: `WARRANTY_QUERY`.
- The top-level `QUESTION` action must be routed to `handleSpecRequest`
  (registered explicitly in `moduleRegistry.js` — without this, `QUESTION`
  taps in ELECTRONICS mode fall through to `startFlow('QUESTION')`, find no
  `ELECTRONICS:QUESTION` registration, and return a broken "not available"
  error UI).

## SERVICES (dedicated — quote-capture business, no fixed menu)
- Flows: `ENQUIRY`, `BOOKING` (generic), `QUOTE_FOLLOW`, `QUESTION`.
- `ENQUIRY` steps: `SERVICE_TYPE → DESCRIPTION → BUDGET → TIMELINE →
  CONTACT_CONFIRM`.
- Welcome buttons capped at 3; `QUESTION` reachable via the `ENQUIRY` flow,
  free text, or the list-type welcome message, not a 4th button.

## GENERAL (fallback/catch-all vertical)
- Flows: `QUESTION`, `ENQUIRY`, `BOOKING` (generic), dedicated `ABOUT`.
- `ENQUIRY` steps: `TOPIC → DESCRIPTION → CONTACT_CONFIRM`.
- GENERAL is the only mode with a dedicated `ABOUT` flow registered
  (`registerFlow('GENERAL', 'ABOUT', handleAbout)`); every other mode uses
  `moduleRouter.js`'s generic inline About text. If you register a new
  `ABOUT` action handler for another mode, check the `ABOUT` case in
  `moduleRouter.js` still delegates correctly rather than double-handling.
- Welcome buttons capped at 3 (Question / Enquiry / Book); About is reached
  via typed "about you"/"who are you" (caught by intent detection) or the
  Enquiry flow, not a 4th button.

## Shared `BOOKING` flow (`core/conversations/bookingFlow.js`)
Registered generically for RESTAURANT, SALON, BARBERSHOP, BAKERY,
COSMETICS, DELIVERY, SERVICES, GENERAL. Steps typically:
`SELECT_SERVICE → DATE → DATE_CONFIRM → TIME → TIME_CONFIRM → CONFIRM`.
Date/time validation uses the **business's configured local timezone** via
`Intl.DateTimeFormat`, not server UTC — same class of bug as the business-
hours timezone fix (see `.ai/references/RECURRING_BUG_PATTERNS.md`).

## Meta's 3-button cap — a recurring constraint across every module
`dispatcher.js` silently `.slice(0, 3)`s any `buttons`-type UIResponse with
more than 3 buttons — extra buttons are dropped with **no error**. Nearly
every module's `welcomeButtons` array has been deliberately trimmed to
exactly 3 entries for this reason (see the `[FIX-4BTN-*]` comments in each
module's config). When adding a 4th top-level action to any module's
welcome screen, either move to a list-type welcome (`ui.welcomeList`, no
practical cap up to 10 rows) or add a "⋯ More" secondary screen
(`ui.moreMenuButtons`) rather than appending a 4th button that will
silently vanish.
