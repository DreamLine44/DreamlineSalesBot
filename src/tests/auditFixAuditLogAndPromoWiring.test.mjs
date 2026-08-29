// tests/auditFixAuditLogAndPromoWiring.test.mjs
//
// Regression tests for two "implemented but unwired" bugs found during a
// systematic audit and fixed in the same pass:
//
//   [AUDIT-FIX-AUDITLOG-WIRE] AuditLog.js's schema comment has always
//   documented exactly which function should call auditService.logAudit()
//   for order_created, payment_submitted, payment_approved, and
//   payment_rejected — but logAudit() was never actually called from any
//   of them. The audit trail collection existed and was fully queryable,
//   it just always stayed empty.
//
//   [AUDIT-FIX-PROMO-SCHEMA] promoService.js's validatePromoCode() /
//   applyPromoUsage() read and write `business.promotions`, but
//   BusinessConfig had no `promotions` field in its schema at all — every
//   promo code silently failed validation forever, and saveOrder() never
//   even accepted a promoCode parameter to try one.
//
// These are source-text checks (not live-DB tests) because logAudit() and
// promoService require a live Mongoose connection to test behaviourally,
// matching the existing convention for wiring checks in this suite (see
// auditFixCatalogStartOrderWiring.test.mjs, navMeta3.test.mjs).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── auditService wiring ─────────────────────────────────────────────────────

test('orderService.js: saveOrder() imports and calls logAudit for order_created', () => {
  const src = readSource('../services/order/orderService.js');
  assert.ok(src.includes("from '../admin/auditService.js'"),
    'saveOrder() must import logAudit from auditService.js');
  assert.ok(src.includes("action: 'order_created'"),
    'saveOrder() must log the order_created audit action');
});

test('paymentService.js: receiveProof() imports and calls logAudit for payment_submitted', () => {
  const src = readSource('../services/paymentService.js');
  assert.ok(src.includes("from './admin/auditService.js'"),
    'receiveProof() must import logAudit from auditService.js');
  assert.ok(src.includes("action: 'payment_submitted'"),
    'receiveProof() must log the payment_submitted audit action');
});

test('adminCommandService.js: confirmPayment() imports and calls logAudit for payment_approved', () => {
  const src = readSource('../services/admin/adminCommandService.js');
  assert.ok(src.includes("from './auditService.js'"),
    'adminCommandService.js must import logAudit from auditService.js');
  assert.ok(src.includes("action: 'payment_approved'"),
    'confirmPayment() must log the payment_approved audit action');
});

test('adminCommandService.js: rejectPayment() calls logAudit for payment_rejected on BOTH the cash and retry-window branches', () => {
  const src = readSource('../services/admin/adminCommandService.js');
  const matches = src.match(/action: 'payment_rejected'/g) || [];
  assert.equal(matches.length, 2,
    'rejectPayment() has two distinct success paths (cash-order cancel, and non-cash retry-window) — both must log payment_rejected');
});

// ── promoService schema + wiring ────────────────────────────────────────────

test('BusinessConfig.js: has a promotions field backing promoService.js', () => {
  const src = readSource('../models/BusinessConfig.js');
  assert.ok(/promotions:\s*\[promotionSchema\]/.test(src),
    'BusinessConfig schema must define a promotions array field');
  // [AUDIT-FIX-PROMO-SCHEMA] Must be 'FIXED', matching the only place this
  // convention was previously written down (promoDiscountMath.test.mjs) —
  // NOT 'FLAT', which would silently fail schema validation on every
  // fixed-amount promotion.
  assert.ok(src.includes("enum: ['PERCENT', 'FIXED']"),
    "promotion type enum must be ['PERCENT', 'FIXED'] to match promoService.js's own convention");
});

test('orderService.js: saveOrder() accepts promoCode and calls validatePromoCode/applyPromoUsage', () => {
  const src = readSource('../services/order/orderService.js');
  assert.ok(src.includes("from './promoService.js'"),
    'saveOrder() must import validatePromoCode/applyPromoUsage from promoService.js');
  assert.ok(/saveOrder = async \(\{[^}]*promoCode[^}]*\}\)/.test(src),
    'saveOrder() must destructure promoCode from its params');
  assert.ok(src.includes('validatePromoCode(tenantId, promoCode'),
    'saveOrder() must call validatePromoCode when a promoCode is supplied');
  assert.ok(src.includes('applyPromoUsage(tenantId, appliedPromoCode)'),
    'saveOrder() must call applyPromoUsage after a valid promo is applied');
});

test('Order.js: has promoCode and discountAmount fields to persist what saveOrder() applies', () => {
  const src = readSource('../models/Order.js');
  assert.ok(/promoCode:\s*\{[^}]*default:\s*null/.test(src), 'Order schema must have a promoCode field');
  assert.ok(/discountAmount:\s*\{[^}]*default:\s*0/.test(src), 'Order schema must have a discountAmount field');
});
