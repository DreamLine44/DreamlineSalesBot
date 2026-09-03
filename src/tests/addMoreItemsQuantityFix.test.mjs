// tests/addMoreItemsQuantityFix.test.mjs
//
// [AUDIT-FIX-CONFIRM-ADD-QTY] Regression tests for a second instance of the
// same bug class as [AUDIT-FIX-GREETING-LEADIN] (cartMessageParser.js), this
// time in the "treat the message itself as more items to add to an
// in-progress cart" fallback (SELECT_ITEM/ITEM_ADDED/CART_REVIEW steps in
// restaurant, bakery, salon, and cosmetics).
//
// BUG: when parseMultiItemMessage() didn't resolve 2+ distinct lines (i.e.
// the customer typed exactly one new item, e.g. "3 fries" while already
// reviewing their cart), every one of these four files fell back to
// `findBestMatch(menu, clean)` — which only returns an item, never a
// quantity — and then hardcoded `quantity: 1` regardless of what the
// customer actually typed. "3 fries" silently became "1 fries".
//
// FIX: the fallback now calls parseNaturalOrderMessage(menu, raw), the same
// quantity-aware, HIGH-confidence-only parser used everywhere else in these
// files, so a typed quantity is preserved and a bare item name still
// defaults to 1 exactly as before.
//
// Source-text guards, same technique as restaurantCartWiring.test.mjs /
// bakeryCartWiring.test.mjs — these files' flow handlers take a live
// session/business/tenant and aren't practical to unit-test end-to-end
// without a database, so asserting on the parsing call itself (already unit
// tested directly in cartMessageParser.test.mjs) is what these existing
// wiring-test files do too.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const files = {
  restaurant: read('../modules/restaurant/flows/orderFlow.js'),
  bakery:     read('../modules/bakery/flows/orderFlow.js'),
  salon:      read('../modules/salon/flows/index.js'),
  cosmetics:  read('../modules/cosmetics/flows/orderFlow.js'),
};

for (const [vertical, src] of Object.entries(files)) {
  test(`${vertical}: imports parseNaturalOrderMessage`, () => {
    assert.match(src, /parseNaturalOrderMessage/, `${vertical} must import parseNaturalOrderMessage`);
  });

  test(`${vertical}: add-more-items fallback no longer hardcodes quantity: 1 from findBestMatch(menu, clean)`, () => {
    // The exact old bug pattern must not reappear: findBestMatch(menu, clean)
    // immediately followed by a hardcoded quantity: 1 line, with no
    // quantity-aware parser in between.
    assert.doesNotMatch(
      src,
      /findBestMatch\(menu,\s*clean\)[^]*?quantity:\s*1,\s*variant:\s*null/,
      `${vertical} must not silently hardcode quantity: 1 in the add-more fallback`,
    );
  });

  test(`${vertical}: fallback resolves via parseNaturalOrderMessage(menu, raw)`, () => {
    assert.match(
      src,
      /parseNaturalOrderMessage\(menu,\s*raw\)/,
      `${vertical} fallback must call parseNaturalOrderMessage(menu, raw)`,
    );
  });
}
