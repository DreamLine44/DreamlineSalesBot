// tests/viewMenuButtonFirst.test.mjs
//
// [REMOVE-VIEWMENU-BUTTON-FIRST] Regression tests.
//
// HISTORY: [FIX-VIEWMENU-BUTTON-FIRST] previously made a typed
// natural-language menu request ("what do you have in your menu", matched
// by VIEW_MENU_DIRECT_RE) show an interstitial "🛍 View Items" button and
// wait for a second, deliberate tap before dispatching the actual WhatsApp
// Catalog product list — instead of sending the catalog immediately, the
// way every other entry into this same action already did.
//
// CHANGE: that interstitial step is removed. moduleRouter.js's case
// 'BROWSE_CATALOG' no longer branches on `isInteractive` at all — every
// trigger (typed or tapped) now goes straight to browseCatalogExplicit(),
// which still handles its own graceful fallback to the module's normal
// ORDER flow when WA Catalog isn't configured/enabled for the tenant. This
// makes a typed menu request one step faster and direct, matching what a
// button tap always did.
//
// moduleRouter.js is a large, DB/session-coupled router not designed for
// full unit import in isolation (same constraint noted in
// viewMenuFeature.test.mjs) — verified here via source-text assertions
// against the real file, consistent with that existing convention.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('moduleRouter.js: case BROWSE_CATALOG dispatches the catalog directly, with no interstitial button and no isInteractive branch', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  assert.ok(caseMatch, 'case BROWSE_CATALOG block should exist');
  const block = caseMatch[0];

  assert.doesNotMatch(block, /isInteractive/,
    'the typed vs. tapped distinction should no longer gate this case');
  assert.doesNotMatch(block, /View Items/,
    'no interstitial button reply should remain in this case');
});

test('moduleRouter.js: case BROWSE_CATALOG always calls browseCatalogExplicit()', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  const block = caseMatch[0];

  assert.match(block, /const \{ browseCatalogExplicit \} = await import\('\.\.\/\.\.\/modules\/catalog\/waCatalogFlow\.js'\);/);
  assert.match(block, /return browseCatalogExplicit\(\{ session, business, tenant \}\);/);
});

test('moduleRouter.js: case VIEW_MENU (the mid-flow "📋 View Menu" button) is unaffected — still dispatches directly', () => {
  // This is a distinct action from a distinct button id ('VIEW_MENU', not
  // 'BROWSE_CATALOG') — tapping it is already the deliberate interactive
  // event, so it must keep going straight to the catalog/fallback split
  // with no intermediate button inserted.
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'VIEW_MENU':\s*\{[\s\S]*?\n    \}/);
  assert.ok(caseMatch, 'case VIEW_MENU block should exist');
  const block = caseMatch[0];
  assert.doesNotMatch(block, /View Items/, 'the VIEW_MENU case must not gain a button-first step');
  assert.match(block, /browseCatalogExplicit/);
});
