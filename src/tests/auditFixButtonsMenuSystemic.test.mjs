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
import { detectIntent } from '../core/intents/intentEngine.js';
import { INTENT_PATTERNS } from '../core/intents/patterns.js';

// ── 1. Catalog welcome wiring ────────────────────────────────────────────────

function catalogBusiness(overrides = {}) {
  return {
    businessMode: 'RETAIL',
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'MANUAL_ONLY' },
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

test('buildWelcomeSequence: RESTAURANT uses the single "Choose an option ▼" list dropdown (RESTORE-LISTNAV-1)', () => {
  const cfg = getModeConfig({ businessMode: 'RESTAURANT' });
  const business = catalogBusiness({ businessMode: 'RESTAURANT' });
  const seq = buildWelcomeSequence(business, cfg);

  // Restored welcomeList branch returns ONE merged message, not a [text, buttons] array.
  assert.equal(seq.type, 'list');
  assert.equal(seq.button, 'Choose an option');
  assert.deepEqual(seq.rows.map(r => r.id), ['ORDER', 'BOOK', 'BROWSE_CATALOG', 'QUESTION']);
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

test('detectIntent: typed "menu" / "view menu" still resolve to VIEW_MENU, unaffected by the MAIN_MENU split', async () => {
  for (const message of ['menu', 'view menu', 'see menu']) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: {} });
    assert.equal(result.action, 'VIEW_MENU', `'${message}' should still resolve to VIEW_MENU`);
  }
});
