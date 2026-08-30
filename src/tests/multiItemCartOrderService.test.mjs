// tests/multiItemCartOrderService.test.mjs
//
// [MULTICART-v39] Phase 1 regression test.
//
// Covers resolveOrderFields() (src/services/orderService.js), the pure
// normalization function saveOrder() calls into. Two things must hold:
//   1. Backward compat: existing callers passing item/quantity/addOns
//      directly (no items[]) get back exactly what they put in — zero
//      behavior change for the 9 verticals that don't use carts yet.
//   2. New path: callers passing items[] get item/quantity/addOns mirrored
//      from items[0] (so dashboard/analytics/getLastOrderItem readers never
//      have to change), plus a summed totalPrice when none was given.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrderFields } from '../services/orderService.js';

test('single-item call (no items[]) — passes through unchanged, exactly like pre-v39', () => {
  const result = resolveOrderFields({
    item: 'Jollof Rice',
    quantity: 2,
    totalPrice: 300,
    addOns: ['extra sauce'],
  });

  assert.equal(result.hasCart, false);
  assert.equal(result.resolvedItem, 'Jollof Rice');
  assert.equal(result.resolvedQuantity, 2);
  assert.equal(result.resolvedTotal, 300);
  assert.deepEqual(result.resolvedAddOns, ['extra sauce']);
});

test('single-item call with no addOns/totalPrice — defaults match pre-v39 behavior', () => {
  const result = resolveOrderFields({ item: 'Lipstick', quantity: 1 });

  assert.equal(result.hasCart, false);
  assert.equal(result.resolvedItem, 'Lipstick');
  assert.equal(result.resolvedQuantity, 1);
  assert.deepEqual(result.resolvedAddOns, []);
  assert.equal(result.resolvedTotal, null);
});

test('multi-item call — item/quantity/addOns mirror items[0]', () => {
  const result = resolveOrderFields({
    items: [
      { item: 'Foundation', quantity: 1, addOns: ['sample sachet'], unitPrice: 450 },
      { item: 'Lipstick',   quantity: 2, unitPrice: 150 },
    ],
  });

  assert.equal(result.hasCart, true);
  assert.equal(result.resolvedItem, 'Foundation');
  assert.equal(result.resolvedQuantity, 1);
  assert.deepEqual(result.resolvedAddOns, ['sample sachet']);
});

test('multi-item call — totalPrice auto-sums from unitPrice*quantity when not explicitly given', () => {
  const result = resolveOrderFields({
    items: [
      { item: 'Foundation', quantity: 1, unitPrice: 450 },
      { item: 'Lipstick',   quantity: 2, unitPrice: 150 },
    ],
  });

  // 450*1 + 150*2 = 750
  assert.equal(result.resolvedTotal, 750);
});

test('multi-item call — explicit totalPrice always wins over the computed sum', () => {
  const result = resolveOrderFields({
    totalPrice: 999, // e.g. a discount was applied upstream
    items: [
      { item: 'Foundation', quantity: 1, unitPrice: 450 },
      { item: 'Lipstick',   quantity: 2, unitPrice: 150 },
    ],
  });

  assert.equal(result.resolvedTotal, 999);
});

test('empty items[] array is treated as no cart at all (falls back to scalar fields)', () => {
  const result = resolveOrderFields({ item: 'Blush', quantity: 1, items: [] });

  assert.equal(result.hasCart, false);
  assert.equal(result.resolvedItem, 'Blush');
});

// [AUDIT-FIX-MULTICART-1] Regression test for a bug found in audit: when only
// SOME cart items had a unitPrice, the sum silently added just the priced
// items and returned that partial figure as if it were the full order total.
test('multi-item call — partial pricing (one item missing unitPrice) yields null total, not a silent undercount', () => {
  const result = resolveOrderFields({
    items: [
      { item: 'Foundation', quantity: 1, unitPrice: 450 },
      { item: 'Lipstick',   quantity: 2 }, // no unitPrice — price unknown
    ],
  });

  // Pre-fix this returned 450 (Foundation's price alone), silently
  // presented as "the total" while Lipstick's cost was dropped.
  assert.equal(result.resolvedTotal, null);
});

test('multi-item call — all items missing unitPrice yields null total (unchanged baseline)', () => {
  const result = resolveOrderFields({
    items: [
      { item: 'Foundation', quantity: 1 },
      { item: 'Lipstick',   quantity: 2 },
    ],
  });

  assert.equal(result.resolvedTotal, null);
});

// [AUDIT-FIX-MULTICART-2] Regression test for a bug found in audit: items[]
// had no size ceiling at all — the multiItemCart.maxItems config field exists
// but is enforced nowhere (that enforcement is Phase 2's job, at the flow
// layer), leaving saveOrder() itself with zero protection against a stuck
// "add another item?" loop or a caller bug handing it an unbounded array.
test('multi-item call — cart exceeding the 50-item hard cap throws instead of silently saving', () => {
  const oversizedCart = Array.from({ length: 51 }, (_, i) => ({
    item: `Item${i}`, quantity: 1, unitPrice: 10,
  }));

  assert.throws(
    () => resolveOrderFields({ items: oversizedCart }),
    /exceeding the hard cap of 50/
  );
});

test('multi-item call — cart at exactly the 50-item cap is accepted', () => {
  const maxCart = Array.from({ length: 50 }, (_, i) => ({
    item: `Item${i}`, quantity: 1, unitPrice: 10,
  }));

  const result = resolveOrderFields({ items: maxCart });
  assert.equal(result.hasCart, true);
  assert.equal(result.resolvedTotal, 500);
});

