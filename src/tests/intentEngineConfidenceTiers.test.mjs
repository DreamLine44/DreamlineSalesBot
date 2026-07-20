// tests/intentEngineConfidenceTiers.test.mjs
//
// Pure, additive regression tests for the [PHASE-2] confidence-tier policy
// wired into core/intents/intentEngine.js's AI-classify step (step 7).
// Mocks the network boundary (global fetch, same one groqProvider.callGroq()
// uses) so the full detectIntent() -> classifyWithStructuredAI() ->
// classifyMessageStructured() path runs for real, without hitting the live Groq API.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, AI_EXECUTE_CONFIDENCE, AI_CLARIFY_CONFIDENCE } from '../core/intents/intentEngine.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY   = process.env.GROQ_API_KEY;

function mockGroqOnce(decisionObject) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(decisionObject) } }] }),
  });
}

function restore() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = ORIGINAL_KEY;
}

test('confidence tier constants match the documented policy (0.92 execute / 0.70 clarify)', () => {
  assert.equal(AI_EXECUTE_CONFIDENCE, 0.92);
  assert.equal(AI_CLARIFY_CONFIDENCE, 0.70);
});

test('detectIntent: confidence >= 0.92 executes the mapped action immediately', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  mockGroqOnce({ primaryIntent: 'ORDER', confidence: 0.97, negated: false, cancelled: false, reason: 'explicit order request' });
  try {
    // Deliberately avoids any [UPGRADE-DIRECT-INTENT] step-4.5 trigger word
    // (order/buy/book/etc.) so this exercises the step-7 AI path, not step 4.5.
    const result = await detectIntent({ message: 'please sort me out with the usual for tonight', business: { businessMode: 'RESTAURANT' } });
    assert.equal(result.action, 'START_ORDER');
    assert.equal(result.confidence, 'AI');
    assert.equal(result.source, 'ai');
  } finally {
    restore();
  }
});

test('detectIntent: confidence in 0.70-0.91 asks for clarification instead of guessing', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  mockGroqOnce({ primaryIntent: 'BOOKING', confidence: 0.80, negated: false, cancelled: false, reason: 'probably wants a table' });
  try {
    const result = await detectIntent({ message: 'thinking about maybe coming in for dinner sometime soon', business: { businessMode: 'RESTAURANT' } });
    assert.equal(result.action, 'CLARIFY');
    assert.equal(result.confidence, 'LOW');
    assert.equal(result.source, 'ai-clarify');
    assert.equal(result.suggestion, 'BOOKING');
  } finally {
    restore();
  }
});

test('detectIntent: confidence below 0.70 does not change workflow (falls through to fallback)', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  mockGroqOnce({ primaryIntent: 'ORDER', confidence: 0.40, negated: false, cancelled: false, reason: 'weak signal' });
  try {
    const result = await detectIntent({ message: 'not really sure what I am in the mood for today honestly', business: { businessMode: 'RESTAURANT' } });
    assert.notEqual(result.action, 'START_ORDER');
  } finally {
    restore();
  }
});

test('detectIntent: negated:true blocks action execution even at high confidence ("I don\'t want food")', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  mockGroqOnce({ primaryIntent: 'ORDER', confidence: 0.95, negated: true, cancelled: false, reason: 'customer explicitly declined ordering' });
  try {
    const result = await detectIntent({ message: 'I really do not want any food from here right now', business: { businessMode: 'RESTAURANT' } });
    assert.notEqual(result.action, 'START_ORDER');
    assert.notEqual(result.source, 'ai');
  } finally {
    restore();
  }
});

test('detectIntent: cancelled:true blocks action execution even at high confidence', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  mockGroqOnce({ primaryIntent: 'ORDER', confidence: 0.96, negated: false, cancelled: true, reason: 'customer wants to cancel' });
  try {
    const result = await detectIntent({ message: 'actually never mind forget the order completely please', business: { businessMode: 'RESTAURANT' } });
    assert.notEqual(result.action, 'START_ORDER');
  } finally {
    restore();
  }
});

test('detectIntent: UNKNOWN primaryIntent never executes an action regardless of confidence field', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  mockGroqOnce({ primaryIntent: 'UNKNOWN', confidence: 0.99, negated: false, cancelled: false, reason: 'unclear' });
  try {
    const result = await detectIntent({ message: 'purple elephants dance sideways under the moonlight tonight', business: { businessMode: 'RESTAURANT' } });
    assert.notEqual(result.source, 'ai');
    assert.notEqual(result.source, 'ai-clarify');
  } finally {
    restore();
  }
});

test('detectIntent: with no GROQ_API_KEY set, AI step safely no-ops (existing pre-AI behavior preserved)', async () => {
  delete process.env.GROQ_API_KEY;
  try {
    const result = await detectIntent({ message: 'purple elephants dance sideways under the moonlight tonight', business: { businessMode: 'RESTAURANT' } });
    assert.notEqual(result.source, 'ai');
    assert.notEqual(result.source, 'ai-clarify');
  } finally {
    restore();
  }
});
