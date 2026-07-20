// tests/classifyIntentConfidence.test.mjs
//
// [AUDIT-FIX-CLASSIFY-2] Regression tests.
//
// GAP: groqProvider.js's bare, lean classifyIntent() — used by
// postFlowHandler.js as an AI tiebreak when its regex-based sentiment
// detection is ambiguous — always returned a bare intent string with no
// confidence signal, and its prompt had no explicit negation/full-meaning
// instruction. That meant a shaky guess ("we already ate" being read as an
// ORDER-shaped word) had no way to be distinguished from a confident one.
//
// FIX: classifyIntent() now returns { intent, confidence } (HIGH/MEDIUM/LOW),
// and its prompt explicitly warns about negation/past-tense/context. Note
// this is a DIFFERENT, unrelated call site from intentEngine.js's own AI
// classification step — that step uses the much richer
// classifyMessageStructured() ([FEAT-STRUCTURED-AI]), which already has its
// own numeric 0–1 confidence score, negation/cancellation/rejection
// detection, and clarification handling. This fix only touches the lean,
// single-purpose classifier postFlowHandler.js borrows for sentiment
// tie-breaking — see structuredIntentClassifier.test.mjs and
// intentEngineConfidenceTiers.test.mjs for that separate system's coverage.
//
// groqProvider.classifyIntent() makes a real network call to Groq and is not
// safely unit-testable without a live GROQ_API_KEY (consistent with how the
// rest of this codebase treats AI-provider code). Its prompt/parsing changes
// are verified via source-text assertions; the always-available "no API key"
// fallback path is verified live.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyIntent } from '../core/ai/providers/groqProvider.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── groqProvider.js — prompt + parsing changes ───────────────────────────────

test('groqProvider.js: classifyIntent prompt explicitly warns about negation/full-meaning', () => {
  const src = readSource('../core/ai/providers/groqProvider.js');
  assert.match(
    src,
    /Understand the customer's full meaning, not just keywords[\s\S]{0,200}negation/i,
    'classifyIntent system prompt should explicitly instruct the model to account for negation/context, ' +
    'not just keyword presence.'
  );
});

test('groqProvider.js: classifyIntent asks for and parses an INTENT|CONFIDENCE reply', () => {
  const src = readSource('../core/ai/providers/groqProvider.js');
  assert.match(src, /INTENT\|CONFIDENCE/, 'System prompt should specify the "INTENT|CONFIDENCE" reply format');
  assert.match(
    src,
    /rawResult\.split\('\|'\)/,
    'classifyIntent should split the model reply on the pipe separator to extract intent + confidence'
  );
});

test('groqProvider.js: classifyIntent returns { intent, confidence } on every exit path (no bare strings)', () => {
  const src = readSource('../core/ai/providers/groqProvider.js');
  const fnStart = src.indexOf('export async function classifyIntent');
  assert.ok(fnStart !== -1, 'classifyIntent function not found');
  const fnEnd = src.indexOf('\n/**\n * classifyMessageStructured', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

  // Early-exit (no API key), success path, and catch-all error path must all
  // return the { intent, confidence } shape — never a bare string like the
  // old `return 'UNKNOWN';` / `return classified;`.
  assert.match(fnSrc, /return \{ intent: 'UNKNOWN', confidence: 'LOW' \};/g);
  assert.match(fnSrc, /return \{ intent: classified, confidence \};/);
  assert.doesNotMatch(
    fnSrc.replace(/return \{ intent:[^}]*\};/g, ''), // strip the valid object-returns first
    /return\s+(classified|'UNKNOWN'|confidence)\s*;/,
    'classifyIntent should not have any leftover bare-string return statements'
  );
});

test('groqProvider.js: confidence defaults to MEDIUM (not HIGH) when the tier token is missing/unparseable', () => {
  const src = readSource('../core/ai/providers/groqProvider.js');
  assert.match(
    src,
    /\['HIGH', 'MEDIUM', 'LOW'\]\.includes\(confToken\) \? confToken : 'MEDIUM'/,
    "An unparseable confidence token must default to 'MEDIUM', not 'HIGH' — per the " +
    '"don\'t inflate confidence" policy, an unlabeled classification should not auto-execute a workflow.'
  );
});

// ── Live behavior (no GROQ_API_KEY configured in this environment) ──────────

test('classifyIntent: with no AI provider configured, returns the safe { intent: UNKNOWN, confidence: LOW } shape (never throws, never returns a bare string)', async () => {
  if (process.env.GROQ_API_KEY) return; // this test targets the no-key fallback path specifically

  const result = await classifyIntent({
    message: 'something completely ambiguous',
    validIntents: ['ACK', 'COMPLIMENT', 'COMPLAINT', 'QUESTION'],
    mode: 'RESTAURANT',
  });

  assert.equal(typeof result, 'object');
  assert.equal(result.intent, 'UNKNOWN');
  assert.equal(result.confidence, 'LOW');
});
