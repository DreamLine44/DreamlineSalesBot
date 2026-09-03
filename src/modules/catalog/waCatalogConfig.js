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
// existing classification path (core/nlu/classification/intentEngine.js — button tap,
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
 * true only when the tenant has opted in, configured a real Meta Commerce
 * Catalog ID, AND actually completed at least one successful sync of their
 * products into that catalog.
 *
 * [FIX-CATALOG-UNSYNCED] enabled:true + catalogId set is NOT the same thing
 * as "ready to show customers" — a tenant can flip the toggle and paste a
 * catalogId during onboarding well before they ever run syncMenuToCatalog()
 * (see waCatalogService.js), or a sync can fail outright and leave
 * lastSyncError set with lastSyncedAt still null. Before this fix, that
 * half-configured state still passed isCatalogEnabled(), which meant:
 *   - shouldOfferCatalog() could return true and send a product_list/
 *     catalog_message referencing retailer_ids that don't exist in Meta's
 *     catalog yet.
 *   - Meta's Send API does not validate retailer_id existence synchronously,
 *     so the send can succeed (200 OK, sendCatalogMessage returns non-null)
 *     while the customer actually sees a broken or empty catalog card —
 *     not the "silent fallback to normal ORDER flow" the failure-handling
 *     contract elsewhere in this file promises, because nothing actually
 *     failed from the code's point of view.
 *   - shouldShowCatalogButton() would surface a "🛍 Browse Catalog" welcome
 *     button that leads to that same broken experience.
 * Requiring a real lastSyncedAt (and at least one synced retailer_id) closes
 * this gap: until a tenant's first sync actually succeeds, every catalog
 * entry point below falls straight through to the tenant's normal, always-
 * working text/list menu — exactly like a tenant who never enabled WA
 * Catalog at all.
 */
export function isCatalogEnabled(business) {
  const wc = business?.waCatalog;
  return !!(
    wc?.enabled &&
    wc?.catalogId &&
    wc?.lastSyncedAt &&
    Array.isArray(wc?.syncedRetailerIds) &&
    wc.syncedRetailerIds.length > 0
  );
}

/**
 * hasSellableProducts(business)
 * Mirrors the `available !== false` filter every vertical module already
 * applies to business.menuItems before building its own product list UI.
 */
export function hasSellableProducts(business) {
  return (business?.menuItems || []).some(i => i.available !== false);
}

/** Remove legacy text-menu actions from responses once WA Catalog is ready. */
export function suppressLegacyMenuOption(response, business) {
  if (!isCatalogEnabled(business) || !hasSellableProducts(business) || response == null) return response;
  if (Array.isArray(response)) {
    return response.map(item => suppressLegacyMenuOption(item, business));
  }
  if (typeof response !== 'object') return response;

  const next = { ...response };
  if (Array.isArray(next.buttons)) {
    next.buttons = next.buttons.filter(button => button?.id !== 'VIEW_MENU');
    if (next.buttons.length === 0) {
      next.buttons = [{ id: 'BROWSE_CATALOG', title: '🛍 View Items' }];
    }
  }
  // [FIX-CATALOG-EMPTY-LIST] Flat 'rows' (used by every module's product/menu
  // list — see dispatcher.js buildPayload's 'list' branch) was ONLY filtered
  // here, unlike the 'buttons' branch just above which falls back to a
  // BROWSE_CATALOG button when filtering empties the array. A list whose only
  // row was 'VIEW_MENU' (the common case for a tenant with a single legacy
  // menu entry point) filtered down to a LIST MESSAGE WITH ZERO ROWS.
  // dispatcher.js's buildPayload guards exactly that case —
  // `if (!sections.length || !sections[0].rows.length) return null;` — so the
  // whole message was silently dropped and dispatched as nothing at all. The
  // customer never saw a "View Items" row (or ANY row) to tap — from their
  // side, the bot just went silent right where the catalog button-replacement
  // logic clearly intended them to see one. Mirrors the buttons branch: fall
  // back to a single BROWSE_CATALOG row so the list always has something to
  // send instead of ending up empty.
  const VIEW_ITEMS_ROW = {
    id:          'BROWSE_CATALOG',
    title:       '🛍 View Items',
    description: 'Browse our full catalog',
  };
  if (Array.isArray(next.rows)) {
    next.rows = next.rows.filter(row => row?.id !== 'VIEW_MENU');
    if (next.rows.length === 0) {
      next.rows = [VIEW_ITEMS_ROW];
    }
  }
  // [FIX-CATALOG-EMPTY-LIST] Multi-section lists (ui.sections — e.g. a
  // welcomeList config) weren't touched by this function at all, so a
  // VIEW_MENU row nested inside a section survived every catalog-ready
  // filter this function performs elsewhere. Apply the same per-section
  // filter + fallback so a section that becomes empty after removing
  // VIEW_MENU doesn't leave a titled section with zero rows (dispatcher.js
  // drops any section reduced to zero rows once MAX_TOTAL_ROWS bookkeeping
  // runs, which can just as easily zero out the whole message).
  if (Array.isArray(next.sections)) {
    next.sections = next.sections
      .map(sec => {
        if (!Array.isArray(sec?.rows)) return sec;
        const rows = sec.rows.filter(row => row?.id !== 'VIEW_MENU');
        return { ...sec, rows };
      })
      .filter(sec => !Array.isArray(sec?.rows) || sec.rows.length > 0);
    const hasAnyRow = next.sections.some(sec => Array.isArray(sec?.rows) && sec.rows.length > 0);
    if (!hasAnyRow) {
      next.sections = [{ title: undefined, rows: [VIEW_ITEMS_ROW] }];
    }
  }
  return next;
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
 * [CATALOG-UX-BUTTON] Merges a "🛍 Browse Catalog" option into an existing
 * welcome-menu button set for tenants where shouldShowCatalogButton() is
 * true — a no-op ({ buttons }, unchanged) for every tenant who hasn't
 * enabled WA Catalog.
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
export function withCatalogWelcomeOption(buttons, business) {
  const base = buttons || [];
  if (!shouldShowCatalogButton(business)) return { buttons: base };

  const combined = [...base, { id: 'BROWSE_CATALOG', title: '🛍 Browse Catalog' }];
  if (combined.length <= 3) return { buttons: combined };
  return { rows: combined.map(b => ({ id: b.id, title: b.title })) };
}
