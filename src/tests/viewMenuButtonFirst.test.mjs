// tests/viewMenuButtonFirst.test.mjs
//
// Direct catalog browse regression tests.
//
// Typed natural-language menu requests and interactive BROWSE_CATALOG taps
// both use the same direct catalog flow. A catalog-unavailable tenant still
// receives the existing fallback from browseCatalogExplicit().
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

test('moduleRouter.js: case BROWSE_CATALOG delegates directly for typed and interactive triggers', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  assert.ok(caseMatch, 'case BROWSE_CATALOG block should exist');
  const block = caseMatch[0];

  assert.doesNotMatch(block, /!isInteractive|shouldShowCatalogButton\(business\)/,
    'BROWSE_CATALOG must not insert an intermediate button for typed requests');
  assert.match(block, /return browseCatalogExplicit\(\{ session, business, tenant \}\);/,
    'both typed and interactive triggers must delegate directly to the catalog flow');
});

test('moduleRouter.js: case BROWSE_CATALOG still dispatches the catalog directly for a real button tap', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  const block = caseMatch[0];

  // Interactive taps must reach the same direct catalog call.
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
