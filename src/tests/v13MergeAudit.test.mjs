// tests/v13MergeAudit.test.mjs
//
// Pure, additive regression tests for the v13 merge/audit pass, which combined
// WhatSales_v12_audited_fixed.zip and WhatSales_v12_audited.zip and then extended
// the order/booking status-tracing system so a customer who lost their WhatsApp
// chat history / phone can still ask "do I have any active orders or bookings?"
// (or similar phrasing) and get a real, phone-scoped, session-independent answer.
//
// Covers:
//   - [AUDIT-FIX-TRACE-6] Mid-flow STATUS escape: a customer typing a status
//     question WHILE inside an active flow (booking, order, etc.) now escapes
//     the flow and gets a real answer, instead of the flow silently re-showing
//     its current prompt in a loop.
//   - [FIX-SUPPORT-ESCAPE] (ported from the sibling audit branch) Mid-flow
//     SUPPORT/admin escalation escape, same tier as CANCEL/SHOW_MENU.
//   - [FIX-SUPPORT-ADMIN] (ported) "admin"/"human" keywords recognised by the
//     top-level SUPPORT intent.
//   - [FIX-BAKERY-COLLECT] (ported) 'COLLECT' button ID accepted as valid.
//   - STATUS_CMD_RE / TRACK_ORDER keyword list expanded with "active order(s)"
//     / "active booking(s)" phrasing, and hoisted to module scope so the
//     no-flow fast path and the mid-flow escape share one definition.
//   - [AUDIT-FIX-TRACE-7] Order model gets a (tenantId, customerPhone,
//     createdAt) compound index matching the existing Booking model index.
//
// These are source-text guards (not live-DB tests), consistent with how the
// existing customerIsolation.test.mjs / patterns.test.mjs suites work in this
// codebase, since webhookController.js is not designed for isolated unit
// import without a live Mongo connection and Express app context.
//
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INTENT_PATTERNS } from '../core/intents/patterns.js';
import { detectIntent } from '../core/intents/intentEngine.js';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── STATUS_CMD_RE single source of truth in activityStatusService ─────────

test('activityStatusService.js: STATUS_CMD_RE is declared exactly once', () => {
  const svcSrc = read('../services/activity/activityStatusService.js');
  const matches = svcSrc.match(/export const STATUS_CMD_RE = /g) || [];
  assert.equal(matches.length, 1, 'STATUS_CMD_RE should live in activityStatusService as the single source of truth');
  const whSrc = read('../controllers/webhookController.js');
  assert.ok(whSrc.includes('isStatusCommand'), 'webhook should delegate to isStatusCommand()');
  assert.ok(!whSrc.includes('const STATUS_CMD_RE = '), 'webhook should not duplicate STATUS_CMD_RE');
});

test('activityStatusService.js: STATUS_CMD_RE recognises active order/booking phrasing', async () => {
  const { STATUS_CMD_RE } = await import('../services/activity/activityStatusService.js');
  const mustMatch = [
    'active order', 'active orders', 'active booking', 'active bookings',
    'do i have any active orders', 'do i have any active bookings',
    'do i have an active order', 'do i have an active booking',
    'my booking', 'my order', 'status',
  ];
  for (const phrase of mustMatch) {
    assert.ok(STATUS_CMD_RE.test(phrase), `STATUS_CMD_RE should match "${phrase}"`);
  }
});

// ── Mid-flow STATUS escape ─────────────────────────────────────────────────

test('webhookController.js: mid-flow STATUS escape is wired in before the MFQ question intercept', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    src.includes('function _detectMidFlowStatusRequest(text, session)'),
    'Missing _detectMidFlowStatusRequest helper'
  );
  assert.ok(
    src.includes('_detectMidFlowStatusRequest(messageText, session)'),
    'Mid-flow STATUS escape is defined but never called'
  );
  const escapeIndex = src.indexOf('_detectMidFlowStatusRequest(messageText, session)');
  const mfqIndex    = src.indexOf('15.1. [MFQ] Mid-Flow Question Intercept');
  assert.ok(
    escapeIndex > -1 && mfqIndex > -1 && escapeIndex < mfqIndex,
    'STATUS escape must run before the MFQ question intercept, at the same tier as ' +
    'the CANCEL/SHOW_MENU/SUPPORT global escapes'
  );
});

test('webhookController.js: mid-flow STATUS escape routes to TRACK_ORDER, not a dead end', () => {
  const src = read('../controllers/webhookController.js');
  const idx = src.indexOf('_detectMidFlowStatusRequest(messageText, session)');
  const slice = src.slice(idx, idx + 400);
  assert.ok(
    slice.includes("action: 'TRACK_ORDER'") && slice.includes("intent: 'TRACK_ORDER'"),
    'Mid-flow STATUS escape should route through the same TRACK_ORDER action handler ' +
    'used by the no-flow path, so both give the same phone-scoped, session-independent answer'
  );
});

test('_detectMidFlowStatusRequest never intercepts free-text or date/time flow steps', () => {
  const src = read('../controllers/webhookController.js');
  const fnMatch = src.match(/function _detectMidFlowStatusRequest\(text, session\) \{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, '_detectMidFlowStatusRequest function body not found');
  const body = fnMatch[1];
  assert.ok(body.includes('MFQ_FREE_TEXT_STEPS'), 'must exclude free-text steps');
  assert.ok(body.includes('MFQ_DATE_TIME_STEPS'), 'must exclude date/time steps');
  assert.ok(body.includes("'PAYMENT_PROOF'"), 'must exclude the PAYMENT_PROOF step');
});

// ── Mid-flow SUPPORT escape (ported fix) ───────────────────────────────────

test('webhookController.js: mid-flow SUPPORT escape is present and imports INTENT_PATTERNS', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    src.includes("import { INTENT_PATTERNS }") && src.includes("from '../core/intents/patterns.js'"),
    'INTENT_PATTERNS must be imported for the mid-flow SUPPORT escape to read SUPPORT keywords'
  );
  assert.ok(
    src.includes('function _detectMidFlowSupportRequest(text, session)'),
    'Missing _detectMidFlowSupportRequest helper'
  );
  assert.ok(
    src.includes("_detectMidFlowSupportRequest(messageText, session)"),
    'Mid-flow SUPPORT escape is defined but never called'
  );
});

test('detectIntent: "want to talk to the admin" resolves to SUPPORT via exact keyword match', async () => {
  const result = await detectIntent({
    message: 'want to talk to the admin', isInteractive: false, business: {},
  });
  assert.equal(result.intent, 'SUPPORT');
  assert.equal(result.source, 'keyword');
});

// ── SUPPORT admin/human keywords (ported fix) ──────────────────────────────

test('SUPPORT keyword list includes admin/human escalation phrasing', () => {
  const mustHave = [
    'admin', 'talk to admin', 'speak to admin', 'talk to a human',
    'human agent', 'talk to owner',
  ];
  for (const phrase of mustHave) {
    assert.ok(
      INTENT_PATTERNS.SUPPORT.includes(phrase),
      `SUPPORT is missing admin-escalation phrase '${phrase}'`
    );
  }
});

// ── Bakery COLLECT button (ported fix) ─────────────────────────────────────

test('webhookController.js: COLLECT is a valid step button ID (bakery fulfilment)', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    /'PICKUP'\s*,\s*'DELIVERY'\s*,\s*'COLLECT'/.test(src),
    "STEP_VALID_BUTTONS should include 'COLLECT' alongside 'PICKUP'/'DELIVERY'"
  );
});

// ── TRACK_ORDER keyword coverage for active order/booking phrasing ─────────

test('TRACK_ORDER keyword list includes "active order/booking" phrasing', () => {
  const mustHave = [
    'active order', 'active orders', 'active booking', 'active bookings',
    'do i have any active orders', 'do i have any active bookings',
    'any active orders', 'any active bookings',
  ];
  for (const phrase of mustHave) {
    assert.ok(
      INTENT_PATTERNS.TRACK_ORDER.includes(phrase),
      `TRACK_ORDER is missing '${phrase}' — a customer typing this outside any active ` +
      `flow would fall through to AI classification instead of the deterministic path.`
    );
  }
});

test('detectIntent: "do I have any active orders or bookings" resolves to TRACK_ORDER', async () => {
  // The full sentence "...or bookings" is intentionally NOT an exact keyword (the
  // matcher is whole-message only) — but the two clauses independently are, and a
  // customer is far more likely to type one of the short forms. This test pins the
  // short forms that matter most for the "lost my phone" scenario.
  const phrases = ['active orders', 'active bookings', 'do i have any active orders', 'do i have any active bookings'];
  for (const message of phrases) {
    const result = await detectIntent({
      message, isInteractive: false, business: {},
    });
    assert.equal(result.intent, 'TRACK_ORDER', `"${message}" should resolve to TRACK_ORDER, got ${result.intent}`);
    assert.equal(result.source, 'keyword', `"${message}" should resolve via exact keyword match, not AI`);
  }
});

// ── Order model index (session-independent lookup performance) ────────────

test('Order model: (tenantId, customerPhone, createdAt) compound index exists', () => {
  const src = read('../models/Order.js');
  assert.ok(
    /orderSchema\.index\(\s*\{\s*tenantId:\s*1,\s*customerPhone:\s*1,\s*createdAt:\s*-1\s*\}\s*\)/.test(src),
    'Order model should have a (tenantId, customerPhone, createdAt) index matching the ' +
    'existing Booking model index, since both are queried the same way for customer ' +
    'status lookups (activeOrderResolver, TRACK_ORDER action, quick STATUS command).'
  );
});

// ── No accidental regression: existing quick STATUS command still works from any state ─

test('webhookController.js: quick STATUS command (no-flow fast path) is still keyed on customerPhone, not session', () => {
  const src = read('../controllers/webhookController.js');
  const idx = src.indexOf('14.6. Quick STATUS command');
  assert.ok(idx > -1, 'Quick STATUS command section missing');
  const slice = src.slice(idx, idx + 3000);
  assert.ok(slice.includes('customerPhone: from'), 'Status lookup must be scoped by customerPhone: from');
  assert.ok(slice.includes('buildStatusReply'), 'Quick STATUS must delegate to buildStatusReply (DB-backed status service)');
});
