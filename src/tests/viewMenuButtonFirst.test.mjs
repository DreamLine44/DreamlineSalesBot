// tests/viewMenuButtonFirst.test.mjs
//
// [FIX-VIEWMENU-BUTTON-FIRST] Regression tests.
//
// BUG: A typed natural-language menu request ("what do you have in your
// menu", matched by VIEW_MENU_DIRECT_RE) resolves to intent VIEW_MENU ->
// action BROWSE_CATALOG (intentToAction), which moduleRouter.js's case
// 'BROWSE_CATALOG' handled by calling browseCatalogExplicit() immediately —
// silently dispatching the full native WhatsApp Catalog product list with
// no button ever shown. Every OTHER path into this same action (tapping the
// actual "🛍 View Items"/"Browse Catalog" nav button, or the "📋 View Menu"
// button inside an active order) is a deliberate tap; a typed question
// should not skip straight past the button and unilaterally push a Meta
// catalog UI at the customer.
//
// FIX: core/conversations/moduleRouter.js's case 'BROWSE_CATALOG' now
// checks `isInteractive`. When the trigger was NOT an interactive tap (i.e.
// it came from typed-text intent detection) AND the tenant's WA Catalog is
// actually usable (shouldShowCatalogButton), it returns a buttons reply
// showing "🛍 View Items" instead of calling browseCatalogExplicit()
// directly. Tapping that button re-enters this same case with
// isInteractive: true, which then dispatches the catalog exactly as
// before. A tenant with no usable catalog (shouldShowCatalogButton false)
// skips the button and goes straight to browseCatalogExplicit(), which
// already falls back to the text/list ORDER menu on its own — unchanged,
// since showing a button that would only ever fail serves no purpose.
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

test('moduleRouter.js: case BROWSE_CATALOG shows the View Items button for a non-interactive (typed) trigger', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  assert.ok(caseMatch, 'case BROWSE_CATALOG block should exist');
  const block = caseMatch[0];

  assert.match(block, /if \(!isInteractive && shouldShowCatalogButton\(business\)\)/,
    'must gate the button-first reply on !isInteractive and an actually-usable catalog');
  assert.match(block, /id:\s*'BROWSE_CATALOG',\s*title:\s*'🛍 View Items'/,
    'the typed-trigger reply must offer the same BROWSE_CATALOG button id so tapping it re-enters this case');
});

test('moduleRouter.js: case BROWSE_CATALOG still dispatches the catalog directly for a real button tap', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  const block = caseMatch[0];

  // The fallthrough (isInteractive: true, or no usable catalog) must still
  // reach the unchanged browseCatalogExplicit() call.
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
