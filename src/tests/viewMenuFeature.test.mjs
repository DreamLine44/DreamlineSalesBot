// tests/viewMenuFeature.test.mjs
//
// [AUDIT-FIX-VIEWMENU] Regression tests.
//
// BUG: "📋 View Menu" buttons (and typed "menu" / "view menu" / "show menu" /
// "see menu" / "main menu" / "back to menu") were mapped to the SAME action as
// "🔄 Start Over" buttons (SHOW_MENU). That action only resets the session and
// re-shows the generic top-level welcome buttons — it never actually rendered
// any menu content. A customer mid-order who tapped "View Menu" or typed
// "menu" lost their flow progress and was NOT shown any menu items, despite
// the button/phrase promising exactly that.
//
// FIX (four cooperating pieces, all covered below):
//   1. core/intents/patterns.js       — VIEW_MENU is now its own keyword list
//                                        and its own BUTTON_ID_MAP entry,
//                                        split out of the old SHOW_MENU bucket.
//   2. core/intents/intentEngine.js   — VIEW_MENU maps to its own action in
//                                        intentToAction().
//   3. core/conversations/moduleRouter.js — case 'VIEW_MENU' starts the ORDER
//                                        flow (startFlow), reusing each
//                                        module's own INIT step to render the
//                                        real menu — no top-level flow-state
//                                        to preserve there, so this is safe.
//   4. controllers/webhookController.js — mid-flow global escape now branches:
//                                        VIEW_MENU while inside an ORDER flow
//                                        re-renders the menu via startFlow
//                                        WITHOUT wiping currentFlow/step;
//                                        SHOW_MENU/HOME/0/etc. keep the
//                                        original reset-to-top-level behavior.
//
// webhookController.js is a large, DB/dispatch-coupled controller not designed
// for unit import (same constraint documented in statusTracing.test.mjs and
// midFlowOrderBookingSwitch.test.mjs). Its portion of this fix is verified via
// source-text assertions against the real file, consistent with that existing
// convention, rather than a re-implementation that could silently drift.
//
// Does NOT modify any existing source file's behavior for callers unrelated
// to View Menu — SHOW_MENU (start-over) keeps every existing trigger word
// ('home', 'back', 'restart', '0', 'start over') and both its keyword-typed
// and button-tap paths are unchanged.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectIntent } from '../core/intents/intentEngine.js';
import { INTENT_PATTERNS, BUTTON_ID_MAP } from '../core/intents/patterns.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── 1. patterns.js — VIEW_MENU split out of SHOW_MENU ───────────────────────

test('patterns.js: VIEW_MENU keyword list contains the menu-viewing phrases', () => {
  // [AUDIT-FIX-MAINMENU-COLLISION] 'main menu' no longer belongs to VIEW_MENU —
  // it moved to its own MAIN_MENU intent so typed "main menu" resolves to the
  // same action as tapping the "🏠 Main Menu" button (see patterns.js and
  // intentEngine.js intentToAction for the companion change).
  const mustHave = ['menu', 'show menu', 'view menu', 'see menu', 'back to menu'];
  for (const phrase of mustHave) {
    assert.ok(
      INTENT_PATTERNS.VIEW_MENU?.includes(phrase),
      `INTENT_PATTERNS.VIEW_MENU is missing '${phrase}'`
    );
  }
});

test('patterns.js: SHOW_MENU keyword list no longer contains menu-viewing phrases (regression guard against re-conflation)', () => {
  const mustNotHave = ['menu', 'show menu', 'view menu', 'see menu', 'main menu', 'back to menu'];
  for (const phrase of mustNotHave) {
    assert.ok(
      !INTENT_PATTERNS.SHOW_MENU.includes(phrase),
      `INTENT_PATTERNS.SHOW_MENU should no longer contain '${phrase}' — it belongs to VIEW_MENU now`
    );
  }
});

test('patterns.js: SHOW_MENU keyword list still contains the reset/navigation phrases (unchanged behavior)', () => {
  const mustHave = ['home', 'back', 'restart', '0', 'start over'];
  for (const phrase of mustHave) {
    assert.ok(
      INTENT_PATTERNS.SHOW_MENU.includes(phrase),
      `INTENT_PATTERNS.SHOW_MENU is missing '${phrase}' — this is a regression, not part of the View Menu fix`
    );
  }
});

test('patterns.js: BUTTON_ID_MAP.VIEW_MENU is its own action, not collapsed into SHOW_MENU', () => {
  assert.equal(BUTTON_ID_MAP.VIEW_MENU, 'VIEW_MENU');
  assert.equal(BUTTON_ID_MAP.SHOW_MENU, 'SHOW_MENU');
});

// ── 2. intentEngine.js — VIEW_MENU resolves to its own action ───────────────

test('detectIntent: tapping a VIEW_MENU button resolves to action VIEW_MENU (not SHOW_MENU)', async () => {
  const result = await detectIntent({ message: 'VIEW_MENU', isInteractive: true, session: {}, business: { businessMode: 'RESTAURANT' } });
  assert.equal(result.action, 'VIEW_MENU');
  assert.equal(result.source, 'button');
});

test('detectIntent: typed "menu" / "view menu" resolve to the explicit catalog action', async () => {
  // [AUDIT-FIX-MAINMENU-COLLISION] 'main menu' intentionally excluded here — it
  // now resolves to action MAIN_MENU instead (see the dedicated test below).
  const phrases = ['menu', 'view menu', 'show menu', 'see menu'];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: { businessMode: 'RESTAURANT' } });
    assert.equal(result.action, 'BROWSE_CATALOG', `'${message}' should resolve to BROWSE_CATALOG, got ${result.action}`);
    assert.equal(result.source, 'keyword');
  }
});

test('intentEngine.js/menuIntentDetector.js: natural browse phrases are available to the active-flow webhook escape path', () => {
  // [FIX-MENU-COVERAGE] webhookController.js's mid-flow "menu" re-render check
  // was migrated off the single-regex VIEW_MENU_DIRECT_RE onto the shared
  // token-based isMenuBrowsingIntent detector, so the pre-flow and mid-flow
  // paths can never silently diverge again. VIEW_MENU_DIRECT_RE itself is
  // kept exported for reference but is no longer wired into the webhook.
  const detectorSrc = readSource('../core/intents/menuIntentDetector.js');
  assert.match(detectorSrc, /export function isMenuBrowsingIntent/);

  const webhook = readSource('../controllers/webhookController.js');
  assert.match(webhook, /isMenuBrowsingIntent\(normalise\(messageText\)\)/,
    'Active ORDER flows must reuse the same natural browse matcher as fresh conversations');
});

test('detectIntent: typed "start over" / "home" / "restart" / "0" still resolve to SHOW_MENU (unchanged)', async () => {
  const phrases = ['start over', 'home', 'restart'];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: { businessMode: 'RESTAURANT' } });
    assert.equal(result.action, 'SHOW_MENU', `'${message}' should resolve to SHOW_MENU, got ${result.action}`);
  }
});

test('detectIntent: tapping a SHOW_MENU button still resolves to action SHOW_MENU (unchanged)', async () => {
  const result = await detectIntent({ message: 'SHOW_MENU', isInteractive: true, session: {}, business: { businessMode: 'RESTAURANT' } });
  assert.equal(result.action, 'SHOW_MENU');
});

test('intentEngine.js: VIEW_MENU intent maps to the explicit native catalog action', () => {
  const src = readSource('../core/intents/intentEngine.js');
  assert.match(src, /VIEW_MENU:\s+'BROWSE_CATALOG'/,
    'Menu browsing must use the same action as the native View items catalog button');
});

// ── 3. moduleRouter.js — VIEW_MENU starts the ORDER flow ────────────────────

// [AUDIT-FIX-CATALOG-VIEWMENU] VIEW_MENU no longer unconditionally starts the
// module's own text/list ORDER flow — for a tenant whose WA Catalog is
// enabled and actually synced, it tries the real catalog first (mirroring
// moduleRegistry.js's START_ORDER PATH A/B split) and only falls back to
// startFlow('ORDER') when catalog isn't configured/ready for this tenant.
// The startFlow('ORDER') fallback itself is unchanged — this asserts both
// halves of the new behavior rather than one brittle regex against the old
// unconditional shape.
test('moduleRouter.js: case VIEW_MENU still starts the ORDER flow (unchanged) for a tenant without WA Catalog configured', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'VIEW_MENU':\s*\{[\s\S]*?return startFlow\(\{\s*flowName:\s*'ORDER'/);
  assert.ok(
    caseMatch,
    "moduleRouter.js's case 'VIEW_MENU' should still fall back to " +
    "startFlow({ flowName: 'ORDER', ... }) for a tenant with no WA Catalog — " +
    'View Menu must render the real menu, not the generic welcome buttons.'
  );
});

test('moduleRouter.js: case VIEW_MENU routes through the WA Catalog first for a catalog-ready tenant', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'VIEW_MENU':\s*\{[\s\S]*?isCatalogEnabled\(business\)[\s\S]*?browseCatalogExplicit[\s\S]*?\}/);
  assert.ok(
    caseMatch,
    "moduleRouter.js's case 'VIEW_MENU' should check isCatalogEnabled(business) and delegate to " +
    'browseCatalogExplicit() before ever falling back to the internal text/list menu — ' +
    '"View Menu" must never show the fallback menu once the catalog is active.'
  );
});

// ── 4. webhookController.js — direct ordering bypasses menu UI ───────────────

test('webhookController.js: SELECT_ITEM no longer advertises VIEW_MENU as an ordering button', () => {
  const src = readSource('../controllers/webhookController.js');
  const m = src.match(/SELECT_ITEM:\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'Could not find the SELECT_ITEM entry in STEP_VALID_BUTTONS');
  assert.ok(m[1].includes("'SHOW_MENU'"), 'SHOW_MENU must remain valid at SELECT_ITEM too (unchanged)');
  assert.doesNotMatch(m[1], /'VIEW_MENU'/, 'VIEW_MENU should not be an active ordering button');
});

test('webhookController.js: active-flow direct orders route through the shared START_ORDER handoff', () => {
  const src = readSource('../controllers/webhookController.js');
  const directBlock = src.match(/DIRECT-ORDER-SHORTCUT[\s\S]{0,1800}route\(\{[\s\S]*?action: 'START_ORDER'/);
  assert.ok(
    directBlock,
    'Active-flow direct orders should route through START_ORDER instead of the current menu step.'
  );
  assert.ok(
    directBlock[0].includes('parseNaturalOrderMessage') && directBlock[0].includes('parseMultiItemMessage'),
    'The active-flow shortcut must resolve against the live menu before routing.'
  );
});

test('webhookController.js: active-flow BROWSE_CATALOG routes to the existing catalog action', () => {
  const src = readSource('../controllers/webhookController.js');
  const catalogBlock = src.match(/upperMsg === 'BROWSE_CATALOG'[\s\S]{0,900}action: 'BROWSE_CATALOG'/);
  assert.ok(catalogBlock, 'Active-flow BROWSE_CATALOG should route through the catalog action');
});

test('webhookController.js: stale "Order Food" re-tap while already in an ORDER flow also tries the WA Catalog first', () => {
  const src = readSource('../controllers/webhookController.js');
  // [AUDIT-FIX-CATALOG-VIEWMENU] FIX-LISTNAV-ORDER-COLLISION's re-tap handler
  // is functionally "start ordering again" — it should reach a catalog-ready
  // tenant's real WA Catalog too, not just the internal text/list menu.
  const block = src.match(
    /messageText\.trim\(\)\.toUpperCase\(\) === 'ORDER'\) \{[\s\S]{0,1100}?startFlow: _startOrderFlow/
  );
  assert.ok(block, 'Could not find the stale "ORDER" re-tap handler in webhookController.js');
  assert.ok(
    block[0].includes('isCatalogEnabled(business)') && block[0].includes('browseCatalogExplicit'),
    'The stale "Order Food" re-tap handler should try the WA Catalog first (isCatalogEnabled + ' +
    'browseCatalogExplicit) before falling back to startFlow(\'ORDER\').'
  );
});

test('moduleRouter.js: the "⋯ More" secondary menu also filters BROWSE_CATALOG on shouldShowCatalogButton()', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const block = src.match(/case 'MORE_MENU': \{[\s\S]*?\n {4}\}/);
  assert.ok(block, 'Could not find the MORE_MENU case in moduleRouter.js');
  assert.ok(
    block[0].includes('shouldShowCatalogButton(business)'),
    '[AUDIT-FIX-CATALOG-WELCOMELIST] The MORE_MENU case should filter its BROWSE_CATALOG entry on ' +
    'shouldShowCatalogButton(business) — the static moreMenuButtons config alone must not decide ' +
    'whether the button is shown.'
  );
});
test('webhookController.js: the original SHOW_MENU/HOME/0 reset behavior is preserved unchanged', () => {
  const src = readSource('../controllers/webhookController.js');
  const resetBlock = src.match(
    /upperMsg === '0' \|\| upperMsg === 'SHOW_MENU'[\s\S]{0,500}?currentFlow:\s*null,\s*step:\s*null/
  );
  assert.ok(
    resetBlock,
    'The SHOW_MENU/HOME/0 branch should still reset currentFlow/step and show the generic ' +
    'welcome buttons — that behavior is intentionally unchanged by the View Menu fix.'
  );
});

// ── 5. Ordering UI has no redundant View Menu button ─────────────────────────

test('restaurant/flows/orderFlow.js: ordering responses do not expose VIEW_MENU', () => {
  const src = readSource('../modules/restaurant/flows/orderFlow.js');
  assert.doesNotMatch(src, /VIEW_MENU|📋 View Menu/);
  assert.match(src, /BROWSE_CATALOG/);
});

test('delivery/flows/index.js: ordering responses do not expose VIEW_MENU', () => {
  const src = readSource('../modules/delivery/flows/index.js');
  assert.doesNotMatch(src, /VIEW_MENU|📋 View Menu/);
  assert.match(src, /BROWSE_CATALOG/);
});

test('explicit browsing remains a separate catalog action', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const browseBlock = src.match(/case 'BROWSE_CATALOG':[\s\S]*?browseCatalogExplicit/);
  assert.ok(browseBlock, 'Explicit BROWSE_CATALOG should still use the WhatsApp Catalog flow');
});
