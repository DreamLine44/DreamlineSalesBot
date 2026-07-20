// tests/mergeFixesRegression.test.mjs
//
// Regression coverage for three gaps found while merging no-memory.zip into
// whatsales-backend-merged-v2.zip:
//
//   1. [MERGE-EMOTION-1] "angry" was a valid tone target (AI_EMOTION_TO_TONE
//      in webhookController.js) but not a valid emotion the AI was ever asked
//      or allowed to return — an angry customer's message silently classified
//      as 'neutral' emotion, never reaching the FRUSTRATED tone treatment.
//   2. [MERGE-LOOP-1] The FALLBACK/CLARIFY case in moduleRouter.js had no
//      escalation path — a customer whose messages kept missing intent
//      detection got the exact same generic reply forever. Added an
//      unclearStreak counter on Session that escalates to a real human
//      handoff (the SUPPORT action) after 3 consecutive misses.
//   3. Session.js had `postFlowExchangeCount` declared twice (a merge
//      artifact) — Mongoose silently accepts duplicate schema paths, so this
//      never threw, but is invalid and confusing schema definition.
//
// parseStructuredIntent() is tested directly (it's a pure, exported
// function). moduleRouter.js and Session.js are tested via source inspection,
// following the project's established pattern (see declineDetection.test.mjs)
// for modules with a heavy DB/env import chain that can't be constructed in
// a unit test.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStructuredIntent } from '../core/ai/providers/groqProvider.js';

const VALID_INTENTS = ['ORDER', 'BOOKING', 'QUESTION', 'SUPPORT'];

test('parseStructuredIntent: "angry" is accepted as a valid emotion', () => {
  const raw = JSON.stringify({
    primaryIntent: 'SUPPORT', confidence: 0.95, emotion: 'angry', urgency: 'high',
  });
  const result = parseStructuredIntent(raw, VALID_INTENTS);
  assert.equal(result.emotion, 'angry');
});

test('parseStructuredIntent: still falls back to neutral for a bogus/unknown emotion', () => {
  const raw = JSON.stringify({
    primaryIntent: 'QUESTION', confidence: 0.9, emotion: 'not-a-real-emotion',
  });
  const result = parseStructuredIntent(raw, VALID_INTENTS);
  assert.equal(result.emotion, 'neutral');
});

test('parseStructuredIntent: every other previously-supported emotion still parses unchanged', () => {
  for (const emotion of ['neutral', 'happy', 'frustrated', 'confused', 'excited', 'urgent', 'apologetic']) {
    const raw = JSON.stringify({ primaryIntent: 'QUESTION', confidence: 0.9, emotion });
    assert.equal(parseStructuredIntent(raw, VALID_INTENTS).emotion, emotion, `regression on "${emotion}"`);
  }
});

// ── Source-pinned checks ─────────────────────────────────────────────────

const webhookSrc = fs.readFileSync(new URL('../controllers/webhookController.js', import.meta.url), 'utf8');
const routerSrc   = fs.readFileSync(new URL('../core/conversations/moduleRouter.js', import.meta.url), 'utf8');
const promptSrc   = fs.readFileSync(new URL('../core/ai/providers/groqProvider.js', import.meta.url), 'utf8');
const sessionSrc  = fs.readFileSync(new URL('../models/Session.js', import.meta.url), 'utf8');

test('webhookController.js: AI_EMOTION_TO_TONE maps angry -> FRUSTRATED', () => {
  assert.match(webhookSrc, /angry:\s*'FRUSTRATED'/);
});

test('groqProvider.js: the classifier prompt vocabulary includes angry', () => {
  assert.match(promptSrc, /emotion.*angry.*confused/i);
});

test('moduleRouter.js: FALLBACK/CLARIFY tracks a streak and escalates to SUPPORT after repeated misses', () => {
  assert.match(routerSrc, /UNCLEAR_STREAK_LIMIT/);
  assert.match(routerSrc, /unclearStreak/);
  assert.match(routerSrc, /action:\s*'SUPPORT'/);
});

test('moduleRouter.js: the streak resets whenever a non-FALLBACK/CLARIFY action fires', () => {
  assert.match(routerSrc, /upper !== 'FALLBACK' && upper !== 'CLARIFY'/);
});

test('Session.js: postFlowExchangeCount is declared exactly once (no duplicate schema path)', () => {
  const matches = sessionSrc.match(/postFlowExchangeCount:\s*{\s*type:\s*Number/g) || [];
  assert.equal(matches.length, 1, 'postFlowExchangeCount should be defined exactly once');
});

test('Session.js: unclearStreak field exists for the loop-breaker counter', () => {
  assert.match(sessionSrc, /unclearStreak:\s*{\s*type:\s*Number,\s*default:\s*0\s*}/);
});
