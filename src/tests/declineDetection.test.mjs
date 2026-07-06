// tests/declineDetection.test.mjs
//
// [FIX-DECLINE-1] Regression test.
//
// Bug: a plain decline like "No thanks" had no dedicated handling in the
// FALLBACK/CLARIFY case of core/conversations/moduleRouter.js. It fell
// through to the AI as an unrecognized message, which replied with a generic
// "Welcome to X — is there something I can help you with?" and re-showed the
// exact same 3 buttons the customer had just declined — reading as if the
// bot hadn't understood them, and resetting the conversation instead of
// acknowledging the decline.
//
// This test does NOT import moduleRouter.js directly, because that module
// has a heavy import chain (mongoose models, dispatcher, AI providers) that
// needs a live DB/env to construct. Instead it pins the DECLINE_RE pattern
// as a documented contract — this exact regex lives inline in the
// FALLBACK/CLARIFY case in moduleRouter.js. If that regex changes, a human
// should consciously update this test alongside it.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

// Kept in sync with core/conversations/moduleRouter.js's FALLBACK case.
const DECLINE_RE = /^(no+\s*(thanks?|thank\s*you)?|nah+|nope+|not\s*(now|really|interested|today)|i'?m\s*good|im\s*good|all\s*good|maybe\s*later|not\s*at\s*the\s*moment)[.!]?$/i;

test('common decline phrases are recognized', () => {
  const declines = [
    'no thanks', 'No thanks', 'no thank you', 'nope', 'nah', 'not now',
    'not really', 'not interested', 'not today', "i'm good", 'im good',
    'all good', 'maybe later', 'not at the moment', 'no.', 'no!',
  ];
  for (const phrase of declines) {
    assert.ok(DECLINE_RE.test(phrase.toLowerCase().trim()), `"${phrase}" should be recognized as a decline`);
  }
});

test('a bare full sentence is NOT swallowed as a decline (only short declines match)', () => {
  const notDeclines = [
    'no i want to cancel my order',
    'not now, ask me in an hour please',
    'nope give me the menu instead',
    'I want to order chicken',
    'yes please',
  ];
  for (const phrase of notDeclines) {
    assert.ok(!DECLINE_RE.test(phrase.toLowerCase().trim()), `"${phrase}" should NOT be swallowed as a plain decline`);
  }
});
