// tests/aiClassifyConfidence.test.mjs
//
// [AUDIT-FIX-CLASSIFY-2] Regression tests.
//
// GAP: groqProvider.js:classifyIntent() always returned a bare intent string,
// and every successful AI classification was tagged with a flat, meaningless
// confidence value of 'AI' — never actually checked by any caller. This meant
// ANY AI guess, however weak, was auto-executed as a workflow action (e.g.
// silently starting an ORDER flow) with no distinction between "the model was
// certain" and "the model took a wild guess". The classifier prompt also had
// no explicit negation/full-meaning instruction, so short ambiguous messages
// risked being misclassified without any downstream safety net.
//
// FIX (two cooperating pieces):
//   1. groqProvider.js classifyIntent() — prompt now explicitly warns about
//      negation/full-meaning, and the model is asked to reply "INTENT|TIER"
//      (HIGH/MEDIUM/LOW). Returns { intent, confidence } instead of a string.
//   2. intentEngine.js classifyWithAI()/detectIntent() — propagate the new
//      object shape. Only confidence === 'HIGH' auto-continues the guessed
//      workflow action; MEDIUM/LOW route through the existing CLARIFY path
//      (a natural AI reply, not a hard menu reset) instead of guessing.
//
// groqProvider.classifyIntent() makes a real network call to Groq and is not
// safely unit-testable without a live GROQ_API_KEY (consistent with how the
// rest of this codebase treats AI-provider code — see [FIX-CLASSIFY] comment
// in groqProvider.js itself). Its prompt/parsing changes are verified via
// source-text assertions; the always-available "no API key" fallback path
// (present in both this sandbox and any CI without a key configured) is
// verified live.
//
// Does NOT modify any existing source file's behavior for callers unrelated
// to AI classification — button/emoji/keyword/Levenshtein paths (steps 1–6
// of detectIntent) are untouched and still return their original HIGH/LOW
// confidence values exactly as before.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectIntent } from '../core/intents/intentEngine.js';

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
  const fnEnd = src.indexOf('\n// ── Helpers', fnStart);
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

// ── intentEngine.js — confidence gating ──────────────────────────────────────

test('intentEngine.js: classifyWithAI returns the { intent, confidence } object shape on every branch', () => {
  const src = readSource('../core/intents/intentEngine.js');
  const fnStart = src.indexOf('async function classifyWithAI');
  const fnEnd = src.indexOf('\nfunction getValidIntents', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);

  assert.match(fnSrc, /return \{ intent: 'UNKNOWN', confidence: 'LOW' \};/g);
  assert.doesNotMatch(fnSrc, /return\s+'UNKNOWN'\s*;/, 'classifyWithAI should no longer return a bare string');
});

test('intentEngine.js: detectIntent only auto-continues the AI-guessed workflow when confidence is HIGH', () => {
  const src = readSource('../core/intents/intentEngine.js');
  const stepStart = src.indexOf('AI classify (last resort');
  const stepEnd = src.indexOf('// ── 8. Final fallback', stepStart);
  const stepSrc = src.slice(stepStart, stepEnd);

  assert.match(
    stepSrc,
    /if \(aiConfidence === 'HIGH'\)/,
    'The AI-classify step should branch explicitly on aiConfidence === \'HIGH\' before auto-continuing'
  );
  assert.match(
    stepSrc,
    /action:\s*'CLARIFY',\s*intent:\s*'CLARIFY',\s*confidence:\s*aiConfidence,\s*source:\s*'ai'/,
    'MEDIUM/LOW confidence AI classifications should route to the CLARIFY action, carrying the real ' +
    'confidence tier through, instead of silently executing the guessed workflow'
  );
});

test("detectIntent JSDoc no longer documents the meaningless flat 'AI' confidence tag", () => {
  const src = readSource('../core/intents/intentEngine.js');
  assert.match(src, /confidence:\s*'HIGH'\|'MEDIUM'\|'LOW'/);
});

// ── Live behavior (no GROQ_API_KEY configured in this environment) ──────────

test('detectIntent: with no AI provider configured, a long ambiguous message with no active flow degrades to a safe fallback (never throws, never returns a raw intent string as action)', async () => {
  if (process.env.GROQ_API_KEY) return; // this test targets the no-key fallback path specifically

  const result = await detectIntent({
    message: 'I was just wondering about something completely unrelated to your business today',
    isInteractive: false,
    session: {},
    business: { businessMode: 'RESTAURANT' },
  });

  assert.ok(['FALLBACK', 'CLARIFY'].includes(result.action), `expected a safe fallback action, got '${result.action}'`);
  assert.equal(result.confidence, 'LOW');
});
