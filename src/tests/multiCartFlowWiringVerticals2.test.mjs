// tests/multiCartFlowWiringVerticals2.test.mjs
//
// [MULTICART-FLOW-1] Wiring guards for the retail, delivery, and fashion
// rollout of the multi-item cart flow — the second batch, following
// multiCartFlowWiringVerticals.test.mjs (bakery/cosmetics/electronics) and
// the restaurant/salon coverage which uses the separate, more mature
// core/shared/cartEngine.js integration instead (see cartEngineParser.test.mjs
// and the restaurant/salon source directly) — salon is intentionally excluded
// here since it does not use utils/multiItemParser.js's extractCartLines().
// Same source-text-guard approach: these flow files pull in Mongoose/session
// deps unsafe to exercise without a live DB.
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// retail and fashion have their own per-item variant sub-flow (SELECT_VARIANT /
// SELECT_SIZE+SELECT_COLOR) with no per-cart-line equivalent, so cart entry is
// additionally gated on every matched item having zero variants. delivery's
// product-order sub-flow has no variant step at all, so 2+ matches is the
// only gate.
const verticals = [
  { name: 'retail',   path: '../modules/retail/flows/index.js',   variantGated: true  },
  { name: 'delivery', path: '../modules/delivery/flows/index.js', variantGated: false },
  { name: 'fashion',  path: '../modules/fashion/flows/index.js',  variantGated: true  },
];

for (const { name, path, variantGated } of verticals) {
  const src = read(path);
  const scopeStart = 0;

  test(`${name}: imports the shared multi-item parser`, () => {
    assert.match(src, /extractCartLines.*from ['"]\.\.\/\.\.\/\.\.\/utils\/multiItemParser\.js['"]/);
  });

  test(`${name}: SELECT_ITEM gates the cart branch on 2+ matched items`, () => {
    const selectStart = src.indexOf("case 'SELECT_ITEM'", scopeStart);
    assert.ok(selectStart !== -1, `${name}: SELECT_ITEM case not found`);
    const cartParseIdx = src.indexOf('extractCartLines(raw,', selectStart);
    assert.ok(cartParseIdx !== -1, `${name}: expected extractCartLines() call inside SELECT_ITEM`);
    const gateSlice = src.slice(cartParseIdx, cartParseIdx + 400);
    assert.match(gateSlice, /matchedCount\s*>=\s*2/, `${name}: cart branch must require 2+ distinct matched items`);
    if (variantGated) {
      assert.match(gateSlice, /_hasNoVariants/, `${name}: cart branch must also require every matched line to have zero variants`);
    }
  });

  test(`${name}: a CART_REVIEW step exists and handles checkout, add-more, and merging`, () => {
    const start = src.indexOf("case 'CART_REVIEW'", scopeStart);
    assert.ok(start !== -1, `${name}: CART_REVIEW case not found`);
    const body = src.slice(start, start + 3000);
    assert.match(body, /wantsCheckout/);
    assert.match(body, /wantsAddMore/);
    assert.match(body, /_mergeCartLines/, `${name}: new items typed mid-review must merge into the existing cart`);
  });

  test(`${name}: _mergeCartLines sums quantities for a repeated item`, () => {
    const start = src.indexOf('function _mergeCartLines');
    assert.ok(start !== -1, `${name}: _mergeCartLines helper not found`);
    const body = src.slice(start, start + 700);
    assert.match(body, /existing\.quantity\s*\+=/);
  });

  test(`${name}: CONFIRM is cart-aware`, () => {
    const start = src.indexOf("case 'CONFIRM'", scopeStart);
    assert.ok(start !== -1, `${name}: CONFIRM case not found`);
    const body = src.slice(start, start + 3500);
    assert.match(body, /isCart/);
  });
}

// retail and fashion: saveOrder's items[] contract, gated on _hasNoVariants
for (const name of ['retail', 'fashion']) {
  test(`${name}: cart entry is gated on zero variants (no per-line variant sub-flow exists)`, () => {
    const path = name === 'retail' ? '../modules/retail/flows/index.js' : '../modules/fashion/flows/index.js';
    const src = read(path);
    const selectStart = src.indexOf("case 'SELECT_ITEM'");
    const cartParseIdx = src.indexOf('extractCartLines(raw,', selectStart);
    const gateSlice = src.slice(cartParseIdx, cartParseIdx + 400);
    assert.match(gateSlice, /_hasNoVariants/, 'an item with variants must not silently enter the cart flow without its variant being collected');
  });
}
