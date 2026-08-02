// tests/statusTracing.test.mjs
//
// Pure, additive regression tests for the [AUDIT-FIX-TRACE-*] fixes:
//   - TRACK_ORDER keyword list (core/intents/patterns.js) now recognises
//     booking-status phrasing, not just order-status phrasing.
//   - The quick STATUS command fast path (controllers/webhookController.js,
//     step 14.6) now recognises booking-status phrasing AND checks Booking
//     records, not just Order records — so a customer who lost their chat
//     history / phone can ask about EITHER an active order or an active
//     booking, from any session state, keyed only on their phone number.
//
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectIntent } from '../core/intents/intentEngine.js';
import { INTENT_PATTERNS } from '../core/intents/patterns.js';

// ── TRACK_ORDER keyword coverage ──────────────────────────────────────────

test('TRACK_ORDER keyword list includes booking-status phrasing, not just order-status', () => {
  const mustHave = [
    'my booking', 'booking status', 'where is my booking', 'check my booking',
    'my appointment', 'check my appointment', 'my reservation',
  ];
  for (const phrase of mustHave) {
    assert.ok(
      INTENT_PATTERNS.TRACK_ORDER.includes(phrase),
      `TRACK_ORDER is missing booking-status phrase '${phrase}' — a customer typing this ` +
      `would skip the deterministic keyword match and depend entirely on AI classification.`
    );
  }
});

test('detectIntent: booking-status phrases resolve to TRACK_ORDER via exact keyword match (no AI needed)', async () => {
  const phrases = ['my booking', 'booking status', 'where is my booking', 'check my appointment', 'my reservation'];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, business: { businessMode: 'SALON' } });
    assert.equal(result.action, 'TRACK_ORDER', `'${message}' should resolve to TRACK_ORDER`);
    assert.equal(result.source, 'keyword', `'${message}' should match deterministically at the keyword step, not fall through to AI`);
  }
});

test('detectIntent: order-status phrases still resolve to TRACK_ORDER (unchanged behaviour)', async () => {
  const phrases = ['my order', 'track my order', 'order status', 'where is my order'];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, business: {} });
    assert.equal(result.action, 'TRACK_ORDER', `'${message}' should still resolve to TRACK_ORDER`);
  }
});

test('detectIntent: casual ordering phrases resolve to START_ORDER', async () => {
  for (const message of ["i'm hungry", 'im hungry', 'can i place an order']) {
    const result = await detectIntent({ message, isInteractive: false, business: { businessMode: 'RESTAURANT' } });
    assert.equal(result.action, 'START_ORDER', `'${message}' should resolve to START_ORDER`);
  }
});

// ── Quick STATUS command fast path (webhookController.js) ────────────────
//
// webhookController.js is a large, DB/dispatch-coupled controller not designed
// for unit import. Consistent with how patterns.test.mjs guards BUTTON_ID_MAP
// duplicates by re-parsing source text, this re-parses the STATUS_CMD_RE
// regex literal itself and exercises it directly — this is the exact object
// the live code path tests every incoming message against, so it's a faithful,
// non-fragile regression guard without requiring a Mongo connection.

function extractStatusCmdRegex() {
  const url = new URL('../controllers/webhookController.js', import.meta.url);
  const src = fs.readFileSync(url, 'utf8');
  const m = src.match(/const STATUS_CMD_RE = (\/\^\(.*\)\$\/i);/);
  assert.ok(m, 'Could not find STATUS_CMD_RE definition in webhookController.js — has it moved or been renamed?');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

test('STATUS_CMD_RE matches booking-status phrasing as well as order-status phrasing', () => {
  const re = extractStatusCmdRegex();
  const shouldMatch = [
    'status', 'my order', 'track my order', 'check order',
    'my booking', 'booking status', 'where is my booking', 'check my booking',
    'my appointment', 'check my appointment', 'my reservation', 'my activities',
  ];
  for (const phrase of shouldMatch) {
    assert.ok(re.test(phrase), `STATUS_CMD_RE should match '${phrase}'`);
  }
});

test('STATUS_CMD_RE does not match unrelated free text (stays a narrow, exact quick-command match)', () => {
  const re = extractStatusCmdRegex();
  const shouldNotMatch = [
    'hi there', 'i want to order a pizza', 'what is your address',
    'my booking was great thanks', // extra words — must not loosely match
  ];
  for (const phrase of shouldNotMatch) {
    assert.ok(!re.test(phrase), `STATUS_CMD_RE should NOT match '${phrase}'`);
  }
});

test('webhookController.js quick-STATUS handler uses activityStatusService', () => {
  const url = new URL('../controllers/webhookController.js', import.meta.url);
  const src = fs.readFileSync(url, 'utf8');
  const startIdx = src.indexOf('const STATUS_CMD_RE');
  const endIdx = src.indexOf('// ── 15. Active flow', startIdx);
  assert.ok(startIdx !== -1 && endIdx !== -1, 'Could not locate the quick-STATUS command block');
  const block = src.slice(startIdx, endIdx);
  assert.ok(block.includes('buildStatusReply'), 'Quick-STATUS handler should call buildStatusReply()');
  assert.ok(block.includes('activityStatusService'), 'Quick-STATUS handler should use activityStatusService');
});
