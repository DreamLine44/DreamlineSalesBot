// tests/mutationIdempotencyAudit.test.mjs
//
// [AUDIT] This codebase has FOUR independent write paths for order/booking/human-mode
// state, each of which sends a customer-facing WhatsApp message as a side effect of
// the write:
//   1. adminCommandService.js   — WhatsApp admin command/button path (confirmPayment,
//      approveCashRequest, confirmBooking, resumeBot, etc.)
//   2. dashboardController.js   — per-tenant merchant dashboard REST API
//   3. adminRoutes.js           — superadmin/platform REST API
//   4. dashboardController.setHumanMode — a second, separate humanMode toggle
//
// (1) already had atomic double-tap guards (`status: { $ne: ... }` /
// `paymentStatus: { $ne: 'confirmed' }` etc., see [FIX-CMD-14] throughout that file).
// (2), (3), and the humanMode toggles did NOT — a retried or duplicated PATCH matched
// unconditionally and re-ran the customer-notification branch, sending a second
// "Order Confirmed!" / "Booking Confirmed!" / "bot is back" message for something
// that only happened once. Separately, (2)/(3) never synced `paymentStatus` when
// setting an order to 'confirmed'/'cancelled', which let them disagree with (1)'s
// paymentStatus-keyed guards — an order confirmed via dashboard could still be
// re-confirmed via a stale WhatsApp button, since (1) never saw paymentStatus flip.
//
// This file is DB-free (no mongoose harness wired up here — see paymentCashRequest.test.mjs
// for the same constraint), so like cashApprovalPrefixCollision.test.mjs it verifies the
// fix by asserting the actual source contains the guard, not by exercising the DB.

import test    from 'node:test';
import assert  from 'node:assert/strict';
import fs      from 'node:fs';
import path    from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardSrc = fs.readFileSync(path.join(__dirname, '../controllers/dashboardController.js'), 'utf8');
const adminRoutesSrc = fs.readFileSync(path.join(__dirname, '../routes/adminRoutes.js'), 'utf8');
const adminCmdSrc = fs.readFileSync(path.join(__dirname, '../services/admin/adminCommandService.js'), 'utf8');

function fnBody(src, signatureRe, label) {
  const m = src.match(signatureRe);
  assert.ok(m, `expected to find ${label}`);
  const start = m.index;
  // Find the matching closing brace for the function by tracking depth from the
  // first '{' after the signature — more robust than a bare '\n}' search, which
  // can stop at the first nested block's closing brace.
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

test('dashboardController.updateOrderStatus guards against re-writing the same status', () => {
  const body = fnBody(dashboardSrc, /export async function updateOrderStatus\(/, 'updateOrderStatus');
  assert.match(body, /status:\s*\{\s*\$ne:\s*status\s*\}/,
    'order-status PATCH must skip the write (and therefore the notification) when the order is already at the requested status');
});

test('dashboardController.updateOrderStatus syncs paymentStatus on confirm/cancel/reject', () => {
  const body = fnBody(dashboardSrc, /export async function updateOrderStatus\(/, 'updateOrderStatus');
  assert.match(body, /status === 'confirmed'[^}]*paymentStatus:\s*'confirmed'/s,
    'confirming an order via the dashboard must also set paymentStatus so adminCommandService\'s paymentStatus-keyed guards stay in sync');
  assert.match(body, /paymentStatus:\s*'cancelled'/,
    'cancelling/rejecting an order via the dashboard must also set paymentStatus');
});

test('dashboardController.updateBookingStatus guards against re-writing the same status', () => {
  const body = fnBody(dashboardSrc, /export async function updateBookingStatus\(/, 'updateBookingStatus');
  assert.match(body, /status:\s*\{\s*\$ne:\s*status\s*\}/,
    'booking-status PATCH must skip the write when the booking is already at the requested status');
});

test('dashboardController.setHumanMode only notifies when humanMode actually changed', () => {
  const body = fnBody(dashboardSrc, /export async function setHumanMode\(/, 'setHumanMode');
  assert.match(body, /wasHumanMode/,
    'setHumanMode must check the prior humanMode value before sending the "bot is back" notification');
});

test('adminRoutes order-status route guards against re-writing the same status and syncs paymentStatus', () => {
  const body = fnBody(adminRoutesSrc, /r\.patch\('\/orders\/:id\/status'/, 'PATCH /orders/:id/status');
  assert.match(body, /status:\s*\{\s*\$ne:\s*status\s*\}/);
  assert.match(body, /paymentStatus:\s*'confirmed'/);
  assert.match(body, /paymentStatus:\s*'cancelled'/);
});

test('adminRoutes booking-status route guards against re-writing the same status', () => {
  const body = fnBody(adminRoutesSrc, /r\.patch\('\/bookings\/:id\/status'/, 'PATCH /bookings/:id/status');
  assert.match(body, /status:\s*\{\s*\$ne:\s*status\s*\}/);
});

test('adminRoutes human-mode route only notifies when humanMode actually changed', () => {
  const body = fnBody(adminRoutesSrc, /r\.patch\('\/sessions\/:tenantId\/:phone\/human'/, 'PATCH /sessions/:tenantId/:phone/human');
  assert.match(body, /wasHumanMode/);
});

test('adminCommandService.resumeBot only notifies when humanMode was actually true before', () => {
  const start = adminCmdSrc.indexOf('async function resumeBot(');
  assert.notEqual(start, -1);
  const end = adminCmdSrc.indexOf('\n}', start);
  const body = adminCmdSrc.slice(start, end);
  assert.match(body, /wasHumanMode/);
});

test('approveCashRequest clears stale paymentProof/proofReceivedAt so isNoPaymentOrder is not corrupted by an earlier rejected proof', () => {
  const start = adminCmdSrc.indexOf('async function approveCashRequest(');
  assert.notEqual(start, -1);
  const end = adminCmdSrc.indexOf('\n}', start);
  const body = adminCmdSrc.slice(start, end);
  assert.match(body, /paymentProof:\s*null/);
  assert.match(body, /proofReceivedAt:\s*null/);
});
