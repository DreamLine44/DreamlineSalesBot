import { test } from 'node:test';
import assert from 'node:assert/strict';
import Order from '../models/Order.js';
import { resolveActiveOrder, ACTIVE_ORDER_STATES } from '../services/activeOrderResolver.js';

// [FIX-AOR-REJECT] regression: adminCommandService.rejectPayment() never actually writes
// paymentStatus:'rejected' (it writes status:'pending', paymentStatus:'unpaid',
// paymentReviewedAt:<Date> so receiveProof() will accept a retry screenshot). Before this
// fix, activeOrderResolver only checked paymentStatus === 'rejected', so a customer whose
// session expired after an admin rejection and returned later got silently routed to
// NO_ACTIVE_ORDER instead of seeing the "Payment Not Approved" card with their rejection
// reason and a way to retry.

function withStubbedOrderFind(fakeOrders, run) {
  const original = Order.find;
  Order.find = () => ({
    sort:  () => ({ limit: () => ({ lean: () => Promise.resolve(fakeOrders) }) }),
  });
  return run().finally(() => { Order.find = original; });
}

test('resolveActiveOrder: detects admin-rejected payment via real written state (pending/unpaid/paymentReviewedAt), not the never-written "rejected" literal', async () => {
  const fakeOrder = {
    _id: 'abc123',
    customerPhone: '2207000000',
    tenantId: 'tenant1',
    status: 'pending',
    paymentStatus: 'unpaid',
    paymentReviewedAt: new Date(), // set by rejectPayment()
    rejectedNote: 'Wrong amount sent',
    item: 'Chicken Yassa',
    quantity: 1,
    shortId: 'ORD123',
    totalPrice: 350,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await withStubbedOrderFind([fakeOrder], async () => {
    const result = await resolveActiveOrder('2207000000', 'tenant1', { payment: { currency: 'D' } }, null);
    assert.equal(result.state, ACTIVE_ORDER_STATES.PAYMENT_REJECTED, `expected PAYMENT_REJECTED, got ${result.state}`);
    assert.equal(result.shouldIntercept, true);
    assert.ok(result.uiResponse.body.includes('Wrong amount sent'), 'rejection reason should be surfaced to the customer');
    const buttonIds = result.uiResponse.buttons.map(b => b.id);
    assert.ok(buttonIds.includes('RESEND_PROOF'), 'should offer a way to resend payment proof');
  });
});

test('resolveActiveOrder: a fresh never-reviewed pending order is NOT mistaken for a rejection', async () => {
  const fakeOrder = {
    _id: 'def456',
    customerPhone: '2207000001',
    tenantId: 'tenant1',
    status: 'pending',
    paymentStatus: 'unpaid',
    paymentReviewedAt: null, // never reviewed by an admin
    item: 'Domoda',
    quantity: 2,
    shortId: 'ORD124',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await withStubbedOrderFind([fakeOrder], async () => {
    const result = await resolveActiveOrder('2207000001', 'tenant1', { payment: { currency: 'D' } }, null);
    assert.notEqual(result.state, ACTIVE_ORDER_STATES.PAYMENT_REJECTED, 'an unreviewed pending order must not show the rejected-payment card');
  });
});

test('resolveActiveOrder: a confirmed order (paymentReviewedAt set by confirmPayment) is not mistaken for a rejection', async () => {
  const fakeOrder = {
    _id: 'ghi789',
    customerPhone: '2207000002',
    tenantId: 'tenant1',
    status: 'confirmed',
    paymentStatus: 'confirmed',
    paymentReviewedAt: new Date(), // set by confirmPayment()
    item: 'Benachin',
    quantity: 1,
    shortId: 'ORD125',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await withStubbedOrderFind([fakeOrder], async () => {
    const result = await resolveActiveOrder('2207000002', 'tenant1', { payment: { currency: 'D' } }, null);
    assert.equal(result.state, ACTIVE_ORDER_STATES.PAYMENT_VERIFIED);
  });
});

// [AUDIT-AOR-CONFIRMED] regression: a cash order accepted via AWAIT_ADMIN_CONFIRM, or an
// order confirmed through the dashboard PATCH endpoint, reaches status:'confirmed' without
// paymentStatus ever becoming 'confirmed'/'self_confirmed'/'paid' (adminCommandService's
// markOrderReady FIX-MARK-READY-GUARD comment documents both paths). Before this fix,
// resolveActiveOrder required paymentStatus to be payment-verified AND status:'confirmed',
// so these orders — despite matching the "active order" DB query — fell through every
// priority branch and resolved to NO_ACTIVE_ORDER, silently disabling interception for a
// real in-progress order.
test('resolveActiveOrder: a confirmed cash order (paymentStatus unpaid) still intercepts as PAYMENT_VERIFIED', async () => {
  const fakeOrder = {
    _id: 'jkl012',
    customerPhone: '2207000003',
    tenantId: 'tenant1',
    status: 'confirmed',
    paymentStatus: 'unpaid', // cash / AWAIT_ADMIN_CONFIRM order — never touches 'confirmed'
    item: 'Suya Platter',
    quantity: 1,
    shortId: 'ORD126',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await withStubbedOrderFind([fakeOrder], async () => {
    const result = await resolveActiveOrder('2207000003', 'tenant1', { payment: { currency: 'D' } }, null);
    assert.equal(result.state, ACTIVE_ORDER_STATES.PAYMENT_VERIFIED, `expected PAYMENT_VERIFIED, got ${result.state}`);
    assert.equal(result.shouldIntercept, true, 'a confirmed cash order must still intercept');
  });
});
