/**
 * modules/catalog/waCatalogConfig.js
 *
 * [CATALOG-CONFIG] Feature-flag + mode constants for the WA (Meta) Commerce
 * Catalog integration. Single source of truth for the waCatalog.mode enum
 * and the guard functions every other catalog file relies on to decide
 * whether WA Catalog applies to a given tenant/message at all.
 *
 * Naming: always "WA Catalog" / "Commerce Catalog" / "WhatsApp Catalog" in
 * code, comments, and commit messages — never bare "catalog", which the
 * codebase already uses for BusinessConfig.menuItems product matching
 * (see matchEngine.js findBestMatch() and the `catalog` variable in
 * webhookController.js).
 */

export const WA_CATALOG_MODES = Object.freeze({
  AI_DECIDES:   'AI_DECIDES',
  ALWAYS_OFFER: 'ALWAYS_OFFER',
  MANUAL_ONLY:  'MANUAL_ONLY',
});

export const DEFAULT_WA_CATALOG_MODE = WA_CATALOG_MODES.AI_DECIDES;

// [CATALOG-CONFIG-1] Intents that represent open-ended "I want to see what
// you have" browsing, reusing the intent value ALREADY produced by the
// existing classification path (core/intents/intentEngine.js — button tap,
// keyword match, direct-phrase regex, or Groq AI classify; see
// intentToAction() there for the full mapping). No new keyword list and no
// new AI intent category were added anywhere in the codebase for this —
// WA Catalog rides entirely on intent values the platform already produces
// today, exactly as the integration spec requires ("AI decides ... via the
// existing Groq intent-classification path, not a new keyword if-chain").
//
// Deliberately EXCLUDES 'CHECKOUT' (the customer has already said they're
// ready to pay — showing a browsable catalog instead would be a step
// backwards) and 'REMOVE_FROM_CART' (cart-management context, not a fresh
// browse). Both still reach the normal ORDER flow unchanged.
//
// [FIX-CATALOG-DEADINTENT] Only intents that can actually reach this check
// belong here. shouldOfferCatalog() is only ever consulted from inside the
// START_ORDER ACTION handler (moduleRegistry.js [CATALOG-REG-1]), which only
// runs once intentEngine.js's intentToAction() has already mapped the
// classified *intent* to the *action* 'START_ORDER'. 'START_ORDER' is only
// ever produced as an action value (the intent in that case is 'ORDER'), so
// it can never appear as `intent` here. And intentToAction() maps the
// 'RECOMMENDATION' intent to the 'ENQUIRY' action, not 'START_ORDER' — a
// RECOMMENDATION-classified message never reaches this code path at all.
// Both were previously listed here but were dead: only 'ORDER' and
// 'ADD_TO_CART' are intents that actually route through START_ORDER.
const BROWSE_INTENTS = new Set(['ORDER', 'ADD_TO_CART']);

/**
 * isCatalogEnabled(business)
 * true only when the tenant has both opted in AND configured a real
 * Meta Commerce Catalog ID. enabled:true with no catalogId is treated as
 * "not actually configured yet" rather than a misconfiguration error —
 * onboarding may enable the toggle before the catalogId is set.
 */
export function isCatalogEnabled(business) {
  return !!(business?.waCatalog?.enabled && business?.waCatalog?.catalogId);
}

/**
 * hasSellableProducts(business)
 * Mirrors the `available !== false` filter every vertical module already
 * applies to business.menuItems before building its own product list UI.
 */
export function hasSellableProducts(business) {
  return (business?.menuItems || []).some(i => i.available !== false);
}

/**
 * shouldOfferCatalog({ business, intent })
 * The single decision point for whether a START_ORDER-routed message should
 * open with WA Catalog instead of the module's own text/list product browser.
 * Returns false (never true) for any tenant that hasn't explicitly opted in —
 * this is the guarantee behind "zero behavioural change for tenants who never
 * enable WA Catalog".
 */
export function shouldOfferCatalog({ business, intent }) {
  if (!isCatalogEnabled(business) || !hasSellableProducts(business)) return false;

  const mode = business?.waCatalog?.mode || DEFAULT_WA_CATALOG_MODE;

  // MANUAL_ONLY: never offered automatically off the back of a classified
  // intent — see shouldShowCatalogButton() below for this mode's actual
  // trigger, the explicit "🛍 Browse Catalog" welcome-menu button.
  if (mode === WA_CATALOG_MODES.MANUAL_ONLY) return false;

  if (mode === WA_CATALOG_MODES.ALWAYS_OFFER) return true;

  // AI_DECIDES (default)
  return BROWSE_INTENTS.has(intent);
}

/**
 * shouldShowCatalogButton(business)
 * [CATALOG-UX-BUTTON] The explicit trigger MANUAL_ONLY was reserved for —
 * previously the mode existed in the schema but had no way to ever actually
 * fire. A customer who just says "hi" (GREET, never reaching START_ORDER)
 * also never saw WA Catalog as an option under any mode, since
 * shouldOfferCatalog() is only ever consulted from inside START_ORDER.
 *
 * Shown for every enabled + configured tenant with sellable products,
 * regardless of mode: this button is a customer-initiated tap, not an
 * automatic offer, so AI_DECIDES / ALWAYS_OFFER / MANUAL_ONLY all treat it
 * the same way — "the customer can always ask to see the catalog," which is
 * a strict UX superset of whatever the automatic-offer mode already does.
 */
export function shouldShowCatalogButton(business) {
  return isCatalogEnabled(business) && hasSellableProducts(business);
}

/**
 * withCatalogWelcomeOption(buttons, business)
 * [CATALOG-UX-BUTTON] Merges a "🛍 Browse Catalog" option into every
 * tenant's welcome-menu button set — unconditionally, by explicit product
 * decision, regardless of shouldShowCatalogButton()/WA Catalog enablement.
 * The welcome menu should look and read the same for every tenant, catalog
 * configured or not; the button itself stays safe to show even with no WA
 * Catalog set up because browseCatalogExplicit() (waCatalogFlow.js) already
 * falls back gracefully to the module's normal ORDER/product flow whenever
 * sendCatalogMessage() reports the catalog isn't actually configured — a tap
 * never dead-ends, it just quietly behaves like "Order Food" for tenants who
 * haven't turned WA Catalog on yet. shouldShowCatalogButton() is kept as a
 * named export for any future call site that still needs the real
 * enabled+configured check (e.g. deciding whether to *promote* the catalog
 * automatically) — it's simply no longer consulted here.
 *
 * dispatcher.js's 'buttons' UI type hard-caps at 3 (`.slice(0, 3)`, silent
 * truncation) — every vertical's welcomeButtons config already uses all 3
 * slots (Order/Book/Question or similar), so simply appending a 4th button
 * would silently vanish, which is worse than not adding it at all (looks
 * like a bug, not a missing feature). When the combined set fits in 3, it's
 * returned as `buttons` (unchanged rendering). When it doesn't,
 * `rows` is returned instead — the caller renders a 'list' message
 * (dispatcher.js's list type, used throughout this codebase for >3 options),
 * which shows every option with nothing silently dropped. Button IDs are
 * identical either way, so BUTTON_ID_MAP / numeric shortcuts keep working
 * regardless of which shape a given tenant ends up rendering.
 */
export function withCatalogWelcomeOption(buttons, _business) {
  const base = buttons || [];

  const catalogOption = {
    id: 'BROWSE_CATALOG', title: '🛍 Browse Catalog',
    description: 'Shop our products & collections',
  };

  // [FIX-CATALOG-ORDER] Insert Browse Catalog before the final option rather
  // than appending it after every other option — every vertical's
  // welcomeButtons ends with its "help/question" action, and that reads best
  // as the last item in the list, with the browsable/transactional options
  // (order/book/catalog) grouped together ahead of it. Generic "before the
  // last item" (rather than hunting for a specific id) keeps this correct
  // even for verticals whose button order doesn't end in QUESTION.
  const insertIdx = base.length > 0 ? base.length - 1 : 0;
  const combined = [...base.slice(0, insertIdx), catalogOption, ...base.slice(insertIdx)];

  if (combined.length <= 3) return { buttons: combined };
  // [FIX-CATALOG-DESC] Preserve each option's `description` (not just id/title)
  // so the rendered WhatsApp list shows a helpful subtitle under every row —
  // dropping it here silently degraded the list to bare titles even when the
  // caller had supplied a description.
  return { rows: combined.map(b => ({ id: b.id, title: b.title, description: b.description })) };
}

// [WELCOME-MENU-PAGING] How many options show directly on the main welcome
// screen before the rest get tucked behind "⋯ More". Meta's WhatsApp
// Business Cloud API hard-caps reply-button messages at 3 buttons per
// message — reserving the 3rd primary slot for "⋯ More" keeps every screen
// this produces at or under that cap.
const MAIN_MENU_PRIMARY_COUNT = 2;

/**
 * buildWelcomeMenu(buttons, business)
 * [WELCOME-MENU-PAGING] Wraps withCatalogWelcomeOption() so the welcome
 * screen (GREET / SHOW_MENU) ALWAYS renders as real, directly-tappable
 * WhatsApp reply buttons — by explicit product decision, never a list
 * message, because a list always requires an extra "expand" tap (Meta's
 * own list-message UI) even just to see the first option, which is exactly
 * the friction this was built to remove.
 *
 * - Combined option count <= 3: returned as one screen, `{ main: { buttons } }`.
 * - Combined option count > 3 (the common case once Browse Catalog is
 *   merged in): split into two stateless screens —
 *     main: the first 2 options + a "⋯ More" button (3 buttons total)
 *     more: the remaining options + a "🏠 Main Menu" button back (see
 *           moduleRouter.js's MORE_MENU / MAIN_MENU cases)
 *   Every current vertical's combined count is exactly 4 (3 base buttons +
 *   Browse Catalog), so `more` is always exactly 3 buttons too — no page
 *   ever needs more than one tap to reach or exceeds the button cap. If a
 *   future vertical's welcomeButtons ever grows large enough that `more`
 *   would exceed 3, it falls back to a list message there (never silently
 *   drops an option) — a safety net, not the expected path today.
 *
 * Both screens are recomputed fresh from the tenant's own config on every
 * tap rather than cached on the session — MORE_MENU / MAIN_MENU work
 * identically however the customer got there, with no extra session state
 * to keep in sync.
 */
export function buildWelcomeMenu(buttons, business) {
  const merged = withCatalogWelcomeOption(buttons, business);
  const combined = merged.rows || merged.buttons;

  if (combined.length <= 3) return { main: { buttons: combined } };

  const primary = combined.slice(0, MAIN_MENU_PRIMARY_COUNT);
  const secondary = [
    ...combined.slice(MAIN_MENU_PRIMARY_COUNT),
    { id: 'MAIN_MENU', title: '🏠 Main Menu' },
  ];

  const more = secondary.length <= 3
    ? { buttons: secondary }
    : { rows: secondary.map(b => ({ id: b.id, title: b.title, description: b.description })) };

  return {
    main: { buttons: [...primary, { id: 'MORE_MENU', title: '⋯ More' }] },
    more,
  };
}

