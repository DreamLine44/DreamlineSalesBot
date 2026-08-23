// tests/viewMenuButtonFirst.test.mjs
//
// Menu/food browse requests (typed or button tap) must dispatch the native WA
// Catalog card directly — no intermediate "tap below" confirmation step.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('moduleRouter.js: case BROWSE_CATALOG dispatches the catalog directly for typed menu asks', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  assert.ok(caseMatch, 'case BROWSE_CATALOG block should exist');
  const block = caseMatch[0];

  assert.doesNotMatch(block, /Here's how to see what we have/,
    'typed menu browse must not insert an intermediate confirmation button');
  assert.doesNotMatch(block, /if \(!isInteractive && shouldShowCatalogButton\(business\)\)/,
    'must not gate catalog dispatch on isInteractive');
  assert.match(block, /browseCatalogExplicit\(\{ session, business, tenant \}\)/);
});

test('moduleRouter.js: case BROWSE_CATALOG still dispatches the catalog directly for a real button tap', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/);
  const block = caseMatch[0];

  assert.match(block, /const \{ browseCatalogExplicit \} = await import\('\.\.\/\.\.\/modules\/catalog\/waCatalogFlow\.js'\);/);
  assert.match(block, /return browseCatalogExplicit\(\{ session, business, tenant \}\);/);
});

test('moduleRouter.js: case VIEW_MENU (the mid-flow "📋 View Menu" button) is unaffected — still dispatches directly', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const caseMatch = src.match(/case 'VIEW_MENU':\s*\{[\s\S]*?\n    \}/);
  assert.ok(caseMatch, 'case VIEW_MENU block should exist');
  const block = caseMatch[0];
  assert.doesNotMatch(block, /View Items/, 'the VIEW_MENU case must not gain a button-first step');
  assert.match(block, /browseCatalogExplicit/);
});

test('moduleRegistry.js: generic typed order/browse does not show an intermediate View Items button', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf('if (isGenericBrowseIntent)');
  assert.ok(start !== -1);
  const end = src.indexOf('// [ENHANCED-NLU]', start);
  const block = src.slice(start, end);
  assert.doesNotMatch(block, /Here's how to see what we have/);
  assert.match(block, /offerCatalogOnStartOrder/);
});
