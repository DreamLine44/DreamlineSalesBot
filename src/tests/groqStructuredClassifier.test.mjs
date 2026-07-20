// tests/groqStructuredClassifier.test.mjs
//
// Pure, additive regression tests for the [GROQ-STRUCT-1] structured decision
// classifier in core/ai/providers/groqProvider.js. Does NOT call the live Groq
// API (no network, no GROQ_API_KEY needed) — only exercises the pure prompt
// builder and parser functions, same pattern as tests/groqHours.test.mjs.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredClassifierPrompt,
  parseStructuredDecision,
  classifyIntentStructured,
} from '../core/ai/providers/groqProvider.js';

const VALID_INTENTS = ['ORDER', 'BOOKING', 'QUESTION', 'SUPPORT', 'GREETING', 'UNKNOWN'];

test('buildStructuredClassifierPrompt: includes only the provided valid intents, no invented ones', () => {
  const prompt = buildStructuredClassifierPrompt({ validIntents: VALID_INTENTS, mode: 'RESTAURANT' });
  for (const intent of VALID_INTENTS) {
    assert.ok(prompt.includes(intent), `prompt must list valid intent ${intent}`);
  }
  assert.ok(!prompt.includes('CAKE_CUSTOMIZATION'), 'prompt must not leak unrelated-mode intents');
});

test('buildStructuredClassifierPrompt: instructs JSON-only output, no markdown fences', () => {
  const prompt = buildStructuredClassifierPrompt({ validIntents: VALID_INTENTS, mode: 'RETAIL' });
  assert.ok(/JSON object/i.test(prompt));
  assert.ok(/no markdown fences/i.test(prompt) || /no prose/i.test(prompt));
});

test('buildStructuredClassifierPrompt: falls back to generic "a business" for unknown mode', () => {
  const prompt = buildStructuredClassifierPrompt({ validIntents: VALID_INTENTS, mode: 'NOT_A_REAL_MODE' });
  assert.ok(prompt.includes('a business'));
});

test('parseStructuredDecision: happy path parses a well-formed JSON response', () => {
  const raw = JSON.stringify({
    primaryIntent: 'ORDER',
    secondaryIntents: ['QUESTION'],
    confidence: 0.95,
    emotion: 'happy',
    urgency: 'normal',
    negated: false,
    confirmation: false,
    correction: false,
    cancellation: false,
    needsClarification: false,
    requiresHuman: false,
    reason: 'Customer explicitly asked to order.',
  });
  const result = parseStructuredDecision(raw, VALID_INTENTS);
  assert.equal(result.primaryIntent, 'ORDER');
  assert.deepEqual(result.secondaryIntents, ['QUESTION']);
  assert.equal(result.confidence, 0.95);
  assert.equal(result.emotion, 'happy');
});

test('parseStructuredDecision: strips ```json code fences some models add despite instructions', () => {
  const raw = '```json\n' + JSON.stringify({ primaryIntent: 'BOOKING', confidence: 0.9 }) + '\n```';
  const result = parseStructuredDecision(raw, VALID_INTENTS);
  assert.equal(result.primaryIntent, 'BOOKING');
  assert.equal(result.confidence, 0.9);
});

test('parseStructuredDecision: rejects an intent outside the provided valid list — never invents one', () => {
  const raw = JSON.stringify({ primaryIntent: 'MAKE_UP_AN_INTENT', confidence: 0.99 });
  const result = parseStructuredDecision(raw, VALID_INTENTS);
  assert.equal(result.primaryIntent, 'UNKNOWN');
});

test('parseStructuredDecision: filters secondaryIntents to the valid list and excludes the primary', () => {
  const raw = JSON.stringify({
    primaryIntent: 'ORDER',
    secondaryIntents: ['ORDER', 'QUESTION', 'NOT_REAL', 'SUPPORT'],
    confidence: 0.9,
  });
  const result = parseStructuredDecision(raw, VALID_INTENTS);
  assert.deepEqual(result.secondaryIntents, ['QUESTION', 'SUPPORT']);
});

test('parseStructuredDecision: clamps confidence to the 0-1 range', () => {
  assert.equal(parseStructuredDecision(JSON.stringify({ primaryIntent: 'ORDER', confidence: 5 }), VALID_INTENTS).confidence, 1);
  assert.equal(parseStructuredDecision(JSON.stringify({ primaryIntent: 'ORDER', confidence: -3 }), VALID_INTENTS).confidence, 0);
  assert.equal(parseStructuredDecision(JSON.stringify({ primaryIntent: 'ORDER', confidence: 'not-a-number' }), VALID_INTENTS).confidence, 0);
});

test('parseStructuredDecision: unknown emotion/urgency values fall back to safe defaults, not silently invented ones', () => {
  const raw = JSON.stringify({ primaryIntent: 'ORDER', confidence: 0.9, emotion: 'ecstatic-plus-ultra', urgency: 'extreme' });
  const result = parseStructuredDecision(raw, VALID_INTENTS);
  assert.equal(result.emotion, 'neutral');
  assert.equal(result.urgency, 'normal');
});

test('parseStructuredDecision: malformed JSON never throws — returns a safe all-false default', () => {
  const result = parseStructuredDecision('not json at all {{{', VALID_INTENTS);
  assert.equal(result.primaryIntent, 'UNKNOWN');
  assert.equal(result.confidence, 0);
  assert.equal(result.negated, false);
  assert.equal(result.cancellation, false);
});

test('parseStructuredDecision: empty/null input never throws — returns a safe default', () => {
  assert.equal(parseStructuredDecision(null, VALID_INTENTS).primaryIntent, 'UNKNOWN');
  assert.equal(parseStructuredDecision('', VALID_INTENTS).primaryIntent, 'UNKNOWN');
  assert.equal(parseStructuredDecision(undefined, VALID_INTENTS).primaryIntent, 'UNKNOWN');
});

test('parseStructuredDecision: non-boolean truthy values for flags are coerced to strict boolean', () => {
  // Guards against a model returning "true" (string) or 1 instead of a real boolean —
  // these must NOT be treated as true, since only a strict boolean is a real signal.
  const raw = JSON.stringify({ primaryIntent: 'ORDER', confidence: 0.9, negated: 'true', cancellation: 1 });
  const result = parseStructuredDecision(raw, VALID_INTENTS);
  assert.equal(result.negated, false);
  assert.equal(result.cancellation, false);
});

test('classifyIntentStructured: resolves to a safe default (no throw) when GROQ_API_KEY is unset', async () => {
  const originalKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const result = await classifyIntentStructured({ message: 'I want food', validIntents: VALID_INTENTS, mode: 'RESTAURANT' });
    assert.equal(result.primaryIntent, 'UNKNOWN');
    assert.equal(result.confidence, 0);
    assert.equal(result.reason, 'no_api_key');
  } finally {
    if (originalKey !== undefined) process.env.GROQ_API_KEY = originalKey;
  }
});
