// tests/deadFeatureWiringAudit.test.mjs
//
// Regression tests for [AUDIT-FIX-USAGE-WIRE-1/2] and [AUDIT-FIX-AUDITLOG-1].
//
// Bugs found and fixed: three fully-built services existed in the codebase
// with zero callers anywhere else in the app — each was pure dead code
// despite complete implementations and (in usageService.js's case) a
// docstring explicitly claiming it was already wired up:
//
//   - services/usageService.js's incrementTenantUsage() — docstring said
//     "called fire-and-forget from webhookController", but nothing called
//     it. Tenant.usage.messagesThisMonth was permanently stuck at 0.
//   - services/usageService.js's getTenantUsageSummary() — no dashboard
//     endpoint ever read it back, so even if usage had been tracked there
//     was no way to see it.
//   - services/auditService.js's logAudit() — AuditLog.js's action enum
//     (order_created, payment_approved, payment_rejected, ...) existed but
//     not a single audit entry was ever written by the app.
//
// Source-text guards (this codebase's established convention for wiring
// that's easiest to verify at the call-site level rather than by booting a
// live Mongo-backed Express app).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('webhookController.js: incrementTenantUsage is called on every verified inbound message', () => {
  const src = read('../controllers/webhookController.js');
  assert.match(src, /import\s*{\s*incrementTenantUsage\s*}\s*from\s*'\.\.\/services\/usageService\.js'/);
  assert.match(src, /incrementTenantUsage\(tenant\._id\)/, 'expected incrementTenantUsage to be called with the resolved tenant');
});

test('dashboardController.js: getDashboardOverview surfaces getTenantUsageSummary in its response', () => {
  const src = read('../controllers/dashboardController.js');
  assert.match(src, /import\s*{\s*getTenantUsageSummary\s*}\s*from\s*'\.\.\/services\/usageService\.js'/);
  const start = src.indexOf('export async function getDashboardOverview');
  const body  = src.slice(start, start + 1200);
  assert.match(body, /getTenantUsageSummary\(tenantId\)/, 'expected getDashboardOverview to call getTenantUsageSummary');
  assert.match(body, /usage,/, 'expected the usage summary to be included in the JSON response');
});

test('adminCommandService.js: confirmPayment and rejectPayment both write an audit log entry', () => {
  const src = read('../services/adminCommandService.js');
  assert.match(src, /import\s*{\s*logAudit\s*}\s*from\s*'\.\/auditService\.js'/);

  const confirmStart = src.indexOf('async function confirmPayment');
  const confirmEnd    = src.indexOf('async function rejectPayment');
  const confirmBody   = src.slice(confirmStart, confirmEnd);
  assert.match(confirmBody, /logAudit\(\{/, 'expected confirmPayment to call logAudit');
  assert.match(confirmBody, /action:\s*'payment_approved'/, 'expected confirmPayment to log a payment_approved event');

  const rejectBody = src.slice(confirmEnd);
  assert.match(rejectBody, /logAudit\(\{/, 'expected rejectPayment to call logAudit');
  assert.match(rejectBody, /action:\s*'payment_rejected'/, 'expected rejectPayment to log a payment_rejected event');
});

test('orderService.js: saveOrder writes an order_created audit log entry', () => {
  const src = read('../services/orderService.js');
  assert.match(src, /import\s*{\s*logAudit\s*}\s*from\s*'\.\/auditService\.js'/);
  assert.match(src, /action:\s*'order_created'/);
});

// ── [AUDIT-FIX-PROMO-SCHEMA-1] / [AUDIT-FIX-PROMO-WIRE-1] ───────────────────
//
// Bug found and fixed: services/promoService.js's own docstring stated it
// was "intentionally called from ONE place — orderService.saveOrder()", but
// nothing ever called validatePromoCode()/applyPromoUsage() from there (or
// anywhere else). Worse, BusinessConfig had no `promotions` field at all —
// even after wiring the call in, validatePromoCode() would have found
// `business.promotions` always undefined and rejected every code on every
// tenant. Order.js also had no promoCode/discountAmount fields to persist
// the result of a successful discount.

test('BusinessConfig.js: promotions field exists with the shape promoService.js expects', () => {
  const src = read('../models/BusinessConfig.js');
  assert.match(src, /promotions:\s*{/, 'expected a promotions field on BusinessConfig');
  for (const field of ['code:', 'value:', 'active:', 'expiresAt:', 'maxUses:', 'usedCount:', 'minOrderValue:']) {
    assert.ok(src.includes(field), `expected promotions sub-schema to include ${field}`);
  }
});

test('Order.js: promoCode and discountAmount fields exist', () => {
  const src = read('../models/Order.js');
  assert.match(src, /promoCode:\s*{\s*type:\s*String/);
  assert.match(src, /discountAmount:\s*{\s*type:\s*Number/);
});

test('orderService.js: saveOrder calls validatePromoCode and applyPromoUsage when a promoCode is supplied', () => {
  const src = read('../services/orderService.js');
  assert.match(src, /import\s*{\s*validatePromoCode,\s*applyPromoUsage\s*}\s*from\s*'\.\/promoService\.js'/);
  assert.match(src, /validatePromoCode\(tenantId, promoCode, resolvedTotal\)/);
  assert.match(src, /applyPromoUsage\(tenantId, appliedPromo\)/);
});

// ── [AUDIT-FIX-ANALYTICS-1] ──────────────────────────────────────────────────
//
// Bug found and fixed: analyticsService.js's trackFailedInteraction()
// (EVENT.FAILED_INTENT) was fully built but never called anywhere — a
// tenant had no visibility into which customer messages the bot genuinely
// failed to route.

test('moduleRouter.js: trackFailedInteraction is called on a genuine FALLBACK (not CLARIFY or off-topic chatter)', () => {
  const src = read('../core/conversations/moduleRouter.js');
  assert.match(src, /import\s*{\s*trackFailedInteraction\s*}\s*from\s*'\.\.\/analytics\/analyticsService\.js'/);

  const idx = src.indexOf("if (action === 'FALLBACK') {");
  assert.ok(idx > -1, 'expected a FALLBACK-only guard around the tracking call');
  const body = src.slice(idx, idx + 200);
  assert.match(body, /trackFailedInteraction\(session\.customerPhone, message, session\.tenantId\)/);
});
