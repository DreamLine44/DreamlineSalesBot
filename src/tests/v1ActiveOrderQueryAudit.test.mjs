// tests/v1ActiveOrderQueryAudit.test.mjs
//
// Regression test for the v1 systematic audit.
//
// Bug found and fixed:
//
// [AUDIT-FIX-AOR-QUERY-REJECT] services/activeOrderResolver.js's resolveActiveOrder()
// correctly detects an admin-rejected order in _resolveState() via the real written
// signal (status:'pending' + paymentStatus:'unpaid' + paymentReviewedAt set — see
// FIX-AOR-REJECT), but the Mongo query feeding _resolveState() never actually surfaced
// those orders once they were more than 24h old. The query's clause for general
// 'pending' orders is intentionally bounded to the last 24h (AUDIT-FIX-2, so abandoned
// carts age out) — but a rejected order is not an abandoned cart, it's an order awaiting
// explicit customer action, and it shares the exact same status:'pending' /
// paymentStatus:'unpaid' shape. An admin who reviews and rejects an order more than 24h
// after it was placed (routine — admins don't always respond same-day) produced an order
// that the query silently dropped entirely, so a customer whose session expired
// afterward and returned later was routed to NO_ACTIVE_ORDER instead of the "Payment Not
// Approved" card with their rejection reason and a retry button — even though
// _resolveState() would have handled it correctly had the order reached it.
//
// The existing activeOrderRejection.test.mjs suite stubs Order.find() entirely (bypassing
// the real filter object), so it verifies _resolveState()'s branching logic but never
// exercised whether the query itself would actually return the order. This test inspects
// the real filter construction instead, the same way paymentProofWindow.test.mjs already
// does for receiveProof()'s equivalent query.
//
// Run with:  node --test src/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Order from '../models/Order.js';
import { resolveActiveOrder, ACTIVE_ORDER_STATES } from '../services/order/activeOrderResolver.js';

function withCapturedFilter(fakeOrders, run) {
  const original = Order.find;
  let capturedFilter = null;
  Order.find = (filter) => {
    capturedFilter = filter;
    return { sort: () => ({ limit: () => ({ lean: () => Promise.resolve(fakeOrders) }) }) };
  };
  return run(() => capturedFilter).finally(() => { Order.find = original; });
}

test('resolveActiveOrder: query includes a clause matching admin-rejected orders regardless of age', async () => {
  await withCapturedFilter([], async (getFilter) => {
    await resolveActiveOrder('2207000000', 'tenant1', null, null);
    const filter = getFilter();
    assert.ok(filter.$or, 'query should use $or');
    const hasUnboundedRejectClause = filter.$or.some(clause =>
      clause.status === 'pending' &&
      clause.paymentStatus === 'unpaid' &&
      clause.paymentReviewedAt &&
      clause.paymentReviewedAt.$ne === null &&
      !clause.createdAt // must NOT be bounded by the abandoned-cart 24h cutoff
    );
    assert.ok(hasUnboundedRejectClause, 'expected an age-unbounded clause for pending/unpaid/paymentReviewedAt-set orders');
  });
});

test('resolveActiveOrder: an admin-rejected order older than 24h still resolves to PAYMENT_REJECTED end-to-end', async () => {
  // Simulates the real Mongo query actually matching and returning this order —
  // unlike activeOrderRejection.test.mjs's stub, which hands _resolveState the
  // order directly and never proves the query itself would have found it.
  const staleRejectedOrder = {
    _id: 'stale1',
    customerPhone: '2207000009',
    tenantId: 'tenant1',
    status: 'pending',
    paymentStatus: 'unpaid',
    // Order placed 3 days ago — well past the 24h abandoned-cart cutoff.
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    // Rejected by the admin 10 minutes ago — recent, but createdAt is stale.
    paymentReviewedAt: new Date(Date.now() - 10 * 60 * 1000),
    rejectedNote: 'Screenshot unclear',
    item: 'Chicken Yassa',
    quantity: 1,
    shortId: 'ORD999',
    totalPrice: 350,
    updatedAt: new Date(),
  };

  await withCapturedFilter([staleRejectedOrder], async () => {
    const result = await resolveActiveOrder('2207000009', 'tenant1', { payment: { currency: 'D' } }, null);
    assert.equal(result.state, ACTIVE_ORDER_STATES.PAYMENT_REJECTED, `expected PAYMENT_REJECTED, got ${result.state}`);
    assert.equal(result.shouldIntercept, true);
    assert.ok(result.uiResponse.body.includes('Screenshot unclear'), 'rejection reason should be surfaced to the customer');
  });
});
