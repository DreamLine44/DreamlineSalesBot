// tests/directIntentMenuSkip.test.mjs
//
// Pure, additive regression tests for core/nlu/classification/intentEngine.js.
// Does NOT modify any existing source file.
//
// Covers the product requirement: a customer who directly types an
// order/booking request must NOT be shown the generic 3-button welcome
// menu (Order Food / Book a Table / Ask a Question) — they must be routed
// straight into START_ORDER or START_BOOKING so the actual menu / booking
// flow opens immediately.
//
// This locks in behavior implemented via:
//   - step 4 exact keyword match (INTENT_PATTERNS.ORDER / .BOOKING)
//   - step 4.5 "[UPGRADE-DIRECT-INTENT]" widened phrase match
//     (ORDER_DIRECT_RE / BOOKING_DIRECT_RE), guarded by
//     DIRECT_INTENT_EXCLUDE_RE for negation / cancellation / tracking.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent } from '../core/nlu/classification/intentEngine.js';

const RESTAURANT = { businessMode: 'RESTAURANT' };

test('detectIntent: exact "order food" / "book a table" phrases skip the welcome menu', async () => {
  const order = await detectIntent({ message: 'order food', isInteractive: false, session: {}, business: RESTAURANT });
  assert.equal(order.action, 'START_ORDER');
  assert.notEqual(order.action, 'GREET');

  const booking = await detectIntent({ message: 'book a table', isInteractive: false, session: {}, business: RESTAURANT });
  assert.equal(booking.action, 'START_BOOKING');
  assert.notEqual(booking.action, 'GREET');
});

test('detectIntent: natural-language order requests resolve directly, not via FALLBACK/GREET', async () => {
  const phrases = [
    'I want to order',
    "I'd like to order",
    'i wanna order',
    'Can I order something to eat?',
    'I want to order pizza',
    'order please',
  ];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: RESTAURANT });
    assert.equal(result.action, 'START_ORDER', `"${message}" should resolve to START_ORDER, got ${result.action}`);
  }
});

test('detectIntent: natural-language booking requests resolve directly, not via FALLBACK/GREET', async () => {
  const phrases = [
    'Book a Table',
    'book a table please',
    "I'd like to book a table",
    'table for 4 tonight',
    'reserve a table',
    'can i book',
  ];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: RESTAURANT });
    assert.equal(result.action, 'START_BOOKING', `"${message}" should resolve to START_BOOKING, got ${result.action}`);
  }
});

test('detectIntent: greeting-prefixed order/booking requests still skip the welcome menu', async () => {
  // "Hi, I want to order" must not stop at GREET just because it opens with a
  // greeting word — the customer's actual intent (order/booking) takes priority.
  const order = await detectIntent({ message: 'Hi, I want to order', isInteractive: false, session: {}, business: RESTAURANT });
  assert.equal(order.action, 'START_ORDER');

  const booking = await detectIntent({ message: 'hello I want to book a table', isInteractive: false, session: {}, business: RESTAURANT });
  assert.equal(booking.action, 'START_BOOKING');
});

test('detectIntent: negated/cancelling phrases must NOT trigger START_ORDER or START_BOOKING', async () => {
  // Regression guard for the exclude-list (DIRECT_INTENT_EXCLUDE_RE), which
  // must block both order and booking direct-phrase matches equally.
  const phrases = [
    "I don't want to order anymore",
    "I don't want to book",
    "I don't want to book anymore",
    "don't want to book a table",
    'I do not want to book',
    'never mind the booking',
    "I don't want a table",
  ];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: RESTAURANT });
    assert.notEqual(result.action, 'START_ORDER', `"${message}" incorrectly fired START_ORDER`);
    assert.notEqual(result.action, 'START_BOOKING', `"${message}" incorrectly fired START_BOOKING`);
  }
});

test('detectIntent: tracking/status phrases about an existing order are not misrouted to START_ORDER', async () => {
  const phrases = ['where is my order', "checking on my booking", 'track my order', 'what is the status of my table booking'];
  for (const message of phrases) {
    const result = await detectIntent({ message, isInteractive: false, session: {}, business: RESTAURANT });
    assert.notEqual(result.action, 'START_ORDER', `"${message}" incorrectly fired START_ORDER`);
    assert.notEqual(result.action, 'START_BOOKING', `"${message}" incorrectly fired START_BOOKING`);
  }
});
