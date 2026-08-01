// tests/postFlowExpressionWindow.test.mjs
//
// [AUDIT-FIX-EXPRESSION-WINDOW-1] / [AUDIT-FIX-EXPRESSION-WINDOW-2] Regression tests.
//
// Bug: after a customer completes an activity (places an order, requests a
// booking, asks "about us", follows up on a quote), services/postFlowHandler.js
// opens a one-turn "expression window" (session.postFlowAck) so their very next
// message gets a contextual reply instead of being shoved back into a generic
// menu. Most ackCtx cases in that file correctly branch on the customer's
// sentiment (isAck / isCompliment / isComplaint / isQuestion) — but the legacy
// 'ORDER' and 'BOOKING' cases (still used by the bakery order flow and the
// shared booking flow used across multiple verticals) ignored the message
// entirely and always replied with the same canned status line, even for a
// heartfelt "thank you so much!" or an angry "this is taking forever, I'm
// annoyed". Same gap, smaller scope, in 'QUOTE_FOLLOW' and 'ABOUT': a
// complaint fell into the generic branch and got an upbeat unrelated reply
// with no escalation path offered.
//
// This file does not import postFlowHandler.js directly (heavy import chain —
// mongoose models, dispatcher, AI providers — needs a live DB/env), so it
// documents the fix as a source-level contract check, consistent with
// declineDetection.test.mjs's approach for moduleRouter.js.
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../services/postFlowHandler.js'), 'utf8');

function caseBody(caseLabel, src) {
  const startMarker = `case '${caseLabel}':`;
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `case '${caseLabel}' should exist in postFlowHandler.js`);
  // Grab a generous window after the case label — enough to contain the
  // whole case body without needing a full brace parser.
  return src.slice(start, start + 2500);
}

test('legacy ORDER ackCtx branches on isComplaint/isCompliment/isQuestion, not just a canned reply', () => {
  const body = caseBody('ORDER', src);
  assert.ok(/isComplaint/.test(body), "case 'ORDER' should check isComplaint");
  assert.ok(/isCompliment/.test(body), "case 'ORDER' should check isCompliment");
  assert.ok(/isQuestion/.test(body), "case 'ORDER' should check isQuestion");
  assert.ok(/SUPPORT/.test(body), "case 'ORDER' complaint branch should offer a SUPPORT escalation");
});

test('legacy BOOKING ackCtx branches on isComplaint/isCompliment/isQuestion, not just a canned reply', () => {
  const body = caseBody('BOOKING', src);
  assert.ok(/isComplaint/.test(body), "case 'BOOKING' should check isComplaint");
  assert.ok(/isCompliment/.test(body), "case 'BOOKING' should check isCompliment");
  assert.ok(/isQuestion/.test(body), "case 'BOOKING' should check isQuestion");
  assert.ok(/SUPPORT/.test(body), "case 'BOOKING' complaint branch should offer a SUPPORT escalation");
});

test('QUOTE_FOLLOW ackCtx now has a dedicated complaint escalation branch', () => {
  const body = caseBody('QUOTE_FOLLOW', src);
  assert.ok(/isComplaint/.test(body), "case 'QUOTE_FOLLOW' should check isComplaint");
  assert.ok(/SUPPORT/.test(body), "case 'QUOTE_FOLLOW' complaint branch should offer a SUPPORT escalation");
});

test('ABOUT ackCtx now has a dedicated complaint escalation branch', () => {
  const body = caseBody('ABOUT', src);
  assert.ok(/isComplaint/.test(body), "case 'ABOUT' should check isComplaint");
  assert.ok(/SUPPORT/.test(body), "case 'ABOUT' complaint branch should offer a SUPPORT escalation");
});
