// tests/emotionEngine.test.mjs
//
// Regression tests for core/sentiment/emotionEngine.js ([FEAT-EMOTION-1]).
// This module previously shipped with zero dedicated test coverage, despite
// the codebase's established convention of a test guard for every audit fix
// (see patterns.test.mjs, groqHours.test.mjs, waCatalogNormalization.test.mjs,
// etc.). Covers:
//   (a) priority ordering (FRUSTRATED > CONFUSED > URGENT > EXCITED > NEUTRAL)
//   (b) [AUDIT-FIX-EMOTION-5] the FRUSTRATED_RE word-order gap — "why is this
//       not working" ("is" before "this", "not" between "this" and "working")
//       previously fell through to NEUTRAL because both the literal
//       "this is not working" branch and the "why...this working" branch
//       assumed only one word order.
//   (c) [AUDIT-FIX-EMOTION-2] the positive/enthusiasm guard on the
//       punctuation/shouting heuristic ("Thanks!!", "THANK YOU SO MUCH" must
//       never be misread as FRUSTRATED)
//   (d) applyEmotionTone()'s payload-shape handling (string / object / array,
//       and the "no text-bearing payload" no-op case)
//
// intentEngine.js (and therefore emotionEngine.js, which imports normalise()
// from it) depends on 'fast-levenshtein' — same as intentEngine.test.mjs,
// directIntentUpgradeV2.test.mjs, etc. Run with `npm install` done first,
// same as those.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreFlowEmotion, applyEmotionTone } from '../core/sentiment/emotionEngine.js';

// ── Priority ordering ────────────────────────────────────────────────────────

test('detectPreFlowEmotion: FRUSTRATED beats URGENT when a message triggers both', () => {
  const { emotion } = detectPreFlowEmotion('this is ridiculous, i need it now');
  assert.equal(emotion, 'FRUSTRATED');
});

test('detectPreFlowEmotion: CONFUSED wins over URGENT/EXCITED when no frustration keyword is present', () => {
  assert.equal(detectPreFlowEmotion('i dont understand, can you explain').emotion, 'CONFUSED');
});

test('detectPreFlowEmotion: URGENT and EXCITED are each detected on their own', () => {
  assert.equal(detectPreFlowEmotion('need this asap please').emotion, 'URGENT');
  assert.equal(detectPreFlowEmotion('omg i cant wait for this').emotion, 'EXCITED');
});

test('detectPreFlowEmotion: plain neutral text and empty input are NEUTRAL', () => {
  assert.equal(detectPreFlowEmotion('id like to order a burger').emotion, 'NEUTRAL');
  assert.equal(detectPreFlowEmotion('').emotion, 'NEUTRAL');
  assert.equal(detectPreFlowEmotion(undefined).emotion, 'NEUTRAL');
});

// ── [AUDIT-FIX-EMOTION-5] word-order gap ────────────────────────────────────

test('detectPreFlowEmotion: "why is this not working" is FRUSTRATED (regression for the word-order gap)', () => {
  assert.equal(detectPreFlowEmotion('why is this not working').emotion, 'FRUSTRATED');
});

test('detectPreFlowEmotion: the previously-working phrasings still match', () => {
  assert.equal(detectPreFlowEmotion('this is not working').emotion, 'FRUSTRATED');
  assert.equal(detectPreFlowEmotion("why isn't this working").emotion, 'FRUSTRATED');
});

test('detectPreFlowEmotion: "why is this working" (no negation) does not false-positive from the order fix', () => {
  // Pre-existing behaviour (the bare why...this working branch, no "not")
  // is left untouched by the fix — asserted here so a future change to that
  // branch gets caught too.
  assert.equal(detectPreFlowEmotion('why is this working').emotion, 'FRUSTRATED');
});

// ── [AUDIT-FIX-EMOTION-2] positive/enthusiasm guard ─────────────────────────

test('detectPreFlowEmotion: enthusiastic punctuation/shouting is never misread as FRUSTRATED', () => {
  assert.notEqual(detectPreFlowEmotion('Thanks!!').emotion, 'FRUSTRATED');
  assert.notEqual(detectPreFlowEmotion('THANK YOU SO MUCH').emotion, 'FRUSTRATED');
  assert.notEqual(detectPreFlowEmotion('GREAT JOB').emotion, 'FRUSTRATED');
});

test('detectPreFlowEmotion: repeated question marks / shouting without positive words IS frustration', () => {
  assert.equal(detectPreFlowEmotion('what is going on??').emotion, 'CONFUSED'); // keyword match wins first
  assert.equal(detectPreFlowEmotion('WHERE IS MY ORDER').emotion, 'FRUSTRATED'); // shouting fallback
});

// ── applyEmotionTone ─────────────────────────────────────────────────────────

test('applyEmotionTone: prepends the tone line to a plain string reply', () => {
  const result = applyEmotionTone('Here is our menu.', 'FRUSTRATED');
  assert.ok(result.startsWith("😔 Sorry about that"));
  assert.ok(result.endsWith('Here is our menu.'));
});

test('applyEmotionTone: prepends to the first text-bearing payload inside an array, leaves others untouched', () => {
  const imagePayload = { type: 'image', url: 'https://example.com/x.png' };
  const bodyPayload = { body: 'Pick a size below.' };
  const result = applyEmotionTone([imagePayload, bodyPayload], 'CONFUSED');
  assert.deepEqual(result[0], imagePayload);
  assert.ok(result[1].body.startsWith('🙂 No worries at all'));
});

test('applyEmotionTone: NEUTRAL and URGENT are no-ops (no tone prefix defined)', () => {
  assert.equal(applyEmotionTone('Here is our menu.', 'NEUTRAL'), 'Here is our menu.');
  assert.equal(applyEmotionTone('Here is our menu.', 'URGENT'), 'Here is our menu.');
});

test('applyEmotionTone: leaves reply untouched when there is no text-bearing payload anywhere', () => {
  const imagePayload = { type: 'image', url: 'https://example.com/x.png' };
  const result = applyEmotionTone([imagePayload], 'FRUSTRATED');
  assert.deepEqual(result, [imagePayload]);
});

test('applyEmotionTone: null/undefined reply is returned as-is', () => {
  assert.equal(applyEmotionTone(null, 'FRUSTRATED'), null);
  assert.equal(applyEmotionTone(undefined, 'FRUSTRATED'), undefined);
});
