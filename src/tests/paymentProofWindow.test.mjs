// tests/paymentProofWindow.test.mjs
//
// Pure, additive regression tests for services/paymentService.js's receiveProof().
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Order from '../models/Order.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { receiveProof } from '../services/payment/paymentService.js';

// [FIX-PROOF-WINDOW] regression: adminCommandService.rejectPayment() reactivates a
// rejected order for retry by resetting paymentStatus back to 'unpaid' and stamping
// paymentReviewedAt — but it never touches createdAt. receiveProof()'s lookup query
// was previously gated ONLY on `createdAt >= now - PROOF_WINDOW_HOURS`, so a customer
// whose order was placed more than PROOF_WINDOW_HOURS ago, then rejected and reopened
// for retry (via RESEND_PROOF) just moments ago, would send a new screenshot and get
// "we couldn't find a pending order to attach this payment to" — even though the order
// was legitimately active and explicitly reopened for exactly this purpose.

function withStubbedOrder(fakeOrder, run) {
  const originalFindOne = Order.findOne;
  const originalUpdateOne = Order.updateOne;
  const originalBizFindOne = BusinessConfig.findOne;
  let capturedFilter = null;
  Order.findOne = (filter) => {
    capturedFilter = filter;
    return { sort: () => Promise.resolve(fakeOrder) };
  };
  Order.updateOne = () => Promise.resolve({ acknowledged: true });
  // tenantDoc is null in these tests, so receiveProof's `if (adminPhone && tenantDoc)`
  // guard is false and admin notification is skipped — but BusinessConfig.findOne is
  // still called unconditionally beforehand, so it must be stubbed regardless.
  BusinessConfig.findOne = () => ({ lean: () => Promise.resolve(null) });
  return run(() => capturedFilter).finally(() => {
    Order.findOne = originalFindOne;
    Order.updateOne = originalUpdateOne;
    BusinessConfig.findOne = originalBizFindOne;
  });
}

test('receiveProof: finds a rejected-then-reopened order even when its createdAt is far outside the proof window', async () => {
  // Order placed 10 hours ago (well outside the default 4h PROOF_WINDOW_HOURS),
  // rejected and reopened for retry 5 minutes ago.
  const fakeOrder = {
    _id: 'order1',
    customerPhone: '2207000000',
    tenantId: 'tenant1',
    paymentStatus: 'unpaid',
    createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
    paymentReviewedAt: new Date(Date.now() - 5 * 60 * 1000),
    item: 'Chicken Yassa',
    quantity: 1,
    shortId: 'ORD123',
  };

  await withStubbedOrder(fakeOrder, async (getFilter) => {
    const reply = await receiveProof('2207000000', 'tenant1', 'IMG123', null);
    assert.ok(
      !reply.includes("couldn't find a pending order"),
      `expected the reopened order to be found, got: ${reply}`
    );
    const filter = getFilter();
    assert.ok(filter.$or, 'query should use $or to cover both createdAt and paymentReviewedAt windows');
  });
});

test('receiveProof: a fresh unpaid order created within the window is still found (unchanged behaviour)', async () => {
  const fakeOrder = {
    _id: 'order2',
    customerPhone: '2207000001',
    tenantId: 'tenant1',
    paymentStatus: 'unpaid',
    createdAt: new Date(), // just created
    paymentReviewedAt: null,
    item: 'Domoda',
    quantity: 2,
    shortId: 'ORD124',
  };

  await withStubbedOrder(fakeOrder, async () => {
    const reply = await receiveProof('2207000001', 'tenant1', 'IMG124', null);
    assert.ok(!reply.includes("couldn't find a pending order"));
  });
});

test('receiveProof: reports no order found when neither createdAt nor paymentReviewedAt are within the window', async () => {
  await withStubbedOrder(null, async () => {
    const reply = await receiveProof('2207000002', 'tenant1', 'IMG125', null);
    assert.ok(reply.includes("couldn't find a pending order"));
  });
});
