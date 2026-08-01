// tests/cosmeticsCartWiring.test.mjs
//
// [CART-AI] Regression tests confirming modules/cosmetics/flows/orderFlow.js
// is wired into the shared multi-item cart engine, restricted to shade-less
// products (a multi-item cart line has no per-line shade picker yet, so any
// message resolving a shade-bearing item must still fall through to the
// existing single-item SELECT_SHADE flow). Source-text guards, consistent
// with tests/bakeryCartWiring.test.mjs and the rest of this suite's
// v*Audit-style tests for modules that pull in mongoose-backed services.
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const src = read('../modules/cosmetics/flows/orderFlow.js');

test('cosmetics orderFlow.js imports the shared cart engine', () => {
  assert.match(src, /from ['"]\.\.\/\.\.\/\.\.\/core\/shared\/cartEngine\.js['"]/);
  for (const fn of [
    'parseMultiItemMessage', 'mergeCartLines', 'enforceCartLimit',
    'cartTotal', 'cartToOrderItems', 'formatCartSummary', 'buildUnmatchedNote',
    'parseCartModification', 'applyCartModification',
  ]) {
    assert.ok(src.includes(fn), `expected orderFlow.js to import/use ${fn}`);
  }
});

test('SELECT_ITEM restricts multi-item parsing to shade-less products only', () => {
  const selectItemBlock = src.slice(src.indexOf("case 'SELECT_ITEM'"), src.indexOf("case 'CART_REVIEW'"));
  assert.match(selectItemBlock, /parseMultiItemMessage\(menu, raw\)/);
  assert.match(selectItemBlock, /!multi\.lines\.some\(l => _shadeOptions\(l\.item\)\.length\)/);
  assert.match(selectItemBlock, /step:\s*'CART_REVIEW'/);
});

test('CART_REVIEW add-more path also respects the shade-less restriction', () => {
  const cartReviewBlock = src.slice(src.indexOf("case 'CART_REVIEW'"), src.indexOf("case 'SELECT_SHADE'"));
  assert.match(cartReviewBlock, /parseCartModification\(cart, raw\)/);
  assert.match(cartReviewBlock, /!multiAdd\.lines\.some\(l => _shadeOptions\(l\.item\)\.length\)/);
  assert.match(cartReviewBlock, /!_shadeOptions\(singleItem\)\.length/);
});

test('checkout from CART_REVIEW goes to GIFT_NOTE, skipping SELECT_SHADE/QUANTITY', () => {
  const cartReviewBlock = src.slice(src.indexOf("case 'CART_REVIEW'"), src.indexOf("case 'SELECT_SHADE'"));
  assert.match(cartReviewBlock, /step:\s*'GIFT_NOTE'/);
});

test('CONFIRM builds items[] from the cart when a multi-item cart is present', () => {
  const confirmBlock = src.slice(src.indexOf("case 'CONFIRM'"));
  assert.match(confirmBlock, /isCart\s*=\s*cart\.length\s*>\s*0/);
  assert.match(confirmBlock, /items:\s*cartToOrderItems\(cart\)/);
  assert.match(confirmBlock, /totalPrice:\s*cartTotal\(cart\)/);
});

test('the ORDER step config documents CART_REVIEW alongside the existing steps', () => {
  const configSrc = read('../modules/cosmetics/flows/index.js');
  assert.match(configSrc, /ORDER:\s*\[[^\]]*'CART_REVIEW'[^\]]*\]/);
});
