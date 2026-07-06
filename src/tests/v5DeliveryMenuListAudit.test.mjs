// tests/v5DeliveryMenuListAudit.test.mjs
//
// Regression test for the v5 systematic audit.
//
// Bug found and fixed: [AUDIT-FIX-DELIVERY-MENU-LIST]
//
// modules/delivery/flows/index.js's _buildMenuUI() was the one module still
// rendering its menu as a plain numbered TEXT block (`menu.slice(0, 20).map(...)`
// joined into a single body string) instead of the interactive list widget every
// other module (restaurant, retail, salon, bakery, fashion, cosmetics, electronics)
// already uses.
//
// Two problems with the old approach:
//   1. Items past #20 were silently invisible in the displayed menu, with no
//      indication anything was cut off — the same silent-truncation bug class
//      already fixed everywhere else in this codebase ([AUDIT-FIX-1]/[AUDIT-FIX-3]/
//      [AUDIT-FIX-4]/[AUDIT-FIX-7]), just manifesting as text truncation instead of
//      list-row truncation.
//   2. Customers had to type a number or the item's name instead of tapping a row —
//      objectively worse UX than every sibling module's tap-to-select list.
//
// Fix: switched to the same flat top-level `rows` format those other fixes
// established; dispatcher.js's [FIX-LIST-TRUNC] logic chunks it into ≤10-row
// sections (up to 100 total) so nothing is lost, and customers can tap directly.
//
// _buildMenuUI is a private (non-exported) helper — consistent with this
// codebase's existing test suites for equivalent internals
// (v3SalonProductChunkAudit.test.mjs, v4RetailVariantPickerAudit.test.mjs), this is
// a source-text guard rather than a direct unit-test import.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

function getMenuUIBlock(src) {
  const start = src.indexOf('function _buildMenuUI');
  assert.ok(start !== -1, '_buildMenuUI not found');
  return src.slice(start, start + 1600);
}

test('delivery/flows/index.js: _buildMenuUI uses the interactive list widget, not a plain-text menu', () => {
  const src = read('../modules/delivery/flows/index.js');
  const body = getMenuUIBlock(src);

  assert.doesNotMatch(
    body,
    /menu\.slice\(0,\s*20\)/,
    '_buildMenuUI must not pre-truncate the menu to 20 items at build time'
  );
  assert.match(
    body,
    /type:\s*'list'/,
    'expected the non-empty-menu branch to return a list-type UI'
  );
  assert.match(
    body,
    /\brows,/,
    'expected a flat top-level `rows` field so dispatcher.js can chunk it'
  );
});

test('delivery/flows/index.js: _buildMenuUI rows are built from the full menu, not a sliced subset', () => {
  const src = read('../modules/delivery/flows/index.js');
  const body = getMenuUIBlock(src);

  assert.match(
    body,
    /const rows = menu\.map\(/,
    'expected rows to be mapped from the full, unsliced menu array'
  );
});
