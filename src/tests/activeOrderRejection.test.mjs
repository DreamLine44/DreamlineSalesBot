import { test } from 'node:test';
import assert from 'node:assert/strict';
import Order from '../models/Order.js';
import { resolveActiveOrder, ACTIVE_ORDER_STATES } from '../services/order/activeOrderResolver.js';

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
