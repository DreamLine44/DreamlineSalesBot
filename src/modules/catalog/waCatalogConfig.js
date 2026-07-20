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
 * [FIX-CATALOG-3BTN] dispatcher.js's 'buttons' UI type hard-caps at 3
 * (`.slice(0, 3)`, silent truncation), and WhatsApp itself never supports
 * more than 3 native reply buttons in one message. Every vertical's
 * welcomeButtons config already uses all 3 slots (Order/Book/Question or
 * similar), so simply appending Browse Catalog as a 4th option has exactly
 * two possible outcomes: it silently vanishes (dispatcher's `.slice(0,3)`),
 * or — if the caller instead falls back to a WhatsApp *list* message once
 * the combined set exceeds 3 — every option, catalog included, gets buried
 * behind a "Choose an option ▾" tap-to-expand control. Both outcomes are
 * explicitly rejected here: this function ALWAYS returns a `{ buttons }`
 * payload with at most 3 entries, and NEVER produces a `rows`/list payload.
 * When the combined set (existing buttons + Browse Catalog) still fits
 * within 3, Browse Catalog is simply inserted (see insertIdx below, before
 * the final "help/question" slot). When it would exceed 3 — the case every
 * vertical's welcomeButtons hits in practice, since all 3 slots are already
 * used — Browse Catalog REPLACES the QUESTION slot specifically, not just
 * "the last slot": most verticals put QUESTION last, but GENERAL mode puts
 * it first, and picking by id keeps this correct regardless of a given
 * vertical's button order. Verticals with no QUESTION button at all
 * (delivery, electronics) fall back to replacing the final slot, matching
 * the original "next to the help action" placement intent. Losing the
 * Question button from the welcome screen doesn't remove the feature — a
 * typed question is answered exactly the same way whether or not its
 * button is visible (see INTENT_PATTERNS.QUESTION / the direct-question-
 * phrase matcher in intentEngine.js — no tap has ever been required for it).
 */
export function withCatalogWelcomeOption(buttons, _business) {
  const base = buttons || [];

  const catalogOption = {
    id: 'BROWSE_CATALOG', title: '🛍 Browse Catalog',
    description: 'Shop our products & collections',
  };

  if (base.length === 0) return { buttons: [catalogOption] };

  // Insert before the final slot first — if the combined set still fits
  // within the 3-button cap, nothing needs to be dropped and every
  // original option is kept, in the same placement as before.
  const insertIdx = base.length - 1;
  const inserted  = [...base.slice(0, insertIdx), catalogOption, ...base.slice(insertIdx)];
  if (inserted.length <= 3) return { buttons: inserted };

  // Combined set would exceed 3 — replace the QUESTION slot (or the final
  // slot if there is no QUESTION button) instead of falling back to a list.
  const questionIdx = base.findIndex(b => b.id === 'QUESTION');
  const replaceIdx  = questionIdx !== -1 ? questionIdx : base.length - 1;

  const combined = base.map((b, i) => (i === replaceIdx ? catalogOption : b));
  return { buttons: combined };
}
