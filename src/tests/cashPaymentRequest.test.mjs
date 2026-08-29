// tests/cashPaymentRequest.test.mjs
//
// Additive regression tests for customer-initiated cash payment requests
// at the PAYMENT_PROOF step (requireProof=true tenants only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Order from '../models/Order.js';
import {
  buildPaymentInstructionsUI,
  isCashPaymentRequestText,
  requestCashPayment,
} from '../services/paymentService.js';
import { handleAdminButtonReply } from '../services/admin/adminCommandService.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const waveBusiness = {
  name: 'DreamLine Restaurant',
  payment: {
    enabled: true,
    requireProof: true,
    currency: 'GMD',
    channels: [{ provider: 'Wave', accountNo: '+2203532423', isDefault: true }],
  },
};

const selfConfirmBusiness = {
  ...waveBusiness,
  payment: { ...waveBusiness.payment, requireProof: false },
};

test('buildPaymentInstructionsUI: REQUEST_CASH button only when requireProof=true', () => {
  const withProof = buildPaymentInstructionsUI(waveBusiness, 150, 'ABC123', 'DSB-0824-ABC123');
  assert.equal(withProof.buttons.length, 3);
  assert.ok(withProof.buttons.some(b => b.id === 'REQUEST_CASH'));

  const noProof = buildPaymentInstructionsUI(selfConfirmBusiness, 150, 'ABC123', null);
  assert.equal(noProof.buttons.length, 3);
  assert.ok(!noProof.buttons.some(b => b.id === 'REQUEST_CASH'));
  assert.ok(noProof.buttons.some(b => b.id === 'DONE'));
});

test('webhookController STEP_VALID_BUTTONS includes REQUEST_CASH at PAYMENT_PROOF', () => {
  const src = readSource('../controllers/webhookController.js');
  const block = src.match(/PAYMENT_PROOF:\s*new Set\(\[[^\]]+\]\)/)?.[0] || '';
  assert.match(block, /REQUEST_CASH/);
});

test('isCashPaymentRequestText recognises PAYMENT_PROOF-scoped phrases', () => {
  assert.ok(isCashPaymentRequestText('can I pay cash?'));
  assert.ok(isCashPaymentRequestText("I can't pay with Wave"));
  assert.equal(isCashPaymentRequestText('hello'), false);
});

test('adminCommandService routes APPROVE_CASH_ before APPROVE_', () => {
  const src = readSource('../services/admin/adminCommandService.js');
  const block = src.slice(
    src.indexOf('handleAdminButtonReply = async'),
    src.indexOf('handleAdminTextCommand = async'),
  );
  const approveCashIdx = block.indexOf("startsWith('APPROVE_CASH_')");
  const approveIdx     = block.indexOf("startsWith('APPROVE_')");
  assert.ok(approveCashIdx !== -1 && approveIdx !== -1);
  assert.ok(approveCashIdx < approveIdx, 'APPROVE_CASH_ must be checked before APPROVE_');
});

test('requestCashPayment: creates pending cash request on unpaid order', async () => {
  const fakeOrder = {
    _id: 'o1',
    shortId: 'ABC123',
    item: 'Benachin',
    quantity: 1,
    totalPrice: 150,
    paymentReference: 'DSB-0824-ABC123',
  };
  let updateFilter = null;
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalFindOne = Order.findOne;
  Order.findOneAndUpdate = (filter, update, opts) => {
    updateFilter = filter;
    return {
      lean: () => Promise.resolve({ ...fakeOrder, cashRequestStatus: 'pending' }),
    };
  };
  Order.findOne = () => ({ sort: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) });

  try {
    const reply = await requestCashPayment('2207000000', 'tenant1', null, waveBusiness);
    assert.match(reply, /Cash payment request received/i);
    assert.equal(updateFilter.paymentStatus, 'unpaid');
    assert.ok(updateFilter.$or);
  } finally {
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    Order.findOne = originalFindOne;
  }
});

test('requestCashPayment: duplicate pending request returns wait message (atomic guard)', async () => {
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalFindOne = Order.findOne;
  Order.findOneAndUpdate = () => ({ lean: () => Promise.resolve(null) });
  Order.findOne = () => ({
    sort: () => ({
      select: () => ({
        lean: () => Promise.resolve({
          cashRequestStatus: 'pending',
          shortId: 'ABC123',
          paymentReference: 'DSB-0824-ABC123',
        }),
      }),
    }),
  });

  try {
    const reply = await requestCashPayment('2207000000', 'tenant1', null, waveBusiness);
    assert.match(reply, /already submitted/i);
  } finally {
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    Order.findOne = originalFindOne;
  }
});

test('approveCashRequest sets paymentMethod cash without confirming payment', async () => {
  let setPayload = null;
  const fakeOrder = {
    _id: 'o1',
    customerPhone: '2207000000',
    shortId: 'ABC123',
    item: 'Benachin',
    quantity: 1,
    totalPrice: 150,
    paymentReference: 'DSB-0824-ABC123',
    paymentStatus: 'unpaid',
  };
  const originalFindOneAndUpdate = Order.findOneAndUpdate;
  const originalFindOne = Order.findOne;
  Order.findOneAndUpdate = (filter, update) => {
    setPayload = update.$set;
    return {
      select: () => ({
        lean: () => Promise.resolve(fakeOrder),
      }),
    };
  };
  Order.findOne = () => ({ select: () => ({ lean: () => Promise.resolve(null) }) });

  try {
    await handleAdminButtonReply(
      'APPROVE_CASH_ABC123', 'tenant1', '+2209990000',
      { adminPhone: '+2209990000', whatsapp: {} },
      waveBusiness,
    );
    assert.equal(setPayload.paymentMethod, 'cash');
    assert.equal(setPayload.cashRequestStatus, 'approved');
    assert.equal(setPayload.paymentStatus, undefined);
  } finally {
    Order.findOneAndUpdate = originalFindOneAndUpdate;
    Order.findOne = originalFindOne;
  }
});

test('Order schema declares cashRequestStatus enum', () => {
  const src = readSource('../models/Order.js');
  assert.match(src, /cashRequestStatus/);
  assert.match(src, /enum:\s*\['pending',\s*'approved',\s*'rejected',\s*null\]/);
});
