// tests/negationGuard.test.mjs
//
// Direct unit coverage for core/intents/negationGuard.js's analyzeMessage().
//
// [AUDIT-FIX-NEGATION-TEST] This module was fully built and wired into
// intentEngine.js's detectIntent() (steps 4.2/4.4/4.6) but had ZERO direct
// test coverage — neither this module's own regex behaviour nor its signal
// shape was ever asserted anywhere. Given it now sits on the live routing
// path (complaint/cancellation/correction guards run before the AI-classify
// step for every pre-flow message, and _detectMidFlowCancellationRequest in
// webhookController.js reuses it directly for in-flow messages), an
// unnoticed regression here would silently misroute real customer messages.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage } from '../core/intents/negationGuard.js';

test('analyzeMessage: empty/whitespace input returns all-false, never throws', () => {
  for (const input of ['', '   ', undefined, null]) {
    const result = analyzeMessage(input);
    assert.deepEqual(result, {
      cancelled: false, rejected: false, negated: false, confirmed: false,
      correction: false, hesitant: false, complaint: false,
    });
  }
});

test('analyzeMessage: cancellation phrases are detected', () => {
  const phrases = [
    'cancel',
    'please cancel my order',
    'forget it',
    'never mind',
    "don't continue",
    'scrap this',
    "i don't want it anymore",
  ];
  for (const p of phrases) {
    assert.equal(analyzeMessage(p).cancelled, true, `expected cancelled:true for "${p}"`);
  }
});

test('analyzeMessage: rejection phrases are detected without being cancellation', () => {
  const phrases = ['no thanks', 'not now', 'not interested', 'rather not'];
  for (const p of phrases) {
    const r = analyzeMessage(p);
    assert.equal(r.rejected, true, `expected rejected:true for "${p}"`);
  }
});

test('analyzeMessage: negation phrases are detected', () => {
  const phrases = ["i don't want", "i'm not looking for the menu", "not interested in that", 'not right now'];
  for (const p of phrases) {
    assert.equal(analyzeMessage(p).negated, true, `expected negated:true for "${p}"`);
  }
});

test('analyzeMessage: plain confirmations register as confirmed', () => {
  for (const p of ['yes', 'yeah', 'sure', 'ok', 'that\'s right', 'go ahead']) {
    assert.equal(analyzeMessage(p).confirmed, true, `expected confirmed:true for "${p}"`);
  }
});

test('analyzeMessage: a confirmation word inside a negated/rejecting sentence must NOT register as confirmed', () => {
  // "yes but actually no" and similar hedge-then-reject phrasing must never
  // read as a clean confirmation just because "yes" appears somewhere in it.
  const negatedConfirm = analyzeMessage('yes but actually i dont want it anymore');
  assert.equal(negatedConfirm.confirmed, false);

  const rejectedConfirm = analyzeMessage('sure, actually no thanks');
  assert.equal(rejectedConfirm.confirmed, false);
});

test('analyzeMessage: correction phrases are detected', () => {
  for (const p of ['actually, make that three', 'sorry, I meant medium', 'wait, no', 'scratch that']) {
    assert.equal(analyzeMessage(p).correction, true, `expected correction:true for "${p}"`);
  }
});

test('analyzeMessage: hesitation phrases are detected and do not imply cancellation', () => {
  for (const p of ['maybe later', 'just browsing', 'not sure yet', 'just looking']) {
    const r = analyzeMessage(p);
    assert.equal(r.hesitant, true, `expected hesitant:true for "${p}"`);
  }
});

test('analyzeMessage: complaint phrases are detected', () => {
  const phrases = [
    'my order was wrong',
    'the food was cold',
    'i want a refund',
    'this is unacceptable',
    'can i speak to a manager',
  ];
  for (const p of phrases) {
    assert.equal(analyzeMessage(p).complaint, true, `expected complaint:true for "${p}"`);
  }
});

test('analyzeMessage: an ordinary flow answer (e.g. a quantity or a name) triggers no signal at all', () => {
  for (const p of ['3', 'two large pizzas', 'John Doe', '123 Independence Avenue']) {
    const r = analyzeMessage(p);
    assert.equal(r.cancelled, false, `unexpected cancelled:true for "${p}"`);
    assert.equal(r.rejected, false, `unexpected rejected:true for "${p}"`);
    assert.equal(r.negated, false, `unexpected negated:true for "${p}"`);
    assert.equal(r.correction, false, `unexpected correction:true for "${p}"`);
    assert.equal(r.complaint, false, `unexpected complaint:true for "${p}"`);
  }
});

test('analyzeMessage: complaint and cancellation are not mutually exclusive with each other\'s regexes', () => {
  // A message can legitimately read as both if it names a problem AND asks
  // to stop — callers (intentEngine.js) are responsible for prioritising
  // complaint over cancellation, analyzeMessage() itself just reports signals.
  const r = analyzeMessage('the food was cold, just cancel the order');
  assert.equal(r.complaint, true);
  assert.equal(r.cancelled, true);
});

// ── Wiring checks ────────────────────────────────────────────────────────────
// [AUDIT-FIX-NEGATION-WIRE] Confirms free-form cancellation phrasing mid-flow
// actually reaches analyzeMessage() via webhookController.js's CANCEL global-
// escape tier, not just via intentEngine.js's detectIntent() (which is never
// called for ordinary in-flow typed text — see _detectMidFlowCancellationRequest's
// own doc comment for the full explanation of the gap this closes).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

test('webhookController.js: imports analyzeMessage from negationGuard.js', () => {
  const src = read('../controllers/webhookController.js');
  assert.match(src, /import\s*\{\s*analyzeMessage\s*\}\s*from\s*'\.\.\/core\/intents\/negationGuard\.js'/);
});

test('webhookController.js: defines _detectMidFlowCancellationRequest using analyzeMessage(text).cancelled', () => {
  const src = read('../controllers/webhookController.js');
  const idx = src.indexOf('function _detectMidFlowCancellationRequest');
  assert.ok(idx > -1, 'expected _detectMidFlowCancellationRequest to be defined');
  const body = src.slice(idx, idx + 600);
  assert.match(body, /analyzeMessage\(text\)\.cancelled/);
  // Same free-text/date-time exclusions as the existing status/support detectors.
  assert.match(body, /MFQ_FREE_TEXT_STEPS\.has\(step\)/);
  assert.match(body, /MFQ_DATE_TIME_STEPS\.has\(step\)/);
});

test('webhookController.js: the CANCEL global-escape condition also checks _detectMidFlowCancellationRequest for typed text', () => {
  const src = read('../controllers/webhookController.js');
  const idx = src.indexOf("upperMsg === 'CANCEL' || upperMsg === 'CANCEL_BOOKING'");
  assert.ok(idx > -1, 'expected the CANCEL global-escape condition to still exist');
  const body = src.slice(idx, idx + 300);
  assert.match(body, /_detectMidFlowCancellationRequest\(messageText, session\)/);
  assert.match(body, /!isInteractive/, 'expected the free-form check to be gated to typed (non-interactive) messages only');
});

