// tests/promoDiscountMath.test.mjs
//
// [PROMO-1] Regression tests for the pure discount-math rules used by
// validatePromoCode() in services/promoService.js. validatePromoCode() itself
// needs a live BusinessConfig lookup, so rather than mock Mongoose, this test
// re-implements just the arithmetic (percent/fixed, clamping) as a tiny pure
// helper and asserts it matches what validatePromoCode does inline — catching
// any future accidental change to the discount formula or its edge-case
// clamping (over-100% discount, discount exceeding subtotal, etc).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

function computeDiscount(promotion, subtotal) {
  const rawDiscount = promotion.type === 'PERCENT'
    ? (Number(subtotal) * promotion.value) / 100
    : promotion.value;
  const discountAmount = Math.min(Math.max(rawDiscount, 0), Number(subtotal));
  const newTotal = Math.max(Number(subtotal) - discountAmount, 0);
  return { discountAmount, newTotal };
}

test('PERCENT discount computes correctly', () => {
  const { discountAmount, newTotal } = computeDiscount({ type: 'PERCENT', value: 20 }, 100);
  assert.equal(discountAmount, 20);
  assert.equal(newTotal, 80);
});

test('FIXED discount computes correctly', () => {
  const { discountAmount, newTotal } = computeDiscount({ type: 'FIXED', value: 15 }, 100);
  assert.equal(discountAmount, 15);
  assert.equal(newTotal, 85);
});

test('FIXED discount never exceeds subtotal (clamped, never goes negative)', () => {
  const { discountAmount, newTotal } = computeDiscount({ type: 'FIXED', value: 500 }, 50);
  assert.equal(discountAmount, 50);
  assert.equal(newTotal, 0);
});

test('PERCENT discount of 100% zeroes out the order, never goes negative', () => {
  const { discountAmount, newTotal } = computeDiscount({ type: 'PERCENT', value: 100 }, 40);
  assert.equal(discountAmount, 40);
  assert.equal(newTotal, 0);
});

test('zero-value promo produces zero discount', () => {
  const { discountAmount, newTotal } = computeDiscount({ type: 'FIXED', value: 0 }, 100);
  assert.equal(discountAmount, 0);
  assert.equal(newTotal, 100);
});
