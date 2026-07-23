# flows/FLOW_ENGINE.md

Source: `core/conversations/flowEngine.js`, `core/conversations/moduleRouter.js`,
`core/shared/moduleRegistry.js`.

## `flowEngine.js`

- `FLOW_REGISTRY: Map<"${MODE}:${FLOW}", handler>` — mode-specific handlers.
- `GENERIC_REGISTRY: Map<"${FLOW}", handler>` — shared across modes (e.g.
  `BOOKING` is registered generically for RESTAURANT, SALON, BARBERSHOP,
  BAKERY, COSMETICS, DELIVERY, SERVICES, GENERAL via
  `core/conversations/bookingFlow.js`; generic `ORDER` is registered from
  `modules/restaurant/flows/orderFlow.js`).
- `advance({ session, message, business, tenant, isInteractive })` — looks
  up mode-specific handler first, generic second. If neither exists, or the
  handler throws, returns a safe `"⚠️ Something went wrong"` UIResponse with
  a `SHOW_MENU` button rather than propagating an error to the customer.
- `startFlow({ flowName, session, business, tenant })` — resets session
  (`currentFlow`, `step: null`, `data: {}`, `upsellSent: false`,
  `menuViewed: false`, `lastAorInterceptAt: null`) via a single
  `updateSession()` call (the returned document IS the fresh session — no
  redundant re-read), then invokes the handler once with `message: null` to
  produce the first-step UI.
- `cancelFlow(session, business)` — clears session flow state AND cancels
  the customer's most recent `pending`/`confirmed` `Booking` (non-fatal on
  failure). This booking-cancel was moved here specifically so every caller
  (webhookController's global escape, postFlowHandler's
  `handleBookingConfirmed`/`handleWalkInQueueAck`) gets real DB cancellation
  for free instead of each remembering to do it. Returns mode-appropriate
  welcome buttons, never a "type a keyword" instruction.
- `completeFlow(session, completedFlow, business?, tenant?)` — writes
  `postFlowAck = completedFlow.toUpperCase()` so the next "thanks"/"ok" gets
  a warm contextual reply instead of the full welcome menu (see
  `.ai/flows/POST_FLOW.md`). Also evaluates lead-capture triggers:
  `ORDER_COMPLETING_FLOWS = {'ORDER'}` → `AFTER_ORDER`,
  `BOOKING_COMPLETING_FLOWS = {'BOOKING','WALKIN'}` → `AFTER_BOOKING`.
  These are explicit allowlists — everything else (QUESTION, ENQUIRY, ABOUT,
  SPEC_REQUEST, WARRANTY, SKINCARE_ADVICE, QUOTE_FOLLOW) intentionally
  triggers no lead capture at all.

## `moduleRouter.js`

`route({ action, intent, session, message, business, tenant, isInteractive,
suggestion })` is a `switch(action)` with cases including: `ACKNOWLEDGE`,
`CONTINUE_FLOW`, `GREET`, `VIEW_MENU`, `SHOW_MENU`, `MORE_MENU`,
`MAIN_MENU`, `BROWSE_CATALOG`, `RESCHEDULE`, `CANCEL`, `CANCEL_ALL`,
`SUPPORT`, `TRACK_ORDER`, `REPEAT_ORDER`, `FALLBACK`/`CLARIFY`, `ABOUT`,
`QUOTE_FOLLOW`, `DONE`, `PAYMENT`, `ENQUIRY`, `QUESTION`. After the switch,
any unhandled action falls through to `ACTION_REGISTRY.get(upper)`.

Several cases (`ABOUT`, `QUOTE_FOLLOW`, `ENQUIRY`, `QUESTION`) deliberately
check `ACTION_REGISTRY` **first**, before running their inline default
behavior — this lets a module register a more specific handler that
overrides the generic one. If you register a new action for one of these,
verify the corresponding switch case still delegates correctly rather than
shadowing your registration.

`buildWelcomeSequence(business, cfg)` builds the GREET/MAIN_MENU welcome UI
(most modules use a single Interactive List; see each module's `configs`
file for its `ui.welcomeList` / `ui.welcomeButtons` / `ui.moreMenuButtons`).

`ACTION_REGISTRY: Map<actionName, handler>` — populated exclusively by
`registerAction()` calls in `moduleRegistry.js`.

## `moduleRegistry.js` — `registerAllModules()`

Runs once at boot from `app.js`. For each vertical:
```js
const { handleXFlow } = await import('../../modules/x/flows/index.js');
registerFlow('X_MODE', 'FLOW_NAME', handleXFlow);
```
Plus shared/generic registrations and every `registerAction(...)` call for
cross-module actions (`START_ORDER`, `START_BOOKING`, `WALKIN`,
`CAKE_CUSTOMIZATION`, `SKINCARE_ADVICE`, `SPEC_REQUEST`, `COMPARE`,
`WARRANTY`, `ENQUIRY`, `QUESTION`, `QUOTE_FOLLOW`, `ABOUT`, `PRODUCT_QUERY`,
`REPEAT_ORDER`, `TRACK_ORDER`).

Two behaviors worth understanding before you touch this file:

- **`START_ORDER`** branches on whether the tenant has WA Catalog enabled
  (`isCatalogEnabled(business) && hasSellableProducts(business)`, both pure
  synchronous checks imported statically at the top of the file — zero I/O,
  zero dynamic import, on the path every non-catalog tenant takes). If not,
  it goes straight to `startFlow({ flowName: 'ORDER', ... })` — the exact
  call this codebase made before WA Catalog existed. Only catalog-enabled
  tenants take the dynamic-import path into `waCatalogFlow.js`, and even
  that path falls back to `startFlow('ORDER')` on any failure — WA Catalog
  can never become a dead end.
- **`REPEAT_ORDER`** re-resolves the full menu item (price, image) by name
  from the current menu rather than trusting the stored order's bare item
  string — `Order.item` is a plain string with no price, so writing it
  straight into session data used to silently total the repeat order at
  D0 and skip the payment step entirely.

## Checklist: adding a brand-new business vertical

1. Create `modules/<vertical>/flows/index.js` exporting flow handlers +
   the module's `<VERTICAL>_CONFIG` (steps, `ui.welcomeList`, persona,
   messages).
2. If it needs a config/UI split, mirror the `configs/` + `flows/` +
   `handlers/` pattern used by `restaurant`/`electronics`.
3. Register every flow in `moduleRegistry.js`:
   `registerFlow('<VERTICAL>', '<FLOW>', handler)`.
4. Add the mode to `config/modes.js` `MODE_MAP`.
5. Add the mode string to every relevant Mongoose `enum` (`BusinessConfig.businessMode`
   at minimum — see Rule 2 in `.ai/README.md`).
6. If the vertical books appointments, it's usually enough to add it to the
   generic `BOOKING` registration list in `moduleRegistry.js` rather than
   writing a bespoke booking flow — check `core/conversations/bookingFlow.js`
   first.
7. Add any new intents/keywords per the checklist in
   `.ai/flows/INTENT_DETECTION.md`.
8. Add flow-internal button IDs to `webhookController.js`'s
   `isFlowPassthroughId()` / `STEP_VALID_BUTTONS` / `STEP_HINTS`.
9. Write regression tests under `tests/` per `.ai/development/TESTING.md`.
