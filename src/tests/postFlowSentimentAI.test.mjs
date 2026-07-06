// tests/postFlowSentimentAI.test.mjs
//
// Regression test for [PFH-8]: postFlowHandler.js's sentiment classification
// (isAck / isCompliment / isComplaint / isQuestion) was previously pure regex
// with no way to handle negation ("not bad"), conflicting signals ("not bad,
// quite good actually" matching both COMPLIMENT_RE and COMPLAINT_RE), or
// zero-signal messages. classifyPostFlowSentiment() now:
//   - trusts a SINGLE confident regex match with zero added latency/cost
//   - falls back to groqProvider.classifyIntent() (the same lean one-word
//     classifier intentEngine.js already uses) when regexes give zero or
//     conflicting signals
//   - defaults to the safe 'UNRELATED' bucket if the AI call fails/errors
//
// This is a source-text guard (not a live-DB/live-AI test), consistent with
// how appointmentReminderQuestion.test.mjs / patterns.test.mjs guard other
// postFlowHandler.js fixes, since this module isn't designed for isolated
// unit import without a Mongo connection + AI provider wired up.
//
// Does NOT modify any existing source file.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

function source() {
  return read('../services/postFlowHandler.js');
}

function classifierFnSource() {
  const src = source();
  const start = src.indexOf('async function classifyPostFlowSentiment');
  assert.ok(start !== -1, 'classifyPostFlowSentiment() not found in postFlowHandler.js');
  const end = src.indexOf('\n/**', start + 1);
  assert.ok(end !== -1, 'Could not find the end boundary of classifyPostFlowSentiment()');
  return src.slice(start, end);
}

test('postFlowHandler.js: classifyPostFlowSentiment exists and defines all five sentiment labels', () => {
  const src = source();
  assert.ok(
    /const SENTIMENT_LABELS\s*=\s*\[\s*'ACK'\s*,\s*'COMPLIMENT'\s*,\s*'COMPLAINT'\s*,\s*'QUESTION'\s*,\s*'UNRELATED'\s*\]/.test(src),
    'SENTIMENT_LABELS must define exactly ACK, COMPLIMENT, COMPLAINT, QUESTION, UNRELATED'
  );
});

test('postFlowHandler.js: a single confident regex match skips the AI call (fast path preserved)', () => {
  const fn = classifierFnSource();
  assert.ok(
    /if\s*\(\s*matches\.length\s*===\s*1\s*\)\s*return\s*matches\[0\]/.test(fn),
    'Exactly-one-match case must return immediately without calling classifyIntent — ' +
    'this keeps the overwhelming majority of messages (a clean "thanks" or "terrible") instant and free'
  );
});

test('postFlowHandler.js: zero or conflicting regex matches trigger the AI tiebreaker', () => {
  const fn = classifierFnSource();
  assert.ok(
    /classifyIntent\s*\(\s*\{\s*message:\s*msg\s*,\s*validIntents:\s*SENTIMENT_LABELS\s*,\s*mode\s*\}\s*\)/.test(fn),
    'Ambiguous cases (0 or 2+ regex matches) must call groqProvider.classifyIntent with SENTIMENT_LABELS'
  );
});

test('postFlowHandler.js: AI tiebreaker reuses groqProvider.classifyIntent (same classifier as intentEngine.js), not a new AI-reply call', () => {
  const fn = classifierFnSource();
  assert.ok(
    /import\(['"]\.\.\/core\/ai\/providers\/groqProvider\.js['"]\)/.test(fn),
    'Must import classifyIntent from groqProvider.js — the existing lean one-word classifier — ' +
    'rather than inventing a second AI pathway or using getAIReply (which writes customer-facing wording)'
  );
});

test('postFlowHandler.js: AI failure/timeout falls back to the safe UNRELATED default, never throws', () => {
  const fn = classifierFnSource();
  assert.ok(
    /catch\s*\(err\)\s*\{[\s\S]*return\s*'UNRELATED'/.test(fn) ||
    (/catch\s*\(err\)/.test(fn) && /return\s*'UNRELATED'/.test(fn)),
    'classifyPostFlowSentiment must catch classifyIntent failures and default to UNRELATED, ' +
    'consistent with [PFH-2]\'s existing unknown-ackCtx safe-fallback pattern'
  );
});

test('postFlowHandler.js: isAck/isCompliment/isComplaint/isQuestion are now derived from one classifyPostFlowSentiment() call, not four independent regex tests', () => {
  const src = source();
  assert.ok(
    /const sentiment\s*=\s*await\s*classifyPostFlowSentiment\(msg,\s*business\)/.test(src),
    'Main classification block must call classifyPostFlowSentiment() once and derive all four booleans from its single result'
  );
  assert.ok(
    /const isAck\s*=\s*sentiment\s*===\s*'ACK'/.test(src) &&
    /const isCompliment\s*=\s*sentiment\s*===\s*'COMPLIMENT'/.test(src) &&
    /const isComplaint\s*=\s*sentiment\s*===\s*'COMPLAINT'/.test(src) &&
    /const isQuestion\s*=\s*sentiment\s*===\s*'QUESTION'/.test(src),
    'Each boolean must be derived from the single sentiment result, so they are mutually exclusive by construction'
  );
});
