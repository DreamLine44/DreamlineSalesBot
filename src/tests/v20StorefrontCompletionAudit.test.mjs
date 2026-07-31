// tests/v20StorefrontCompletionAudit.test.mjs
//
// Regression tests for the v20 storefront-completion audit.
//
// Bugs found and fixed:
//
// [AUDIT-FIX-RETAIL-SCOPEDINDEX] modules/retail/flows/index.js's SELECT_ITEM
// step always resolved numeric/interactive row taps against the FULL,
// unfiltered `menu` — even while a customer was browsing inside a category.
// _buildProductList's row ids are 1-based positions WITHIN whatever list was
// actually rendered, so a customer inside "Shoes" tapping row 2 could
// silently receive the 2nd item of the ENTIRE catalogue instead of the 2nd
// shoe: wrong item, wrong price, wrong order. Fixed by resolving taps against
// a `scopedMenu` filtered to `data.category` when one is active, matching the
// pattern electronics/flows/orderFlow.js already used correctly
// (`filteredMenu`/`listMenu`).
//
// [AUDIT-FIX-LISTCAP] modules/retail/flows/index.js's _buildProductList and
// modules/bakery/flows/orderFlow.js's _buildBakeryMenu both still had a
// `.slice(0, 10)` truncating their flat `rows` list — the exact same bug
// class already fixed everywhere else in [FIX-LIST-TRUNC], missed in these
// two functions specifically. Removed; dispatcher.js now chunks the full,
// unsliced list across sections.
//
// [FEAT-FASHION-CATEGORY] / [FEAT-BAKERY-CATEGORY] — category-first browsing
// (BROWSE_CATEGORY step, same conditional-on-real-data pattern as retail:
// only shown when a tenant has 2+ distinct `menuItems[].category` values)
// rolled out to fashion and bakery, the two remaining product verticals
// without it. Both scope numeric/interactive index resolution to the
// filtered category list from the start, so neither ships with the
// [AUDIT-FIX-RETAIL-SCOPEDINDEX] bug class.
//
// Consistent with this codebase's existing convention (see
// v18FlowSystemAudit, v4RetailVariantPickerAudit): these are source-text
// guards, since calling the flow handlers directly requires a live Mongo
// connection via updateSession.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── retail: scoped index fix ──────────────────────────────────────────────

test('retail/flows/index.js: SELECT_ITEM resolves numeric/interactive taps against a category-scoped menu, not the full catalogue', () => {
  const src = read('../modules/retail/flows/index.js');
  const idx = src.indexOf("case 'SELECT_ITEM':");
  assert.ok(idx !== -1, 'SELECT_ITEM case not found');
  const body = src.slice(idx, idx + 2400);

  assert.match(
    body,
    /const scopedMenu = data\.category/,
    'expected SELECT_ITEM to derive a category-scoped menu from data.category'
  );
  assert.match(
    body,
    /scopedMenu\[numIdx\]/,
    'expected numeric index resolution to use scopedMenu, not the full menu'
  );
  assert.doesNotMatch(
    body,
    /!isNaN\(numIdx\) && menu\[numIdx\]/,
    'numeric index resolution must not fall back to the full, unfiltered menu'
  );
});

// ── retail + bakery: no remaining 10-row truncation ───────────────────────

test('retail/flows/index.js: _buildProductList no longer truncates to 10 items', () => {
  const src = read('../modules/retail/flows/index.js');
  const idx = src.indexOf('function _buildProductList');
  assert.ok(idx !== -1, '_buildProductList not found');
  const body = src.slice(idx, idx + 1300);

  assert.doesNotMatch(body, /\.slice\(0,\s*10\)/, 'no build-time 10-item slice expected');
  assert.match(body, /items\.map\(\(item, idx\)/, 'expected the full item list to be mapped unsliced');
});

test('bakery/flows/orderFlow.js: _buildBakeryMenu no longer truncates to 10 items', () => {
  const src = read('../modules/bakery/flows/orderFlow.js');
  const idx = src.indexOf('function _buildBakeryMenu');
  assert.ok(idx !== -1, '_buildBakeryMenu not found');
  const body = src.slice(idx, idx + 1600);

  assert.doesNotMatch(body, /\.slice\(0,\s*10\)/, 'no build-time 10-item slice expected');
  assert.match(body, /menu\.map\(\(item, i\)/, 'expected the full menu to be mapped unsliced');
});

// ── fashion: category browsing rolled out ─────────────────────────────────

test('fashion/flows/index.js: category-first browsing is gated on 2+ real categories', () => {
  const src = read('../modules/fashion/flows/index.js');

  assert.match(
    src,
    /ORDER:\s*\[\s*'BROWSE_CATEGORY'/,
    'expected BROWSE_CATEGORY as the first ORDER step'
  );
  assert.match(
    src,
    /const categories = _getCategories\(menu\);\s*\n\s*if \(categories\.length > 1\)/,
    'expected category UI to be conditional on 2+ distinct categories'
  );

  const scopedIdx = src.indexOf("case 'SELECT_ITEM':");
  const scopedBody = src.slice(scopedIdx, scopedIdx + 1200);
  assert.match(
    scopedBody,
    /const scopedMenu = data\.category/,
    'expected fashion SELECT_ITEM to scope numeric resolution to the active category from the start'
  );
});

// ── bakery: category browsing rolled out ──────────────────────────────────

test('bakery/flows/index.js + orderFlow.js: category-first browsing is gated on 2+ real categories', () => {
  const config = read('../modules/bakery/flows/index.js');
  const flow   = read('../modules/bakery/flows/orderFlow.js');

  assert.match(
    config,
    /ORDER:\s*\[\s*'BROWSE_CATEGORY'/,
    'expected BROWSE_CATEGORY as the first ORDER step in BAKERY_CONFIG'
  );
  assert.match(
    flow,
    /const categories = _getCategories\(menu\);\s*\n\s*if \(categories\.length > 1\)/,
    'expected category UI to be conditional on 2+ distinct categories'
  );

  const scopedIdx = flow.indexOf("case 'SELECT_ITEM':");
  const scopedBody = flow.slice(scopedIdx, scopedIdx + 1200);
  assert.match(
    scopedBody,
    /const scopedMenu = data\.category/,
    'expected bakery SELECT_ITEM to scope numeric resolution to the active category from the start'
  );
});
