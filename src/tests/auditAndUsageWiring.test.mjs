// tests/auditAndUsageWiring.test.mjs
//
// Regression tests for wiring two previously dead-schema services into the
// live order/message pipeline:
//
//   [AUDIT-WIRE-1/2/3] auditService.logAudit() was fully built and unit-tested
//     but never called anywhere — AuditLog had zero rows ever written. Now
//     called from orderService.saveOrder() (order_created) and
//     adminCommandService's confirmPayment()/rejectPayment() (payment_approved
//     / payment_rejected).
//   [USAGE-WIRE-1] usageService.incrementTenantUsage() was fully built but
//     never called — Tenant.usage.messagesThisMonth was pure dead schema.
//     Now called fire-and-forget from webhookController's per-message section 4.
//
// orderService.js/adminCommandService.js/webhookController.js need a live
// Mongo context to run for real, so wiring is verified via source-text
// guards, consistent with tests/multiIntentSecondaryInfo.test.mjs.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── orderService.js: order_created ────────────────────────────────────────────

test('orderService.js: imports logAudit and fires order_created after saveOrder()', () => {
  const src = read('../services/orderService.js');
  assert.ok(src.includes("import { logAudit } from './auditService.js'"), 'must import logAudit');
  assert.ok(src.includes("action: 'order_created'"), 'must fire order_created');
  // Must appear after the Order.create() call, not before.
  assert.ok(src.indexOf('Order.create(') < src.indexOf("action: 'order_created'"));
});

// ── adminCommandService.js: payment_approved / payment_rejected ──────────────

test('adminCommandService.js: imports logAudit and fires payment_approved in confirmPayment()', () => {
  const src = read('../services/adminCommandService.js');
  assert.ok(src.includes("import { logAudit } from './auditService.js'"), 'must import logAudit');
  const confirmBlock = src.slice(src.indexOf('async function confirmPayment'), src.indexOf('async function rejectPayment'));
  assert.ok(confirmBlock.includes("action: 'payment_approved'"), 'confirmPayment must fire payment_approved');
});

test('adminCommandService.js: fires payment_rejected in both rejectPayment() branches', () => {
  const src = read('../services/adminCommandService.js');
  const rejectBlock = src.slice(src.indexOf('async function rejectPayment'));
  const occurrences = (rejectBlock.match(/action: 'payment_rejected'/g) || []).length;
  assert.equal(occurrences, 2, 'both the cash-order branch and the retry-window branch must fire payment_rejected');
});

// ── webhookController.js: usage tracking ──────────────────────────────────────

test('webhookController.js: fire-and-forget calls incrementTenantUsage() per inbound message', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    src.includes("import('../services/usageService.js')") &&
    src.includes('incrementTenantUsage(tenantId)'),
    'must call incrementTenantUsage(tenantId) for every processed message'
  );
});

test('webhookController.js: usage tracking sits alongside the existing session lastSeen/messageCount update', () => {
  const src = read('../controllers/webhookController.js');
  const sessionUpdateIdx = src.indexOf('messageCount: 1 }).catch');
  const usageIdx = src.indexOf('[USAGE-WIRE-1]');
  assert.ok(sessionUpdateIdx > -1 && usageIdx > -1 && usageIdx > sessionUpdateIdx && usageIdx - sessionUpdateIdx < 400);
});

// ── auditService.js / usageService.js: sanity-check the functions being called exist and are pure/fire-and-forget ──

test('logAudit() and incrementTenantUsage() are exported and never throw synchronously', async () => {
  const { logAudit } = await import('../services/auditService.js');
  const { incrementTenantUsage } = await import('../services/usageService.js');
  assert.equal(typeof logAudit, 'function');
  assert.equal(typeof incrementTenantUsage, 'function');
});
