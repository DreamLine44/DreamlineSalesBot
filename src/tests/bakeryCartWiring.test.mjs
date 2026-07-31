// tests/bakeryCartWiring.test.mjs
//
// [CART-AI] Regression tests confirming modules/bakery/flows/orderFlow.js is
// wired into the shared multi-item cart engine (core/shared/cartEngine.js),
// the same way restaurant/flows/orderFlow.js and salon/flows/index.js
// already are. Source-text guards, not live-DB tests — bakery's orderFlow.js
// pulls in mongoose-backed services (sessionService, orderService) at module
// scope, so it isn't designed for isolated import without a live Mongo
// connection, consistent with how midFlowOrderBookingSwitch.test.mjs and the
// other v*Audit.test.mjs files in this suite handle the same constraint.
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const src = read('../modules/bakery/flows/orderFlow.js');

test('bakery orderFlow.js imports the shared cart engine', () => {
  assert.match(src, /from ['"]\.\.\/\.\.\/\.\.\/core\/shared\/cartEngine\.js['"]/);
  for (const fn of [
    'parseMultiItemMessage', 'mergeCartLines', 'enforceCartLimit',
    'cartTotal', 'cartToOrderItems', 'formatCartSummary', 'buildUnmatchedNote',
    'parseCartModification', 'applyCartModification',
  ]) {
    assert.ok(src.includes(fn), `expected orderFlow.js to import/use ${fn}`);
  }
});

test('SELECT_ITEM tries parseMultiItemMessage before falling back to single-item matching', () => {
  const selectItemBlock = src.slice(src.indexOf("case 'SELECT_ITEM'"), src.indexOf("case 'CART_REVIEW'"));
  assert.match(selectItemBlock, /parseMultiItemMessage\(menu, raw\)/);
  assert.match(selectItemBlock, /step:\s*'CART_REVIEW'/);
});

test('CART_REVIEW supports checkout, add-more, and cart modification (remove/resize)', () => {
  const cartReviewBlock = src.slice(src.indexOf("case 'CART_REVIEW'"), src.indexOf("case 'QUANTITY'"));
  assert.match(cartReviewBlock, /isCheckout/);
  assert.match(cartReviewBlock, /ADD_ANOTHER_ITEM/);
  assert.match(cartReviewBlock, /parseCartModification\(cart, raw\)/);
  assert.match(cartReviewBlock, /applyCartModification\(cart, mod\)/);
});

test('CONFIRM builds items[] from the cart (not a single item) when a multi-item cart is present', () => {
  const confirmBlock = src.slice(src.indexOf("case 'CONFIRM'"));
  assert.match(confirmBlock, /isCart\s*=\s*cart\.length\s*>\s*0/);
  assert.match(confirmBlock, /items:\s*cartToOrderItems\(cart\)/);
  assert.match(confirmBlock, /totalPrice:\s*cartTotal\(cart\)/);
});

test('the ORDER step config documents CART_REVIEW alongside the existing steps', () => {
  const configSrc = read('../modules/bakery/flows/index.js');
  assert.match(configSrc, /ORDER:\s*\[[^\]]*'CART_REVIEW'[^\]]*\]/);
});
