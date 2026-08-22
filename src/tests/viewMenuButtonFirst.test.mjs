// tests/viewMenuButtonFirst.test.mjs
//
// [FIX-VIEWMENU-BUTTON-FIRST] / [AUDIT-FIX-CATALOG-DIRECT] Regression tests.
//
// HISTORY: [FIX-VIEWMENU-BUTTON-FIRST] originally made a typed menu request
// (isInteractive: false) show a "🛍 View Items" confirmation button before
// ever calling browseCatalogExplicit(), so the customer had to tap twice —
// once to trigger the flow, once more to actually see the catalog.
//
// [AUDIT-FIX-CATALOG-DIRECT] removed that intermediate step at explicit
// request: both a typed menu request AND a real button tap now call
// browseCatalogExplicit() immediately and unconditionally — no button-first
// gate, no isInteractive check in this case at all. These tests were updated
// to assert the current (direct) behavior instead of the old two-step one.
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

test('moduleRouter.js: case BROWSE_CATALOG calls browseCatalogExplicit() directly for a typed (non-interactive) trigger — no intermediate button', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  assert.ok(caseMatch, 'case BROWSE_CATALOG block should exist');
  const block = caseMatch[0];

  assert.doesNotMatch(block, /if \(!isInteractive/,
    'the button-first gate was intentionally removed — this case must not branch on isInteractive');
  assert.doesNotMatch(block, /id:\s*'BROWSE_CATALOG',\s*title:\s*'🛍 View Items'/,
    'the intermediate "🛍 View Items" confirmation button object was intentionally removed');
  assert.match(block, /const \{ browseCatalogExplicit \} = await import\('\.\.\/\.\.\/modules\/catalog\/waCatalogFlow\.js'\);/);
  assert.match(block, /return browseCatalogExplicit\(\{ session, business, tenant \}\);/);
});

test('moduleRouter.js: case BROWSE_CATALOG still dispatches the catalog directly for a real button tap', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  const block = caseMatch[0];

  // Unconditional now — same call path for both a tap and typed text.
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
