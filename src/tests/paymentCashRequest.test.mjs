import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildPaymentInstructionsUI } from '../services/payment/paymentService.js';
import { buildPaymentInstructionsUI as buildPaymentInstructionsUIFromRoot } from '../services/paymentService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webhookSrc = readFileSync(join(__dirname, '../controllers/webhookController.js'), 'utf8');
const paymentServiceSrc = readFileSync(join(__dirname, '../services/payment/paymentService.js'), 'utf8');
const adminSrc = readFileSync(join(__dirname, '../services/admin/adminCommandService.js'), 'utf8');

const baseBusiness = { payment: { currency: 'D', requireProof: true, channels: [{ provider: 'Wave', accountNo: '0551234567' }] } };

test('buildPaymentInstructionsUI adds a cash-request button when requireProof is true', () => {
  const ui = buildPaymentInstructionsUI(baseBusiness, 1250, 'A1B2C3', 'DSB-0830-A1B2C3');
  assert.deepEqual(ui.buttons.map(button => ({ id: button.id, title: button.title })), [
    { id: 'REQUEST_CASH_PAYMENT', title: '💵 Pay with Cash' },
    { id: 'SUPPORT', title: '❓ Need Help' },
    { id: 'CANCEL', title: '❌ Cancel Order' },
  ]);
});

test('buildPaymentInstructionsUI keeps requireProof=false unchanged', () => {
  const ui = buildPaymentInstructionsUI({ payment: { currency: 'D', requireProof: false, channels: [{ provider: 'Wave', accountNo: '0551234567' }] } }, 1250, 'A1B2C3');
  assert.ok(!ui.buttons.some(button => button.id === 'REQUEST_CASH_PAYMENT'));
  assert.ok(ui.buttons.some(button => button.id === 'DONE'));
});

test('root paymentService export uses the same payment button order as the nested service', () => {
  const ui = buildPaymentInstructionsUIFromRoot(baseBusiness, 1250, 'A1B2C3', 'DSB-0830-A1B2C3');
  assert.deepEqual(ui.buttons.map(button => ({ id: button.id, title: button.title })), [
    { id: 'REQUEST_CASH_PAYMENT', title: '💵 Pay with Cash' },
    { id: 'SUPPORT', title: '❓ Need Help' },
    { id: 'CANCEL', title: '❌ Cancel Order' },
  ]);
});

test('PAYMENT_PROOF gate accepts the cash-request button id and admin approval prefixes', () => {
  assert.match(webhookSrc, /REQUEST_CASH_PAYMENT/);
  assert.match(webhookSrc, /PAYMENT_PROOF.*REQUEST_CASH_PAYMENT|REQUEST_CASH_PAYMENT.*PAYMENT_PROOF/);
  assert.match(adminSrc, /APPROVE_CASH_|REJECT_CASH_/);
  assert.match(paymentServiceSrc, /APPROVE_CASH_.*Approve Cash|Approve Cash.*APPROVE_CASH_/);
});

test('cash-request approval/rejection only operate on a pending request', () => {
  assert.match(adminSrc, /cashRequestStatus:\s*'pending'/);
  assert.match(adminSrc, /cashRequestStatus:\s*'rejected'|cashRequestStatus:\s*'approved'/);
});

test('legacy CASH_<shortId> buttons are accepted as cash-approval requests', () => {
  assert.match(adminSrc, /CASH_/);
  assert.match(adminSrc, /legacy.*CASH_|CASH_.*legacy/);
});
