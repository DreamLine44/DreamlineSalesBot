// tests/questionModeCartPreservation.test.mjs
//
// [AUDIT-FIX-QMODE-2] Regression tests for two related bugs found while
// auditing the "ask a question mid-ORDER" inline interception in
// modules/restaurant/flows/orderFlow.js:
//
//   1. That interception called persistQuestionSession() (services/
//      questionAnswerService.js), which unconditionally writes
//      currentFlow: 'QUESTION', step: 'AWAITING_QUESTION' — silently ending
//      the customer's active ORDER flow the moment they asked one quick menu
//      question, even though the surrounding comment explicitly says the
//      goal is to "preserve the order flow". Fixed: the interception now
//      only stashes _questionCtx and leaves currentFlow/step untouched.
//
//   2. core/conversations/flowEngine.js's startFlow() only preserved
//      data.cart when the flow being STARTED was 'ORDER' — so any path that
//      called startFlow('QUESTION', ...) while a cart already existed (e.g.
//      tapping the "❓ Ask Another" button shown after the interception
//      above) silently wiped the cart. Fixed: the cart is now also
//      preserved when starting the QUESTION flow.
//
// These are source-extraction tests (same technique already used by
// midFlowOrderBookingSwitch.test.mjs / statusTracing.test.mjs for
// webhookController.js) since flowEngine.js's startFlow()/advance() pull in
// a live Mongo-backed sessionService at module scope.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('flowEngine.js startFlow(): existingCart preservation covers both ORDER and QUESTION', () => {
  const src = read('../core/conversations/flowEngine.js');
  const match = src.match(/const existingCart = \(flowUpper === 'ORDER' \|\| flowUpper === 'QUESTION'\)[\s\S]*?: null;/);
  assert.ok(match, 'existingCart computation must cover both ORDER and QUESTION flowUpper values');

  // eslint-disable-next-line no-new-func
  const compute = new Function('flowUpper', 'session', `${match[0]}\nreturn existingCart;`);

  const cart = [{ name: 'Jollof Rice', qty: 1 }];
  assert.deepEqual(compute('ORDER', { data: { cart } }), cart, 'ORDER must still preserve an existing cart');
  assert.deepEqual(compute('QUESTION', { data: { cart } }), cart, 'QUESTION must now also preserve an existing cart');
  assert.equal(compute('BOOKING', { data: { cart } }), null, 'other flows must not pick up an unrelated cart');
  assert.equal(compute('QUESTION', { data: {} }), null, 'no cart to preserve when none exists');
});

test('modules/restaurant/flows/orderFlow.js: the mid-ORDER inline Q&A interception no longer force-switches currentFlow away from ORDER', () => {
  const src = read('../modules/restaurant/flows/orderFlow.js');
  const startMarker = 'if (qAnswer?.handled && qAnswer.body) {';
  const endMarker = 'BROWSE_CATALOG';
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, 'inline Q&A interception block not found');
  const end = src.indexOf(endMarker, start);
  assert.ok(end !== -1, 'end of inline Q&A interception block not found');
  const block = src.slice(start, end);
  // (Matches the actual call syntax, not the explanatory code comment inside
  // this same block that references persistQuestionSession by name.)
  assert.doesNotMatch(
    block,
    /await\s+(questionAnswerService\.)?persistQuestionSession\(/,
    'must not call persistQuestionSession (which forces currentFlow to QUESTION/AWAITING_QUESTION) from inside an active ORDER flow'
  );
  assert.match(
    block,
    /mergeQuestionContext/,
    'must still record the Q&A context (via mergeQuestionContext) without changing currentFlow/step'
  );
});
