// tests/multiCartFlowWiringVerticals.test.mjs
//
// [MULTICART-FLOW-1] Wiring guards for the bakery, cosmetics, and electronics
// rollout of the multi-item cart flow (see multiCartFlowWiring.test.mjs for
// the original restaurant coverage, and multiItemParser.test.mjs for the
// shared parser's own tests). Same source-text-guard approach as
// v22RestaurantFlowAudit.test.mjs — these flow files pull in Mongoose/session
// deps unsafe to exercise without a live DB.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const verticals = [
  { name: 'bakery',      path: '../modules/bakery/flows/orderFlow.js' },
  { name: 'cosmetics',   path: '../modules/cosmetics/flows/orderFlow.js' },
  { name: 'electronics', path: '../modules/electronics/flows/orderFlow.js' },
];

for (const { name, path } of verticals) {
  const src = read(path);

  test(`${name}: imports the shared multi-item parser`, () => {
    assert.match(src, /extractCartLines.*from ['"]\.\.\/\.\.\/\.\.\/utils\/multiItemParser\.js['"]/);
  });

  test(`${name}: SELECT_ITEM gates the cart branch on 2+ matched items`, () => {
    const selectStart = src.indexOf("case 'SELECT_ITEM'");
    assert.ok(selectStart !== -1, `${name}: SELECT_ITEM case not found`);
    const cartParseIdx = src.indexOf('extractCartLines(raw,', selectStart);
    assert.ok(cartParseIdx !== -1, `${name}: expected extractCartLines() call inside SELECT_ITEM`);
    const gateSlice = src.slice(cartParseIdx, cartParseIdx + 400);
    assert.match(gateSlice, /matchedCount\s*>=\s*2/, `${name}: cart branch must require 2+ distinct matched items`);
  });

  test(`${name}: a CART_REVIEW step exists and handles checkout, add-more, and merging`, () => {
    const start = src.indexOf("case 'CART_REVIEW'");
    assert.ok(start !== -1, `${name}: CART_REVIEW case not found`);
    const body = src.slice(start, start + 3500);
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

  test(`${name}: CONFIRM saves cart orders through the real items[] contract`, () => {
    const start = src.indexOf("case 'CONFIRM'");
    assert.ok(start !== -1, `${name}: CONFIRM case not found`);
    const body = src.slice(start, start + 3000);
    assert.match(body, /isCart/);
    assert.match(body, /items:\s*isCart/, `${name}: saveOrder() must pass items[] when isCart`);
    assert.match(body, /unitPrice:\s*typeof l\.item\.price === 'number' \? l\.item\.price : undefined/, `${name}: partial pricing must pass through as undefined, not 0`);
  });
}

test('cosmetics: cart entry is gated on zero shade options (no per-line shade sub-flow exists)', () => {
  const src = read('../modules/cosmetics/flows/orderFlow.js');
  const selectStart = src.indexOf("case 'SELECT_ITEM'");
  const cartParseIdx = src.indexOf('extractCartLines(raw,', selectStart);
  const gateSlice = src.slice(cartParseIdx, cartParseIdx + 400);
  assert.match(gateSlice, /_shadeOptions\(l\.item\)\.length === 0/, 'a shaded product must not silently enter the cart flow without a shade being collected');
});

test('electronics: cart checkout replicates the hasDelivery/hasPickup auto-skip used by QUANTITY', () => {
  const src = read('../modules/electronics/flows/orderFlow.js');
  const start = src.indexOf("case 'CART_REVIEW'");
  const body  = src.slice(start, start + 2000);
  assert.match(body, /hasDelivery/);
  assert.match(body, /hasPickup/);
});

test('bakery: cart checkout skips the per-item QUANTITY step straight to NOTES', () => {
  const src = read('../modules/bakery/flows/orderFlow.js');
  const start = src.indexOf("case 'CART_REVIEW'");
  const body  = src.slice(start, start + 1500);
  assert.match(body, /step:\s*'NOTES'/);
});
