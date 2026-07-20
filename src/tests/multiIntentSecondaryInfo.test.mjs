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
//
// [MERGE-PHASE-3] Superseded by [FEAT-STRUCTURED-AI-8]/[FEAT-STRUCTURED-AI-10]:
// the AI classifier itself now returns `businessInformationRequested` (answered
// deterministically via groqProvider.js#formatBusinessInfoAnswer — never a
// second AI call) and `secondaryIntents` (acknowledged via describeSecondaryIntents)
// directly on the structured decision object, rather than webhookController.js
// re-deriving them from a bare intent + isInformationalIntent() lookup. The
// three isInformationalIntent() unit tests above remain valid — the function
// is still exported for any other caller — but the wiring guards below now
// assert against the current mechanism instead of the superseded one.

test('webhookController.js: destructures businessInformationRequested and secondaryIntents from detectIntent()', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(src.includes('businessInformationRequested'), 'must destructure businessInformationRequested from detectIntent()');
  assert.ok(src.includes('secondaryIntents'), 'must destructure secondaryIntents from detectIntent()');
});

test('webhookController.js: answers business-info requests deterministically via formatBusinessInfoAnswer, never a second AI call', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(src.includes('formatBusinessInfoAnswer'), 'must use groqProvider.js#formatBusinessInfoAnswer for multi-intent info answers');
  assert.ok(src.includes('businessInformationRequested?.length'), 'must gate on a non-empty businessInformationRequested list');
});

test('webhookController.js: acknowledges secondary intents without dropping the primary reply', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(src.includes('describeSecondaryIntents'), 'must describe secondary intents via describeSecondaryIntents');
  assert.ok(src.includes('secondaryIntents?.length'), 'must gate the acknowledgment on a non-empty secondaryIntents list');
});

test('webhookController.js: business-info and secondary-intent notes are appended, not a replacement, of the existing reply', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(src.includes('appendBusinessInfoAnswer'), 'must append via appendBusinessInfoAnswer rather than overwriting reply');
});

test('webhookController.js: still dispatches nothing (no crash) when route() returns a falsy reply', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    src.includes('if (reply) {'),
    'dispatch must be guarded on a truthy reply so a falsy route() result never crashes the send loop'
  );
});
