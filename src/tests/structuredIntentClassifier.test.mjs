// tests/structuredIntentClassifier.test.mjs
//
// Pure, additive regression tests for:
//   - core/intents/negationGuard.js               [FEAT-NEGATION-1]
//   - core/ai/providers/groqProvider.js#parseStructuredIntent [FEAT-STRUCTURED-AI-3]
//   - core/intents/intentEngine.js confidence-policy wiring    [FEAT-STRUCTURED-AI-4]
//
// Does NOT modify any existing source file.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage } from '../core/intents/negationGuard.js';
import { parseStructuredIntent } from '../core/ai/providers/groqProvider.js';
import { detectIntent } from '../core/intents/intentEngine.js';

// ── negationGuard.js ─────────────────────────────────────────────────────────

test('negationGuard: detects free-form cancellation phrasing not in CANCEL keyword list', () => {
  const g = analyzeMessage('please just forget it, I don\'t want to continue with this order');
  assert.equal(g.cancelled, true);
});

test('negationGuard: bare "stop" and "never mind" are cancellations', () => {
  assert.equal(analyzeMessage('stop').cancelled, true);
  assert.equal(analyzeMessage('never mind').cancelled, true);
});

test('negationGuard: soft rejection is not the same as cancellation', () => {
  const g = analyzeMessage('no thanks, maybe later');
  assert.equal(g.rejected, true);
  assert.equal(g.cancelled, false);
});

test('negationGuard: corrections are detected for in-flow reparsing', () => {
  assert.equal(analyzeMessage('Actually, make that three').correction, true);
  assert.equal(analyzeMessage('Sorry, I meant medium').correction, true);
  assert.equal(analyzeMessage('I would like to order a pizza').correction, false);
});

test('negationGuard: clean confirmation is not also flagged as negated/rejected', () => {
  const g = analyzeMessage('yes that is correct');
  assert.equal(g.confirmed, true);
  assert.equal(g.negated, false);
});

test('negationGuard: enthusiastic message is not misread as cancellation', () => {
  const g = analyzeMessage('I cant wait for my order, so excited!');
  assert.equal(g.cancelled, false);
});

test('negationGuard: empty input returns all-false, never throws', () => {
  const g = analyzeMessage('');
  assert.deepEqual(g, {
    cancelled: false, rejected: false, negated: false,
    confirmed: false, correction: false, hesitant: false, complaint: false,
  });
});

test('negationGuard: detects free-form complaints not in the bare-word SUPPORT list', () => {
  assert.equal(analyzeMessage('my order was wrong and the food arrived cold').complaint, true);
  assert.equal(analyzeMessage('I want a refund, this is unacceptable').complaint, true);
});

test('negationGuard: a normal order request is not a complaint', () => {
  assert.equal(analyzeMessage('I would like to order two burgers').complaint, false);
});

// ── groqProvider.js#buildSystemPrompt (language + urgency, spec Part A) ────

test('buildSystemPrompt: English-only by explicit product decision (multi-language deferred)', async () => {
  const { buildSystemPrompt } = await import('../core/ai/providers/groqProvider.js');
  const prompt = buildSystemPrompt({ business: { businessMode: 'RETAIL', name: 'Test Shop' }, intent: 'FALLBACK' });
  assert.match(prompt, /always reply in english/i);
});

test('buildSystemPrompt: urgent=true adds a brevity instruction; default is unaffected', async () => {
  const { buildSystemPrompt } = await import('../core/ai/providers/groqProvider.js');
  const normal = buildSystemPrompt({ business: { businessMode: 'RETAIL', name: 'Test Shop' }, intent: 'FALLBACK' });
  const urgent = buildSystemPrompt({ business: { businessMode: 'RETAIL', name: 'Test Shop' }, intent: 'FALLBACK', urgent: true });
  assert.doesNotMatch(normal, /indicated urgency/i);
  assert.match(urgent, /indicated urgency/i);
});



const VALID = ['ORDER', 'BOOKING', 'QUESTION', 'SUPPORT', 'UNKNOWN'];

test('parseStructuredIntent: parses a clean JSON response', () => {
  const raw = JSON.stringify({
    primaryIntent: 'order', confidence: 0.97, negated: false, cancelled: false,
    rejected: false, confirmed: false, correction: false, urgency: 'normal',
    emotion: 'neutral', needsClarification: false, clarificationQuestion: null,
    requiresHuman: false, secondaryIntents: [], businessInformationRequested: ['delivery'],
  });
  const result = parseStructuredIntent(raw, VALID);
  assert.equal(result.primaryIntent, 'ORDER');
  assert.equal(result.confidence, 0.97);
  assert.deepEqual(result.businessInformationRequested, ['delivery']);
});

test('parseStructuredIntent: strips ```json fences and trailing prose', () => {
  const raw = '```json\n{"primaryIntent":"QUESTION","confidence":0.8}\n```\nHope that helps!';
  const result = parseStructuredIntent(raw, VALID);
  assert.equal(result.primaryIntent, 'QUESTION');
  assert.equal(result.confidence, 0.8);
});

test('parseStructuredIntent: unknown/invalid primaryIntent degrades to UNKNOWN, never throws', () => {
  const result = parseStructuredIntent('{"primaryIntent":"DELETE_DATABASE","confidence":0.99}', VALID);
  assert.equal(result.primaryIntent, 'UNKNOWN');
});

test('parseStructuredIntent: confidence is clamped into [0,1]', () => {
  const result = parseStructuredIntent('{"primaryIntent":"ORDER","confidence":5}', VALID);
  assert.equal(result.confidence, 1);
});

test('parseStructuredIntent: malformed JSON returns null, caller falls back safely', () => {
  assert.equal(parseStructuredIntent('not json at all', VALID), null);
  assert.equal(parseStructuredIntent('', VALID), null);
  assert.equal(parseStructuredIntent(null, VALID), null);
});

// ── groqProvider.js#formatBusinessInfoAnswer (multi-intent secondary info) ──

test('formatBusinessInfoAnswer: answers a known delivery capability', async () => {
  const { formatBusinessInfoAnswer } = await import('../core/ai/providers/groqProvider.js');
  const answer = formatBusinessInfoAnswer({ flows: ['ORDER', 'DELIVERY'] }, ['delivery']);
  assert.match(answer, /delivery/i);
});

test('formatBusinessInfoAnswer: says nothing when delivery support is unknown (never invents)', async () => {
  const { formatBusinessInfoAnswer } = await import('../core/ai/providers/groqProvider.js');
  const answer = formatBusinessInfoAnswer({ flows: ['ORDER'] }, ['delivery']);
  assert.equal(answer, null);
});

test('formatBusinessInfoAnswer: answers location from the address field', async () => {
  const { formatBusinessInfoAnswer } = await import('../core/ai/providers/groqProvider.js');
  const answer = formatBusinessInfoAnswer({ address: '12 Kairaba Ave' }, ['location']);
  assert.match(answer, /Kairaba/);
});

test('formatBusinessInfoAnswer: returns null for an empty/unrecognised topic list', async () => {
  const { formatBusinessInfoAnswer } = await import('../core/ai/providers/groqProvider.js');
  assert.equal(formatBusinessInfoAnswer({ address: '12 Kairaba Ave' }, []), null);
  assert.equal(formatBusinessInfoAnswer({}, ['some_unknown_topic']), null);
});

// ── intentEngine.js integration (no network — deterministic layers only) ────

test('detectIntent: free-form cancellation routes to CANCEL without needing AI', async () => {
  const result = await detectIntent({
    message: 'please just forget it, I dont want to continue with this',
    isInteractive: false,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'CANCEL');
  assert.equal(result.source, 'negation-guard');
});

test('detectIntent: correction inside an active flow stays owned by the flow (CONTINUE_FLOW)', async () => {
  const result = await detectIntent({
    message: 'Actually, make that three please',
    isInteractive: false,
    session: { currentFlow: 'ORDER' },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'CONTINUE_FLOW');
  assert.equal(result.source, 'correction-guard');
});

test('detectIntent: same correction wording with NO active flow does not short-circuit', async () => {
  // No GROQ_API_KEY in this sandbox → step 7 returns fallback → step 8 fallback.
  const result = await detectIntent({
    message: 'Actually, make that three please',
    isInteractive: false,
    session: null,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.notEqual(result.source, 'correction-guard');
});

test('detectIntent: exact keyword match still wins over everything (regression guard)', async () => {
  const result = await detectIntent({
    message: 'book a table',
    isInteractive: false,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'START_BOOKING');
  assert.equal(result.source, 'keyword');
});

test('detectIntent: "actually, cancel it" mid-flow still cancels (not swallowed as a correction)', async () => {
  const result = await detectIntent({
    message: 'actually, cancel it',
    isInteractive: false,
    session: { currentFlow: 'ORDER' },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'CANCEL');
  assert.equal(result.source, 'negation-guard');
});

test('detectIntent: a complaint that starts with "actually" escalates to SUPPORT, not a correction', async () => {
  const result = await detectIntent({
    message: 'actually my order was wrong and the food was cold',
    isInteractive: false,
    session: { currentFlow: 'ORDER' },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'SUPPORT');
  assert.equal(result.source, 'complaint-guard');
});

test('detectIntent: a genuine correction (no cancel/complaint wording) still stays in-flow', async () => {
  const result = await detectIntent({
    message: 'actually, make that three please',
    isInteractive: false,
    session: { currentFlow: 'ORDER' },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'CONTINUE_FLOW');
  assert.equal(result.source, 'correction-guard');
});

test('detectIntent: free-form confirmation mid-flow stays owned by the flow (was previously dead code)', async () => {
  const result = await detectIntent({
    message: 'yeah sure that sounds good',
    isInteractive: false,
    session: { currentFlow: 'ORDER' },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'CONTINUE_FLOW');
  assert.equal(result.source, 'confirmation-guard');
});

test('detectIntent: "yes, cancel it" still cancels — cancellation wins over confirmation wording', async () => {
  const result = await detectIntent({
    message: 'yes, cancel it please',
    isInteractive: false,
    session: { currentFlow: 'ORDER' },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'CANCEL');
  assert.equal(result.source, 'negation-guard');
});

test('detectIntent: hesitant flag is surfaced on FALLBACK (was previously computed but discarded)', async () => {
  const result = await detectIntent({
    message: 'maybe I will think about it later',
    isInteractive: false,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.hesitant, true);
});

test('detectIntent: hesitant is false for a normal, decisive message', async () => {
  const result = await detectIntent({
    message: 'random unrelated chit chat message here',
    isInteractive: false,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.hesitant, false);
});

test('detectIntent: short input mid-flow still shortcuts to CONTINUE_FLOW (unchanged)', async () => {
  const result = await detectIntent({
    message: 'bok tbl',
    isInteractive: false,
    session: { currentFlow: 'ORDER' },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'CONTINUE_FLOW');
  assert.equal(result.source, 'short');
});

test('detectIntent: short input with NO active flow and no GROQ key still safely falls back (no crash)', async () => {
  const result = await detectIntent({
    message: 'xyzxyz',
    isInteractive: false,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'FALLBACK');
});
