// tests/multiIntentSecondaryInfo.test.mjs
//
// Pure, additive regression tests for [PHASE-3]: multi-intent secondary-info
// answering ("I want two burgers and can you tell me if you deliver?").
//
// isInformationalIntent() is a plain exported function — tested directly.
// webhookController.js's wiring is verified via source-text guards, consistent
// with how tests/v13MergeAudit.test.mjs already tests webhookController.js
// (the file needs a live Mongo/Express context to run for real).
//
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isInformationalIntent } from '../core/intents/intentEngine.js';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── isInformationalIntent() ──────────────────────────────────────────────────

test('isInformationalIntent: recognises business-info-seeking intents', () => {
  for (const intent of ['QUESTION', 'PAYMENT', 'SPEC_REQUEST', 'SKINCARE_ADVICE', 'WARRANTY_INFO', 'AVAILABILITY_CHECK']) {
    assert.equal(isInformationalIntent(intent), true, `${intent} should be informational`);
  }
});

test('isInformationalIntent: does not flag flow-starting intents as informational', () => {
  for (const intent of ['ORDER', 'BOOKING', 'CHECKOUT', 'CANCEL_ORDER', 'WALKIN', 'ADD_TO_CART']) {
    assert.equal(isInformationalIntent(intent), false, `${intent} should NOT be informational`);
  }
});

test('isInformationalIntent: unknown/undefined input is safely false, never throws', () => {
  assert.equal(isInformationalIntent('SOME_MADE_UP_INTENT'), false);
  assert.equal(isInformationalIntent(undefined), false);
  assert.equal(isInformationalIntent(null), false);
});

// ── webhookController.js wiring (source-text guards) ─────────────────────────

test('webhookController.js: imports isInformationalIntent from intentEngine.js', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    /import\s*\{[^}]*isInformationalIntent[^}]*\}\s*from\s*['"]\.\.\/core\/intents\/intentEngine\.js['"]/.test(src),
    'webhookController.js must import isInformationalIntent'
  );
});

test('webhookController.js: detectIntent destructure includes aiSignals', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    /const\s*\{\s*action,\s*intent,\s*confidence,\s*suggestion,\s*aiSignals\s*\}\s*=\s*await\s*detectIntent\(/.test(src),
    'the main detectIntent() call site must destructure aiSignals so secondary intents are available'
  );
});

test('webhookController.js: only answers a secondary intent when primary action is AI-sourced and not itself informational', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(src.includes("confidence === 'AI'"), 'must gate secondary-info answering on the AI-sourced primary action');
  assert.ok(src.includes('!isInformationalIntent(intent)'), 'must not duplicate-answer when the primary intent is already informational');
  assert.ok(src.includes('aiSignals?.secondaryIntents'), 'must check aiSignals.secondaryIntents for the multi-intent case');
});

test('webhookController.js: secondary info reply is appended as an additional payload, not a replacement', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    /payloads\s*=\s*\[\s*\.\.\.payloads,\s*\{\s*type:\s*'text',\s*body:\s*infoText\s*\}\s*\]/.test(src),
    'the secondary info answer must be appended to the existing payloads array (primary reply is never dropped)'
  );
});

test('webhookController.js: secondary-info AI call failure is caught, never lets the primary reply fail to dispatch', () => {
  const src = read('../controllers/webhookController.js');
  const idx = src.indexOf('Multi-intent secondary info reply failed');
  assert.ok(idx > -1, 'must log a warning if the secondary info call fails');
  const before = src.slice(0, idx);
  const lastTry = before.lastIndexOf('try {');
  assert.ok(lastTry > -1, 'the secondary info getAIReply call must be wrapped in try/catch');
});

test('webhookController.js: still dispatches nothing (no crash) when route() returns a falsy reply', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    /let payloads = reply \? \(Array\.isArray\(reply\) \? reply : \[reply\]\) : \[\];/.test(src),
    'payloads must safely default to an empty array when route() returns nothing'
  );
  assert.ok(/if \(payloads\.length\) \{/.test(src), 'dispatch loop must be guarded by payloads.length, not just truthiness of the original reply');
});
