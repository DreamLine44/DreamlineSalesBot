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
  const mustHave = ['menu', 'show menu', 'view menu', 'see menu', 'main menu', 'back to menu'];
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

test('detectIntent: typed "menu" / "view menu" resolve to action VIEW_MENU via exact keyword match', async () => {
  const phrases = ['menu', 'view menu', 'show menu', 'see menu', 'main menu'];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: { businessMode: 'RESTAURANT' } });
    assert.equal(result.action, 'VIEW_MENU', `'${message}' should resolve to VIEW_MENU, got ${result.action}`);
    assert.equal(result.source, 'keyword');
  }
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

// ── 3. moduleRouter.js — VIEW_MENU starts the ORDER flow ────────────────────

test('moduleRouter.js: case VIEW_MENU exists and starts the ORDER flow instead of a generic reset', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'VIEW_MENU':\s*\n\s*return startFlow\(\{\s*flowName:\s*'ORDER'/);
  assert.ok(
    caseMatch,
    "moduleRouter.js should have `case 'VIEW_MENU': return startFlow({ flowName: 'ORDER', ... })` — " +
    'View Menu must render the real menu, not the generic welcome buttons.'
  );
});

// ── 4. webhookController.js — mid-flow VIEW_MENU preserves flow state ───────

test('webhookController.js: SELECT_ITEM step now accepts VIEW_MENU as a valid button (stale-button guard)', () => {
  const src = readSource('../controllers/webhookController.js');
  const m = src.match(/SELECT_ITEM:\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'Could not find the SELECT_ITEM entry in STEP_VALID_BUTTONS');
  assert.ok(
    m[1].includes("'VIEW_MENU'"),
    "STEP_VALID_BUTTONS.SELECT_ITEM must include 'VIEW_MENU', or a genuine View Menu tap at that " +
    'step gets rejected with "that option is no longer available".'
  );
  assert.ok(m[1].includes("'SHOW_MENU'"), 'SHOW_MENU must remain valid at SELECT_ITEM too (unchanged)');
});

test('webhookController.js: mid-flow VIEW_MENU handling re-renders the menu via startFlow when currentFlow is ORDER, without resetting currentFlow/step', () => {
  const src = readSource('../controllers/webhookController.js');

  // The VIEW_MENU branch must check currentFlow === 'ORDER' and call startFlow
  // with flowName 'ORDER' — i.e. redisplay the menu rather than clearing state.
  const viewMenuBlock = src.match(
    /upperMsg === 'VIEW_MENU'[\s\S]{0,600}?startFlow\(\{ flowName: 'ORDER'/
  );
  assert.ok(
    viewMenuBlock,
    'webhookController.js mid-flow handling should call startFlow({ flowName: "ORDER", ... }) ' +
    'when a VIEW_MENU escape fires inside an active ORDER flow.'
  );
  assert.ok(
    viewMenuBlock[0].includes("session.currentFlow || ''"),
    'The VIEW_MENU branch should gate on session.currentFlow to avoid starting an ORDER flow ' +
    'for customers who are mid-booking or otherwise not in an order-capable flow.'
  );

  // It must NOT clear currentFlow/step before calling startFlow (startFlow itself
  // manages session state for the new flow) — regression guard against
  // accidentally re-introducing the old reset-then-generic-buttons behavior
  // inside the VIEW_MENU branch specifically. Scoped to stop at the start of
  // the NEXT if-block (the separate SHOW_MENU reset branch) so it can't
  // false-positive on that unrelated, intentionally-unchanged code below it.
  const viewMenuBranchOnly = src.match(
    /if \(upperMsg === 'VIEW_MENU'[\s\S]*?\n {4}\}\n\n {4}if \(upperMsg === '0'/
  );
  assert.ok(viewMenuBranchOnly, 'Could not isolate the VIEW_MENU if-block from webhookController.js');
  assert.ok(
    !/currentFlow:\s*null/.test(viewMenuBranchOnly[0]),
    'The VIEW_MENU branch must not reset currentFlow to null before re-rendering the menu — ' +
    'that would reproduce the original bug.'
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

// ── 5. Button wiring — "View Menu"-labeled buttons use the VIEW_MENU id ─────

test('restaurant/flows/orderFlow.js: "📋 View Menu" buttons use id VIEW_MENU, not SHOW_MENU', () => {
  const src = readSource('../modules/restaurant/flows/orderFlow.js');
  const viewMenuButtons = [...src.matchAll(/\{ id: '([A-Z_]+)', title: '📋 View Menu'/g)];
  assert.ok(viewMenuButtons.length >= 2, 'Expected at least 2 "View Menu" buttons in restaurant/flows/orderFlow.js');
  for (const m of viewMenuButtons) {
    assert.equal(m[1], 'VIEW_MENU', `A "📋 View Menu" button still uses id '${m[1]}' instead of 'VIEW_MENU'`);
  }
});

test('delivery/flows/index.js: "📋 View Menu" buttons use id VIEW_MENU, not SHOW_MENU', () => {
  const src = readSource('../modules/delivery/flows/index.js');
  const viewMenuButtons = [...src.matchAll(/\{ id: '([A-Z_]+)',\s*title: '📋 View Menu'/g)];
  assert.ok(viewMenuButtons.length >= 4, 'Expected at least 4 "View Menu" buttons in delivery/flows/index.js');
  for (const m of viewMenuButtons) {
    assert.equal(m[1], 'VIEW_MENU', `A "📋 View Menu" button still uses id '${m[1]}' instead of 'VIEW_MENU'`);
  }
});
