// tests/postFlowExpressionTurns.test.mjs
//
// [PFH-9] Regression tests for the bounded post-flow expression turn budget.
// Active ORDER/BOOKING flows are never touched — this only governs replies
// after completeFlow() or admin-set postFlowAck states.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  EXPRESSION_TURN_BUDGET,
  EXPRESSION_MAX_CHARS,
  getExpressionTurnsLeft,
  isExpressionSentiment,
  detectExpressionSubType,
  shouldHandleAsPostFlowExpression,
  buildExpressionSessionContext,
  maybeAppendExpressionClosing,
  trimExpressionReply,
  formatExpressionReply,
  preserveExpressionTurns,
} from '../services/postFlowHandler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pfhSrc = readFileSync(join(__dirname, '../services/postFlowHandler.js'), 'utf8');
const flowSrc = readFileSync(join(__dirname, '../core/conversations/flowEngine.js'), 'utf8');

test('EXPRESSION_TURN_BUDGET is 2 (two human replies before normal routing)', () => {
  assert.equal(EXPRESSION_TURN_BUDGET, 2);
});

test('getExpressionTurnsLeft defaults to budget when unset', () => {
  assert.equal(getExpressionTurnsLeft({}), 2);
  assert.equal(getExpressionTurnsLeft(null), 2);
});

test('getExpressionTurnsLeft respects stored _exprTurnsLeft', () => {
  assert.equal(getExpressionTurnsLeft({ _exprTurnsLeft: 1 }), 1);
  assert.equal(getExpressionTurnsLeft({ _exprTurnsLeft: 0 }), 0);
});

test('isExpressionSentiment covers ack/compliment/complaint/question only', () => {
  assert.equal(isExpressionSentiment('ACK'), true);
  assert.equal(isExpressionSentiment('COMPLIMENT'), true);
  assert.equal(isExpressionSentiment('COMPLAINT'), true);
  assert.equal(isExpressionSentiment('QUESTION'), true);
  assert.equal(isExpressionSentiment('UNRELATED'), false);
});

test('maybeAppendExpressionClosing adds soft close on last budgeted turn', () => {
  const body = 'Thank you!';
  assert.equal(maybeAppendExpressionClosing(body, { _exprTurnsLeft: 2 }), body);
  assert.match(maybeAppendExpressionClosing(body, { _exprTurnsLeft: 1 }), /Message us anytime/);
});

test('EXPRESSION_MAX_CHARS keeps replies WhatsApp-short', () => {
  assert.equal(EXPRESSION_MAX_CHARS, 80);
});

test('trimExpressionReply caps long AI output', () => {
  const long = 'A'.repeat(300);
  assert.ok(trimExpressionReply(long).length <= EXPRESSION_MAX_CHARS + 1);
});

test('formatExpressionReply trims then closes', () => {
  const out = formatExpressionReply('Thanks so much!', { _exprTurnsLeft: 1 });
  assert.match(out, /Thanks so much!/);
  assert.match(out, /Message us anytime/);
});

test('postFlowHandler.js: expression paths use getPostFlowAIReply for short AI replies', () => {
  assert.match(pfhSrc, /getPostFlowAIReply/);
  assert.match(pfhSrc, /replyMode:\s*'expression'/);
});

test('preserveExpressionTurns carries budget forward', () => {
  const next = preserveExpressionTurns({ item: 'Pizza', _exprTurnsLeft: 1 });
  assert.equal(next.item, 'Pizza');
  assert.equal(next._exprTurnsLeft, 1);
});

test('postFlowHandler.js: legacy ORDER/BOOKING cases re-arm via finishExpressionTurn', () => {
  assert.match(pfhSrc, /finishExpressionTurn\(\{ from, tenantId, ackCtx, flowData \}\)/);
  assert.match(pfhSrc, /maybeAppendExpressionClosing/);
});

test('postFlowHandler.js: ORDER_CONFIRMED expression paths consume turns without flow buttons', () => {
  const start = pfhSrc.indexOf('async function handleOrderConfirmed');
  const end   = pfhSrc.indexOf('async function handleOrderRejected');
  const body  = pfhSrc.slice(start, end);
  assert.match(body, /finishExpressionTurn/);
  assert.match(body, /rearmPostFlowAck/);
  assert.doesNotMatch(body, /isCompliment[\s\S]{0,400}CANCEL_ORDER/s);
});

test('flowEngine.completeFlow seeds postFlowData._exprTurnsLeft', () => {
  assert.match(flowSrc, /postFlowData:\s*\{\s*_exprTurnsLeft:\s*EXPRESSION_TURN_BUDGET\s*\}/);
});

test('detectExpressionSubType: loyalty vs praise vs thanks', () => {
  assert.equal(detectExpressionSubType('Wow this is amazing', 'COMPLIMENT'), 'COMPLIMENT');
  assert.equal(detectExpressionSubType('I will always come to your service again', 'UNRELATED'), 'LOYALTY');
  assert.equal(detectExpressionSubType('thank you', 'ACK'), 'ACK');
});

test('shouldHandleAsPostFlowExpression: loyalty counts even when sentiment is UNRELATED', () => {
  assert.equal(
    shouldHandleAsPostFlowExpression('I will always come to your service again', 'UNRELATED'),
    true,
  );
});

test('buildExpressionSessionContext: tells AI not to repeat the previous reply', () => {
  const ctx = buildExpressionSessionContext({
    ackCtx: 'ORDER_COLLECTED',
    flowData: { item: 'Chura Gerteh', _lastExpressionReply: 'So glad you loved it!' },
    business: { name: 'YM Store' },
    subType: 'LOYALTY',
    lastBotReply: 'So glad you loved it!',
    lastCustomerMsg: 'Wow this is amazing',
  });
  assert.match(ctx, /MUST NOT repeat/i);
  assert.match(ctx, /LOYALTY/i);
});

test('postFlowHandler.js: ORDER_COLLECTED uses smart expression replies, not hardcoded loop text', () => {
  assert.doesNotMatch(pfhSrc, /You're so welcome\$\{custName\}! 😊 Glad you enjoyed it\./);
  assert.match(pfhSrc, /sendPostFlowExpression/);
  assert.match(pfhSrc, /buildPostFlowExpressionReply/);
});

test('groqProvider.js: expression replyMode limits tokens and adds short-reply prompt', () => {
  const groqSrc = readFileSync(join(__dirname, '../core/ai/providers/groqProvider.js'), 'utf8');
  assert.match(groqSrc, /replyMode === 'expression'/);
  assert.match(groqSrc, /maxTokens\s*=\s*isExpression \? 45 : 350/);
  assert.match(groqSrc, /NEVER repeat your previous reply/);
});
