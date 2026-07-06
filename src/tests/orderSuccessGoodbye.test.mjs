// tests/orderSuccessGoodbye.test.mjs
//
// [FIX-GOODBYE-1] Regression test.
//
// Bug: buildOrderSuccess() (modules/restaurant/handlers/uiBuilders.js) used to
// bundle "Place New Order / Book a Table / Start Over" buttons into the SAME
// message as the order-placed thank-you. The bot said goodbye and immediately
// asked "what would you like to do next?" in one breath — read as fake/
// contradictory to customers (see conversation review, screenshots of live
// chat). The fix: end the message as a genuine close (type: 'text', no
// buttons). The conversation only resumes if the customer messages again,
// via the normal returning-customer greeting path in moduleRouter.js.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderSuccess } from '../modules/restaurant/handlers/uiBuilders.js';

test('buildOrderSuccess ends the conversation warmly — no buttons, plain text', () => {
  const ui = buildOrderSuccess({ item: 'Jollof Rice', qty: 2, business: { name: 'DreamLine Restaurant' } });

  assert.equal(ui.type, 'text', 'should be a plain text close, not a buttons prompt');
  assert.equal(ui.buttons, undefined, 'must not attach a button menu right after the thank-you');
  assert.match(ui.body, /2× Jollof Rice/, 'still confirms the correct item/quantity');
  assert.doesNotMatch(ui.body, /what would you like to do next/i, 'must not immediately ask "what next" in the same message');
});

test('buildOrderSuccess handles an item object (not just a plain string) the same way', () => {
  const ui = buildOrderSuccess({ item: { name: 'Benachin (Chicken)' }, qty: 1, business: { name: 'DreamLine Restaurant' } });
  assert.equal(ui.type, 'text');
  assert.match(ui.body, /Benachin \(Chicken\)/);
});
