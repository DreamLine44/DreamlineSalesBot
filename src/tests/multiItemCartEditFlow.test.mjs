// tests/multiItemCartEditFlow.test.mjs
//
// [MULTICART-v40-EDIT] Regression tests for the cart-editing helpers added to
// core/shared/cartEngine.js to support the consolidated Edit Order flow
// (Add / Remove / Increase / Decrease / Clear Cart / Back to Summary).
//
// Pure-function tests only — consistent with multiItemCartOrderService.test.mjs
// and cartEngine.js's own isolation rationale (no mongoose, no session/network).
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  removeCartLine, incrementCartLine, decrementCartLine, clearCart,
  cartItemCount, formatNumberedCartSummary, cartTotal,
} from '../core/shared/cartEngine.js';

function line(name, price, quantity) {
  return { item: { _id: name, name, price }, quantity, variant: null, addOns: [] };
}

test('removeCartLine drops only the targeted line, does not mutate the input array', () => {
  const cart = [line('Jollof Rice', 150, 1), line('Yassa Chicken', 200, 3), line('Akara', 50, 1)];
  const result = removeCartLine(cart, 1);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(l => l.item.name), ['Jollof Rice', 'Akara']);
  assert.equal(cart.length, 3, 'original cart must be untouched');
});

test('incrementCartLine increases quantity on the targeted line only', () => {
  const cart = [line('Jollof Rice', 150, 1), line('Akara', 50, 1)];
  const result = incrementCartLine(cart, 0, 2);
  assert.equal(result[0].quantity, 3);
  assert.equal(result[1].quantity, 1);
  assert.equal(cart[0].quantity, 1, 'original cart must be untouched');
});

test('decrementCartLine reduces quantity but never below removal', () => {
  const cart = [line('Jollof Rice', 150, 3)];
  const once = decrementCartLine(cart, 0, 1);
  assert.equal(once[0].quantity, 2);
});

test('decrementCartLine removes the line entirely once quantity would hit 0', () => {
  const cart = [line('Jollof Rice', 150, 1), line('Akara', 50, 2)];
  const result = decrementCartLine(cart, 0, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].item.name, 'Akara');
});

test('decrementCartLine on a missing index is a safe no-op (returns a copy)', () => {
  const cart = [line('Jollof Rice', 150, 1)];
  const result = decrementCartLine(cart, 5, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].quantity, 1);
});

test('clearCart always returns an empty array', () => {
  assert.deepEqual(clearCart(), []);
});

test('cartItemCount sums quantities across all lines', () => {
  const cart = [line('Jollof Rice', 150, 1), line('Yassa Chicken', 200, 3), line('Akara', 50, 1)];
  assert.equal(cartItemCount(cart), 5);
});

test('formatNumberedCartSummary prefixes each line with its 1-based index', () => {
  const cart = [line('Jollof Rice', 150, 2), line('Akara', 50, 1)];
  const summary = formatNumberedCartSummary(cart, { payment: { currency: 'D' } });
  assert.match(summary, /^1\. 2× Jollof Rice — D300/);
  assert.match(summary, /2\. 1× Akara — D50$/);
});

test('a full remove-then-recompute cycle keeps cartTotal consistent', () => {
  let cart = [line('Jollof Rice', 150, 1), line('Yassa Chicken', 200, 3), line('Akara', 50, 1)];
  assert.equal(cartTotal(cart), 150 + 600 + 50);
  cart = removeCartLine(cart, 1); // remove Yassa Chicken
  assert.equal(cartTotal(cart), 150 + 50);
  cart = incrementCartLine(cart, 0, 4); // Jollof Rice: 1 -> 5
  assert.equal(cartTotal(cart), 150 * 5 + 50);
});
