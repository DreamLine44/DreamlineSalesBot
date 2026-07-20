// tests/instantQAAndMidFlowNegation.test.mjs
//
// Regression tests for two feature sets ported into the merged codebase from
// a parallel branch (whatsales-merged-v12) that had diverged from this one's
// base: neither was present here before this merge, and neither had prior
// test coverage of its own, so this file exists specifically to keep them
// from being silently dropped again in a future merge — the exact failure
// mode PROJECT_POLICIES.md was created to guard against.
//
// [FEAT-INSTANT-QA-1/2/3] — A typed question is answered immediately, any
// time, with or without the "❓ Ask a Question" button tap:
//   - core/intents/intentEngine.js — step 4.6, pre-flow direct-question
//     detection (DIRECT_QUESTION_KEYWORDS / DIRECT_QUESTION_RE).
//   - core/conversations/moduleRouter.js — ENQUIRY/QUESTION fallback cases
//     answer immediately via AI when `message` already contains the question,
//     instead of discarding it and asking the customer to type it again.
//   - controllers/webhookController.js — step 15.1c mid-flow question
//     intercept answers immediately (data-backed lookup, else AI) instead of
//     first asking "pause or continue?".
//
// [MERGE-NEGATION-2] — Complaint/cancellation must escape an active flow, not
// just the pre-flow router:
//   - controllers/webhookController.js — _detectMidFlowSupportRequest() ORs
//     in analyzeMessage(text).complaint; a free-form cancellation escape block
//     (analyzeMessage(messageText).cancelled) runs before the exact-match
//     CANCEL/CANCEL_BOOKING/CANCEL_ORDER check.
//
// webhookController.js can't be imported directly in this sandbox (it pulls
// in mongoose-backed models at module scope), so those pieces are verified
// via source-text assertions — the same technique already used by
// midFlowOrderBookingSwitch.test.mjs / appointmentReminderQuestion.test.mjs
// for other webhookController.js private helpers. intentEngine.js and
// moduleRouter.js pieces that are safely import-able are tested live.
//
// Does NOT modify any existing source file's behavior for callers unrelated
// to these two features.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  detectIntent,
  DIRECT_QUESTION_KEYWORDS,
  DIRECT_QUESTION_RE,
} from '../core/intents/intentEngine.js';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── intentEngine.js — [FEAT-INSTANT-QA-2] pre-flow direct question ──────────

test('intentEngine.js: DIRECT_QUESTION_KEYWORDS / DIRECT_QUESTION_RE are exported', () => {
  assert.ok(DIRECT_QUESTION_KEYWORDS instanceof Set, 'DIRECT_QUESTION_KEYWORDS must be an exported Set');
  assert.ok(DIRECT_QUESTION_RE instanceof RegExp, 'DIRECT_QUESTION_RE must be an exported RegExp');
});

test('detectIntent: a natural pre-flow question routes to QUESTION, not FALLBACK/CLARIFY', async () => {
  const result = await detectIntent({
    message: 'do you guys deliver to Bakau on weekends?',
    isInteractive: false,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'QUESTION');
  assert.equal(result.source, 'direct-question');
});

test('detectIntent: a bare "?"-terminated message routes to QUESTION pre-flow', async () => {
  const result = await detectIntent({
    message: 'what time do you close?',
    isInteractive: false,
    business: { businessMode: 'RETAIL' },
  });
  assert.equal(result.action, 'QUESTION');
});

test('detectIntent: a genuine order request is never misread as a question, even though it starts with "can"', async () => {
  const result = await detectIntent({
    message: 'can i get 2 burgers',
    isInteractive: false,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'START_ORDER');
  assert.notEqual(result.action, 'QUESTION');
});

test('detectIntent: [FIX-QA-SUPPORT-PRECEDENCE] a human-escalation request is not forced to QUESTION', async () => {
  const result = await detectIntent({
    message: 'can you help me, I want to speak to someone',
    isInteractive: false,
    business: { businessMode: 'RESTAURANT' },
  });
  assert.notEqual(result.action, 'QUESTION');
});

test('detectIntent: mid-flow, a typed question does NOT get pre-empted by the pre-flow QUESTION step (owned by the active flow instead)', async () => {
  const result = await detectIntent({
    message: 'what time do you close?',
    isInteractive: false,
    session: { currentFlow: 'ORDER', step: 'SELECT_ITEM' },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.notEqual(result.action, 'QUESTION');
});

// ── moduleRouter.js — [FEAT-INSTANT-QA-3] ENQUIRY/QUESTION answer immediately ─

function routerCaseSource(caseName, nextCaseBoundary) {
  const src = read('../core/conversations/moduleRouter.js');
  const start = src.indexOf(`case '${caseName}':`);
  assert.ok(start !== -1, `case '${caseName}' not found in moduleRouter.js`);
  const end = src.indexOf(nextCaseBoundary, start);
  assert.ok(end !== -1, `Could not find the end boundary for case '${caseName}'`);
  return src.slice(start, end);
}

test("moduleRouter.js: ENQUIRY case answers immediately when `message` already contains the question", () => {
  const block = routerCaseSource('ENQUIRY', "case 'QUESTION':");
  assert.match(
    block,
    /message\s*&&\s*message\.trim\(\)\.length\s*>=\s*4/,
    'ENQUIRY fallback must check for existing message text before prompting "type your question below"'
  );
  assert.match(block, /getAIReply/, 'ENQUIRY fallback must answer via the AI provider, not just re-prompt');
});

test("moduleRouter.js: QUESTION case answers immediately when `message` already contains the question", () => {
  const block = routerCaseSource('QUESTION', '  }\n\n  // ── Module-registered actions');
  assert.match(
    block,
    /message\s*&&\s*message\.trim\(\)\.length\s*>=\s*4/,
    'QUESTION fallback must check for existing message text before prompting "type your question below"'
  );
  assert.match(block, /getAIReply/, 'QUESTION fallback must answer via the AI provider, not just re-prompt');
});

// ── webhookController.js — [FEAT-INSTANT-QA-1] mid-flow instant answer ──────

function webhookSource() {
  return read('../controllers/webhookController.js');
}

test('webhookController.js: mid-flow question intercept answers immediately (no "pause or continue?" prompt)', () => {
  const src = webhookSource();
  const start = src.indexOf('15.1c: Detect question intent in typed free-text mid-flow');
  assert.ok(start !== -1, 'Could not find the 15.1c mid-flow question intercept');
  const end = src.indexOf('[FSI] Detect mid-flow order/booking switch request', start);
  assert.ok(end !== -1, 'Could not find the end boundary of the 15.1c block');
  const block = src.slice(start, end);

  assert.match(block, /FEAT-INSTANT-QA-1/, 'block should be marked as the FEAT-INSTANT-QA-1 fix');
  assert.match(
    block,
    /postFlowAck:\s*'MFQ_RESUME'/,
    'must clear the flow and stash resume context via the MFQ_RESUME mechanism instead of leaving the flow "paused"'
  );
  assert.match(block, /getAIReply/, 'must answer via the AI provider (or a data-backed lookup) immediately');
  assert.doesNotMatch(
    block,
    /pause and get your question answered/i,
    'the old "pause or continue?" confirmation prompt must not be the active path'
  );
});

test('webhookController.js: [MERGE-NEGATION-2] mid-flow support detector also escapes on a deterministic complaint', () => {
  const src = webhookSource();
  const start = src.indexOf('function _detectMidFlowSupportRequest');
  assert.ok(start !== -1, 'Could not find _detectMidFlowSupportRequest');
  const end = src.indexOf('function _detectMidFlowStatusRequest', start);
  assert.ok(end !== -1, 'Could not find the end boundary of _detectMidFlowSupportRequest');
  const block = src.slice(start, end);

  assert.match(
    block,
    /analyzeMessage\(text\)\.complaint/,
    '_detectMidFlowSupportRequest must OR in analyzeMessage(text).complaint so free-form complaints escape mid-flow'
  );
});

test('webhookController.js: [MERGE-NEGATION-2] a free-form mid-flow cancellation escapes before the exact-match CANCEL check', () => {
  const src = webhookSource();
  const cancelIdx = src.indexOf("upperMsg === 'CANCEL' || upperMsg === 'CANCEL_BOOKING'");
  assert.ok(cancelIdx !== -1, 'Could not find the exact-match CANCEL check');

  const before = src.slice(Math.max(0, cancelIdx - 1600), cancelIdx);
  assert.match(
    before,
    /analyzeMessage\(messageText\)\.cancelled/,
    'a free-form cancellation check must run before the exact-match CANCEL/CANCEL_BOOKING/CANCEL_ORDER check'
  );
  assert.match(
    before,
    /MFQ_FREE_TEXT_STEPS\.has\(_cancelStep\)/,
    'the free-form cancellation escape must be gated off genuinely free-text steps, same as the SUPPORT escape'
  );
});

test('webhookController.js: negationGuard.js\'s analyzeMessage is imported', () => {
  const src = webhookSource();
  assert.match(
    src,
    /import\s*{\s*analyzeMessage\s*}\s*from\s*'\.\.\/core\/intents\/negationGuard\.js'/,
    'analyzeMessage must be imported for the mid-flow complaint/cancellation escapes to work'
  );
});
