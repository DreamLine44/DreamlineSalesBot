// tests/upsellAddOnPricing.test.mjs
//
// [AUDIT-FIX-UPSELL-PRICE-1] Regression coverage for the bug where an
// accepted paid upsell add-on (e.g. "add a Coke for D50?") was computed into
// a local `finalTotal` in orderFlow.js's UPSELL step, then silently
// discarded — cartToOrderItems()/saveOrder() only ever summed
// unitPrice*quantity, so the add-on was never actually charged or persisted.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCartLines, cartToOrderItems, formatCartSummary, formatNumberedCartSummary } from '../core/shared/cartEngine.js';
import { resolveOrderFields } from '../services/order/orderService.js';

const jollof = { _id: '1', name: 'Jollof Rice', price: 200, available: true };
const coke   = { name: 'Coke', price: 50 };

test('a cart line with an accepted paid add-on carries addOnsTotal through cartToOrderItems', () => {
  const cart = mergeCartLines([], [
    { item: jollof, quantity: 2, variant: null, addOns: [coke.name], addOnsTotal: coke.price },
  ]);
  const items = cartToOrderItems(cart);
  assert.equal(items.length, 1);
  assert.equal(items[0].unitPrice, 200);
  assert.equal(items[0].addOnsTotal, 50);
  assert.deepEqual(items[0].addOns, ['Coke']);
});

test('resolveOrderFields sums unitPrice*quantity PLUS each line\'s flat addOnsTotal', () => {
  const cart = mergeCartLines([], [
    { item: jollof, quantity: 2, variant: null, addOns: [coke.name], addOnsTotal: coke.price },
  ]);
  const items = cartToOrderItems(cart);
  const { resolvedTotal } = resolveOrderFields({ items });
  // 2 * 200 (base) + 50 (flat add-on, NOT multiplied by quantity) = 450
  assert.equal(resolvedTotal, 450);
});

test('re-adding the same item with a newly-accepted add-on merges addOns/addOnsTotal instead of dropping them', () => {
  let cart = mergeCartLines([], [{ item: jollof, quantity: 1, variant: null, addOns: [], addOnsTotal: 0 }]);
  // Same item+variant added again, this time with an accepted add-on
  cart = mergeCartLines(cart, [{ item: jollof, quantity: 1, variant: null, addOns: [coke.name], addOnsTotal: coke.price }]);

  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 2);
  assert.equal(cart[0].addOnsTotal, 50);
  assert.deepEqual(cart[0].addOns, ['Coke']);
});

test('formatCartSummary / formatNumberedCartSummary include the add-on price in the displayed line total', () => {
  const cart = mergeCartLines([], [
    { item: jollof, quantity: 2, variant: null, addOns: [coke.name], addOnsTotal: coke.price },
  ]);
  const business = { payment: { currency: 'D' } };
  // 2 * 200 + 50 = 450
  assert.match(formatCartSummary(cart, business), /D450(\.00)?/);
  assert.match(formatNumberedCartSummary(cart, business), /D450(\.00)?/);
});

test('a cart line with no add-on still totals correctly (no regression for the common case)', () => {
  const cart = mergeCartLines([], [{ item: jollof, quantity: 3, variant: null, addOns: [], addOnsTotal: 0 }]);
  const items = cartToOrderItems(cart);
  const { resolvedTotal } = resolveOrderFields({ items });
  assert.equal(resolvedTotal, 600); // 3 * 200, no add-on
});
