// tests/auditFixButtonsMenuSystemic.test.mjs
//
// Regression tests for a systematic audit pass across buttons/menu features:
//
//   1. [AUDIT-FIX-CATALOG-WELCOME] waCatalogConfig.js's withCatalogWelcomeOption()
//      was fully implemented but never actually called from production code —
//      the same "implemented but unwired" bug class NAV-META3 already fixed
//      once for the BROWSE_CATALOG BUTTON_ID_MAP entry. Catalog-enabled tenants
//      on any mode other than RESTAURANT had no way to ever see "🛍 Browse
//      Catalog" on their welcome menu. Now wired into buildWelcomeSequence().
//      RESTAURANT is intentionally excluded (it already surfaces Browse
//      Catalog via its own static moreMenuButtons "⋯ More" submenu).
//
//   2. [AUDIT-FIX-MAINMENU-COLLISION] 'main menu' used to live in VIEW_MENU's
//      keyword list, predating the NAV-META3 'MAIN_MENU' button/action. Typing
//      "main menu" therefore showed the product menu (VIEW_MENU → startFlow
//      ORDER), while tapping the "🏠 Main Menu" button replayed the full
//      welcome (MAIN_MENU → buildWelcomeSequence). Same phrase, two different
//      screens depending on tap vs type. Now both resolve to action MAIN_MENU.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWelcomeSequence } from '../core/conversations/moduleRouter.js';
import { getModeConfig } from '../config/modes.js';
import { detectIntent } from '../core/nlu/classification/intentEngine.js';
import { INTENT_PATTERNS } from '../core/nlu/classification/patterns.js';

// ── 1. Catalog welcome wiring ────────────────────────────────────────────────

function catalogBusiness(overrides = {}) {
  return {
    businessMode: 'RETAIL',
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'MANUAL_ONLY', lastSyncedAt: new Date(), syncedRetailerIds: ['i1'] },
    menuItems: [{ _id: 'i1', name: 'Widget', available: true }],
    ...overrides,
  };
}

test('buildWelcomeSequence: non-RESTAURANT mode with WA Catalog enabled gets a Browse Catalog option', () => {
  const cfg = getModeConfig({ businessMode: 'RETAIL' });
  const business = catalogBusiness();
  const seq = buildWelcomeSequence(business, cfg);

  const buttonsMsg = seq[1];
  const ids = buttonsMsg.type === 'list'
    ? buttonsMsg.rows.map(r => r.id)
    : buttonsMsg.buttons.map(b => b.id);

  assert.ok(ids.includes('BROWSE_CATALOG'),
    'RETAIL welcome sequence should offer BROWSE_CATALOG when WA Catalog is enabled and configured');
});

test('buildWelcomeSequence: catalog-disabled tenant sees no Browse Catalog option (no-op, unchanged rendering)', () => {
  const cfg = getModeConfig({ businessMode: 'RETAIL' });
  const business = { businessMode: 'RETAIL' }; // no waCatalog config at all
  const seq = buildWelcomeSequence(business, cfg);

  assert.equal(seq[1].type, 'buttons', 'should still render as a plain buttons message, not a list');
  const ids = seq[1].buttons.map(b => b.id);
  assert.ok(!ids.includes('BROWSE_CATALOG'));
});

test('buildWelcomeSequence: RESTAURANT uses its LIST-NAV-1 welcomeList (single list message), which already includes Browse Catalog', () => {
  // [LIST-NAV-1] RESTAURANT_CONFIG now defines cfg.ui.welcomeList, which
  // buildWelcomeSequence() checks FIRST and returns early for — superseding
  // the old NAV-META3 3-button + "⋯ More" array format this test used to
  // assert. RESTAURANT's welcomeList rows already hard-code a Browse Catalog
  // row, so it doesn't go through withCatalogWelcomeOption at all.
  const cfg = getModeConfig({ businessMode: 'RESTAURANT' });
  const business = catalogBusiness({ businessMode: 'RESTAURANT' });
  const seq = buildWelcomeSequence(business, cfg);

  assert.ok(Array.isArray(seq) && seq.length === 1, 'RESTAURANT should return one welcome payload');
  assert.equal(seq[0].type, 'list', 'RESTAURANT should return a single welcomeList payload');
  assert.deepEqual(seq[0].rows.map(r => r.id), ['ORDER', 'BOOK', 'BROWSE_CATALOG', 'QUESTION']);
});

// ── 2. MAIN_MENU / VIEW_MENU collision ───────────────────────────────────────

test("patterns.js: 'main menu' belongs to its own MAIN_MENU keyword list, not VIEW_MENU", () => {
  assert.ok(!INTENT_PATTERNS.VIEW_MENU.includes('main menu'));
  assert.ok(INTENT_PATTERNS.MAIN_MENU?.includes('main menu'));
});

test('detectIntent: typed "main menu" resolves to action MAIN_MENU, same as tapping the button', async () => {
  const typed  = await detectIntent({ message: 'main menu', isInteractive: false, session: {}, business: {} });
  const tapped = await detectIntent({ message: 'MAIN_MENU', isInteractive: true,  session: {}, business: {} });

  assert.equal(typed.action, 'MAIN_MENU');
  assert.equal(tapped.action, 'MAIN_MENU');
});

test('detectIntent: typed "menu" / "view menu" resolve to the native catalog action', async () => {
  for (const message of ['menu', 'view menu', 'see menu']) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: {} });
    assert.equal(result.action, 'BROWSE_CATALOG', `'${message}' should resolve to BROWSE_CATALOG`);
  }
});
