// tests/promoOrderWiring.test.mjs
//
// [FIX-PROMO-WIRE] Regression tests for wiring promoService.js's
// validatePromoCode/applyPromoUsage into orderService.saveOrder(). Before
// this fix:
//   - saveOrder() didn't accept a promoCode parameter at all, and never
//     called either promoService function, despite promoService.js's own
//     header comment claiming "saveOrder() already accepts and applies a
//     promoCode whenever a caller supplies one".
//   - BusinessConfig had no `promotions` field declared at all, so even a
//     correctly-wired caller would see validatePromoCode() return "Invalid
//     promo code" for every code, permanently, since business.promotions
//     was always undefined.
//
// Mocks BusinessConfig.findOne/updateOne and Order.create (mutable Mongoose
// Model objects, not ESM namespace exports — a namespace object's own
// exports are frozen/non-writable, so `promoService.validatePromoCode = ...`
// throws; mocking the underlying model lets the REAL validatePromoCode/
// applyPromoUsage logic run against fake data instead).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

const Order          = (await import('../models/Order.js')).default;
const BusinessConfig  = (await import('../models/BusinessConfig.js')).default;
const { saveOrder }   = await import('../services/orderService.js');

let lastCreateArgs = null;
Order.create = async (args) => {
  lastCreateArgs = args;
  return { ...args, _id: 'fake-order-id' };
};

let mockBusiness = null; // set per-test
BusinessConfig.findOne = () => ({
  select: () => ({ lean: async () => mockBusiness }),
});
let lastUpdateOneArgs = null;
BusinessConfig.updateOne = async (filter, update) => {
  lastUpdateOneArgs = { filter, update };
  return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
};

test('saveOrder: no promoCode supplied -> no discount, totalPrice unchanged (no-op path)', async () => {
  lastCreateArgs = null;
  await saveOrder({
    item: 'Burger', quantity: 2, totalPrice: 20,
    customerPhone: '+1000', tenantId: 'tenantA', businessId: 'bizA',
  });
  assert.equal(lastCreateArgs.totalPrice, 20);
  assert.equal(lastCreateArgs.promoCode, null);
  assert.equal(lastCreateArgs.discountAmount, 0);
  assert.equal(lastCreateArgs.originalTotal, null);
});

test('saveOrder: a VALID promoCode actually discounts the persisted totalPrice', async () => {
  mockBusiness = {
    promotions: [{
      code: 'SAVE5', type: 'FIXED', value: 5, active: true,
      expiresAt: null, maxUses: null, usedCount: 0, minOrderValue: null,
    }],
  };
  lastCreateArgs = null;

  await saveOrder({
    item: 'Burger', quantity: 2, totalPrice: 20,
    customerPhone: '+1000', tenantId: 'tenantA', businessId: 'bizA',
    promoCode: 'save5',
  });

  assert.equal(lastCreateArgs.totalPrice, 15, 'the DISCOUNTED total must be what gets persisted');
  assert.equal(lastCreateArgs.promoCode, 'SAVE5', 'promoCode must be persisted normalised (uppercase)');
  assert.equal(lastCreateArgs.discountAmount, 5);
  assert.equal(lastCreateArgs.originalTotal, 20, 'the pre-discount subtotal must also be recorded');
});

test('saveOrder: a PERCENT promoCode computes correctly against the real subtotal', async () => {
  mockBusiness = {
    promotions: [{
      code: 'TENOFF', type: 'PERCENT', value: 10, active: true,
      expiresAt: null, maxUses: null, usedCount: 0, minOrderValue: null,
    }],
  };
  lastCreateArgs = null;

  await saveOrder({
    item: 'Cake', quantity: 1, totalPrice: 50,
    customerPhone: '+1000', tenantId: 'tenantA', businessId: 'bizA',
    promoCode: 'TENOFF',
  });

  assert.equal(lastCreateArgs.discountAmount, 5);
  assert.equal(lastCreateArgs.totalPrice, 45);
});

test('saveOrder: usage is only consumed AFTER the order is created (BusinessConfig.updateOne called with the right code)', async () => {
  mockBusiness = {
    promotions: [{ code: 'SAVE5', type: 'FIXED', value: 5, active: true, maxUses: null, usedCount: 0 }],
  };
  lastUpdateOneArgs = null;

  await saveOrder({
    item: 'Burger', quantity: 1, totalPrice: 20,
    customerPhone: '+1000', tenantId: 'tenantA', businessId: 'bizA',
    promoCode: 'SAVE5',
  });

  // applyPromoUsage is fire-and-forget — give the microtask queue a tick.
  await new Promise(r => setTimeout(r, 20));
  assert.ok(lastUpdateOneArgs, 'applyPromoUsage must call BusinessConfig.updateOne to consume the usage slot');
  assert.equal(lastUpdateOneArgs.filter.tenantId, 'tenantA');
  assert.equal(lastUpdateOneArgs.filter['promotions.code'], 'SAVE5');
});

test('saveOrder: an INVALID promoCode never blocks the order — it just fails to discount', async () => {
  mockBusiness = { promotions: [] }; // no matching code at all
  lastCreateArgs = null;

  const order = await saveOrder({
    item: 'Burger', quantity: 1, totalPrice: 20,
    customerPhone: '+1000', tenantId: 'tenantA', businessId: 'bizA',
    promoCode: 'FAKECODE',
  });

  assert.ok(order, 'the order must still be created even when the promo code is invalid');
  assert.equal(lastCreateArgs.totalPrice, 20, 'totalPrice must stay at the undiscounted subtotal');
  assert.equal(lastCreateArgs.promoCode, null, 'an invalid code must never be persisted as applied');
});

test('saveOrder: an EXPIRED promoCode is rejected, order still succeeds without a discount', async () => {
  mockBusiness = {
    promotions: [{
      code: 'OLDCODE', type: 'FIXED', value: 5, active: true,
      expiresAt: new Date('2020-01-01'), maxUses: null, usedCount: 0,
    }],
  };
  lastCreateArgs = null;

  const order = await saveOrder({
    item: 'Burger', quantity: 1, totalPrice: 20,
    customerPhone: '+1000', tenantId: 'tenantA', businessId: 'bizA',
    promoCode: 'OLDCODE',
  });

  assert.ok(order);
  assert.equal(lastCreateArgs.totalPrice, 20);
  assert.equal(lastCreateArgs.promoCode, null);
});

test('saveOrder: a promoService/BusinessConfig failure (thrown error) is caught — order creation is never blocked', async () => {
  const originalFindOne = BusinessConfig.findOne;
  BusinessConfig.findOne = () => { throw new Error('DB hiccup'); };
  lastCreateArgs = null;
  try {
    const order = await saveOrder({
      item: 'Burger', quantity: 1, totalPrice: 20,
      customerPhone: '+1000', tenantId: 'tenantA', businessId: 'bizA',
      promoCode: 'ANYCODE',
    });
    assert.ok(order, 'a promoService exception must never prevent the order from being saved');
    assert.equal(lastCreateArgs.totalPrice, 20);
  } finally {
    BusinessConfig.findOne = originalFindOne;
  }
});

// ── BusinessConfig schema ───────────────────────────────────────────────────

test('models/BusinessConfig.js: promotions field is declared on the schema (was previously missing entirely)', async () => {
  const paths = BusinessConfig.schema.paths;
  assert.ok(paths['promotions'], 'BusinessConfig schema must declare a promotions field');
});
