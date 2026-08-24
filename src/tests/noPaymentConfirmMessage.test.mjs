// tests/noPaymentConfirmMessage.test.mjs
//
// [FIX-NOPAY-CONFIRM-1] Cash / no-payment businesses must never get "Payment
// Confirmed" wording when the admin taps Confirm Received — even if the
// customer's AWAIT_ADMIN_CONFIRM session expired (~30 min TTL).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isNoPaymentOrder,
  formatOrderItemsForMessage,
  formatOrderItemSummary,
} from '../services/orderService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminSrc = readFileSync(join(__dirname, '../services/adminCommandService.js'), 'utf8');

test('isNoPaymentOrder: payment disabled → order wording', () => {
  assert.equal(isNoPaymentOrder({ payment: { enabled: false } }, { paymentStatus: 'unpaid' }), true);
});

test('isNoPaymentOrder: unpaid with no proof → order wording even without session', () => {
  assert.equal(
    isNoPaymentOrder({ payment: { enabled: true } }, { paymentStatus: 'unpaid', paymentProof: null }, null),
    true,
  );
});

test('isNoPaymentOrder: proof received → payment wording path', () => {
  assert.equal(
    isNoPaymentOrder({ payment: { enabled: true } }, { paymentStatus: 'proof_received', paymentProof: 'url' }, null),
    false,
  );
});

test('formatOrderItemsForMessage: multi-item cart lists every line', () => {
  const block = formatOrderItemsForMessage({
    item: 'Attaya (Mint Tea Set)',
    quantity: 1,
    items: [
      { item: 'Attaya (Mint Tea Set)', quantity: 1, unitPrice: 40 },
      { item: 'Akara (Bean Fritters)', quantity: 1, unitPrice: 50 },
    ],
  }, { payment: { currency: 'GMD' } });
  assert.match(block, /Attaya/);
  assert.match(block, /Akara/);
});

test('formatOrderItemSummary: multi-item cart inline list', () => {
  const summary = formatOrderItemSummary({
    item: 'Attaya (Mint Tea Set)',
    quantity: 1,
    items: [
      { item: 'Attaya (Mint Tea Set)', quantity: 1 },
      { item: 'Akara (Bean Fritters)', quantity: 1 },
    ],
  });
  assert.match(summary, /Attaya/);
  assert.match(summary, /Akara/);
});

test('adminCommandService.confirmPayment uses isNoPaymentOrder, not session step alone', () => {
  assert.match(adminSrc, /isNoPaymentOrder\(business, order, custSession2\)/);
  assert.match(adminSrc, /formatOrderItemsForMessage\(order, business\)/);
  assert.doesNotMatch(
    adminSrc.slice(adminSrc.indexOf('async function confirmPayment'), adminSrc.indexOf('async function rejectPayment')),
    /isCashConfirm\s*=\s*custSession2\?\.step\s*===\s*'AWAIT_ADMIN_CONFIRM'/,
  );
});
