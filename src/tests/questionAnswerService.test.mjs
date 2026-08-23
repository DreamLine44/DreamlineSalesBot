// tests/questionAnswerService.test.mjs
//
// DB-first Q&A mode, reference lookup, and admin cancel-by-reference regressions.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  extractShortId,
  isValidShortIdFormat,
  formatLookupFailureMessage,
} from '../services/activityLookupService.js';
import {
  formatMenuText,
  formatHoursText,
  tryDatabaseAnswer,
} from '../services/questionAnswerService.js';
import { isBusinessScopeQuestion } from '../services/questionModeHelper.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const business = {
  businessMode: 'RESTAURANT',
  payment: { currency: 'GMD', channels: ['Cash', 'Wave'] },
  address: '123 Kairaba Avenue',
  adminPhone: '+2201234567',
  menuItems: [
    { name: 'Domoda', price: 200, available: true },
    { name: 'Benachin', price: 180, available: true },
  ],
  hours: {
    enabled: true,
    open: 9,
    close: 22,
    days: {
      monday:    { open: 9, close: 22 },
      tuesday:   { open: 9, close: 22 },
      wednesday: { closed: true },
    },
  },
  faq: [{ trigger: 'delivery', reply: 'We deliver within 5km.' }],
};

// ── Reference extraction ────────────────────────────────────────────────────

test('extractShortId parses #F921EB and order #F921EB forms', () => {
  assert.equal(extractShortId('track order #F921EB'), 'F921EB');
  assert.equal(extractShortId('Cancel order #A1B2C3'), 'A1B2C3');
  assert.equal(extractShortId('Cancel DSB-0818-782DF2'), '782DF2');
  assert.equal(extractShortId('DSB-0818-782DF2'), '782DF2');
  assert.equal(extractShortId('hello'), null);
});

test('extractShortId accepts bare ref in tracking context', () => {
  const session = { data: { _questionCtx: { lastTopic: 'ORDER_TRACKING' } } };
  assert.equal(extractShortId('F921EB', session), 'F921EB');
  assert.equal(extractShortId('F921EB', {}), null);
});

test('isValidShortIdFormat validates reference tokens', () => {
  assert.equal(isValidShortIdFormat('F921EB'), true);
  assert.equal(isValidShortIdFormat('AB'), false);
});

test('formatLookupFailureMessage explains what was checked', () => {
  const msg = formatLookupFailureMessage({ shortId: 'F921EB', checks: ['order by reference', 'active orders by phone'] });
  assert.match(msg, /#F921EB/);
  assert.match(msg, /order by reference/);
});

// ── DB-first menu / hours / FAQ ───────────────────────────────────────────────

test('formatMenuText lists real menu items with prices', () => {
  const text = formatMenuText(business);
  assert.match(text, /Domoda/);
  assert.match(text, /GMD200/);
  assert.match(text, /Benachin/);
  assert.doesNotMatch(text, /variety of authentic/i);
});

test('formatHoursText renders structured opening hours', () => {
  const text = formatHoursText(business);
  assert.match(text, /Opening Hours/i);
  assert.match(text, /Monday/i);
  assert.match(text, /Closed/i);
});

test('tryDatabaseAnswer returns menu from database for menu questions', async () => {
  const result = await tryDatabaseAnswer({
    message: 'What do you have on your menu today?',
    business,
    session: {},
  });
  assert.equal(result.handled, true);
  assert.match(result.body, /Domoda/);
  assert.equal(result.routingDecision, 'VIEW_MENU');
});

test('tryDatabaseAnswer resolves a contextual follow-up about whether listed items are all available', async () => {
  const result = await tryDatabaseAnswer({
    message: 'Are these the only ones you have?',
    business,
    session: {},
  });
  assert.equal(result.handled, true);
  assert.equal(result.routingDecision, 'VIEW_MENU');
  assert.match(result.body, /Domoda/);
});

test('handleOrderFlow routes menu-availability questions to Q&A instead of item-not-found', async () => {
  const { handleOrderFlow } = await import('../modules/restaurant/flows/orderFlow.js');
  const reply = await handleOrderFlow({
    session: {
      customerPhone: '2201234567',
      tenantId: 'tenant-1',
      step: 'SELECT_ITEM',
      data: {},
    },
    message: 'Are these the only ones you have?',
    business,
    tenant: {},
    isInteractive: false,
  });
  assert.ok(reply);
  assert.match(reply.body, /Today's Menu|Domoda|Benachin/i);
  assert.doesNotMatch(reply.body, /I couldn't find .* on our menu/i);
});

test('tryDatabaseAnswer returns FAQ answer without AI', async () => {
  const result = await tryDatabaseAnswer({
    message: 'Do you offer delivery?',
    business,
    session: {},
  });
  assert.equal(result.handled, true);
  assert.match(result.body, /deliver within 5km/i);
});

// [FIX-FAQ-FIELD] Regression test for a confirmed live bug: tryFaqMatch()
// read `faq.answer`, but BusinessConfig's faqSchema (src/models/BusinessConfig.js)
// only ever stores `trigger` and `reply` — `answer` does not exist on the
// schema. Every FAQ trigger match therefore returned `undefined` as the reply
// body to real customers. This test's fixture previously used `answer` too,
// which is exactly why the bug shipped silently: the fixture matched the bug,
// not the schema. It now uses `reply` (the real field) so this test would
// fail again if the code ever reverts to reading `faq.answer`.
test('tryFaqMatch reads faq.reply (the schema field), not faq.answer', async () => {
  const faqOnlyBusiness = {
    businessMode: 'RESTAURANT',
    faq: [{ trigger: 'refund', reply: 'Refunds are processed within 3 business days.' }],
  };
  const result = await tryDatabaseAnswer({
    message: 'What is your refund policy?',
    business: faqOnlyBusiness,
    session: {},
  });
  assert.equal(result.handled, true);
  assert.equal(result.routingDecision, 'FAQ');
  assert.match(result.body, /3 business days/i);
  assert.notEqual(result.body, undefined);
});

test('tryFaqMatch does not crash and falls through when faq entries are missing reply text', async () => {
  const brokenBusiness = {
    businessMode: 'RESTAURANT',
    menuItems: [{ name: 'Domoda', price: 200, available: true }],
    faq: [{ trigger: 'refund' }], // malformed: no reply field at all
  };
  const result = await tryDatabaseAnswer({
    message: 'What is your refund policy?',
    business: brokenBusiness,
    session: {},
  });
  // Should not silently "handle" the message with an undefined body.
  if (result.handled) {
    assert.notEqual(result.body, undefined);
    assert.notEqual(result.routingDecision, 'FAQ');
  }
});

test('tryDatabaseAnswer answers a specific availability question from live menu data', async () => {
  const result = await tryDatabaseAnswer({
    message: 'Do you have Domoda?',
    business,
    session: {},
  });
  assert.equal(result.handled, true);
  assert.match(result.body, /Domoda/);
  assert.doesNotMatch(result.body, /Today.s Menu/i);
});

// [FIX-PRICE-PLURAL] Regression test for the screenshot-reported bug: a
// customer asked "what are the prices of your food items" and got a
// nonsense "I couldn't find ... in our current products" reply instead of
// real prices, because PRICE_RE's word-boundary match on "price"/"cost"
// never matched the plural "prices"/"costs" — the far more natural phrasing
// — so classifyQuestion() fell through to 'GENERAL' and the message never
// reached this PRICE branch at all.
test('tryDatabaseAnswer answers a plural "prices" question the same way it answers a singular "price" question', async () => {
  const singular = await tryDatabaseAnswer({
    message: 'What is the price of Domoda?',
    business,
    session: {},
  });
  assert.equal(singular.handled, true);
  assert.match(singular.body, /Domoda/);
  assert.match(singular.body, /200/);

  const plural = await tryDatabaseAnswer({
    message: 'What are the prices of Domoda?',
    business,
    session: {},
  });
  assert.equal(plural.handled, true);
  assert.match(plural.body, /Domoda/);
  assert.match(plural.body, /200/);
});

test('tryDatabaseAnswer recognises a general plural-prices question ("what are the prices of your food items") as PRICE-classified, not a dead end', async () => {
  const result = await tryDatabaseAnswer({
    message: 'what are the prices of your food items',
    business,
    session: {},
  });
  assert.equal(result.handled, true, 'a plural prices question about the whole menu must be handled, not fall through to AI/GENERAL');
  assert.equal(result.routingDecision, 'QUESTION');
  // With more than one menu item, the PRICE branch asks which item the
  // customer means rather than silently failing — either outcome is fine as
  // long as it's a real, on-topic reply, never the "couldn't find in our
  // current products" catalogue miss.
  assert.doesNotMatch(result.body, /couldn'?t find/i);
});

// [FIX-HOURS-NATURAL] / [FIX-CONTACT-NATURAL] / [FIX-PAYMENT-NATURAL]
// Regression tests: these natural phrasings previously fell through to
// GENERAL/AI instead of being answered from real business data.
test('tryDatabaseAnswer recognises day-specific and terse hours questions', async () => {
  const openSunday = await tryDatabaseAnswer({
    message: 'you guys open on sundays?',
    business,
    session: {},
  });
  assert.equal(openSunday.handled, true);
  assert.doesNotMatch(openSunday.body, /couldn'?t find/i);

  const terse = await tryDatabaseAnswer({ message: 'you open?', business, session: {} });
  assert.equal(terse.handled, true);
});

test('tryDatabaseAnswer recognises "how do I reach you" / "your whatsapp" as contact questions', async () => {
  const reach = await tryDatabaseAnswer({ message: 'how do i reach you', business, session: {} });
  assert.equal(reach.handled, true);
  assert.match(reach.body, /\+2201234567/);

  const whatsapp = await tryDatabaseAnswer({ message: "what's ur whatsapp", business, session: {} });
  assert.equal(whatsapp.handled, true);
});

test('tryDatabaseAnswer recognises "do you accept card payments" as a payment question', async () => {
  const result = await tryDatabaseAnswer({
    message: 'do you accept card payments',
    business,
    session: {},
  });
  assert.equal(result.handled, true);
  assert.doesNotMatch(result.body, /couldn'?t find/i);
});

test('tryDatabaseAnswer returns configured contact details for phone questions', async () => {
  const result = await tryDatabaseAnswer({
    message: 'What is your phone number?',
    business,
    session: {},
  });
  assert.equal(result.handled, true);
  assert.match(result.body, /\+2201234567/);
});

test('isBusinessScopeQuestion is mode-aware (not restaurant-only)', () => {
  assert.equal(isBusinessScopeQuestion('what services do you offer', { businessMode: 'SALON' }), true);
  assert.equal(isBusinessScopeQuestion('who is the president', { businessMode: 'RESTAURANT' }), false);
});

// ── Wiring source assertions ──────────────────────────────────────────────────

test('adminCommandService supports CANCEL ORDER/BOOKING by reference', () => {
  const src = readSource('../services/adminCommandService.js');
  assert.match(src, /cancelOrderByShortId/);
  assert.match(src, /cancelBookingByShortId/);
  assert.match(src, /CANCEL\\s\+ORDER/);
});

test('question handlers use resolveQuestionReply', () => {
  const restaurant = readSource('../modules/restaurant/flows/orderFlow.js');
  const general = readSource('../modules/general/flows/index.js');
  assert.match(restaurant, /resolveQuestionReply/);
  assert.match(general, /resolveQuestionReply/);
  assert.match(general, /persistQuestionSession/);
  assert.match(general, /recordQuestionHistory/);
});

test('persistQuestionSession preserves ENQUIRY flow', () => {
  const src = readSource('../services/questionAnswerService.js');
  assert.match(src, /currentFlow === 'ENQUIRY' \? 'ENQUIRY' : 'QUESTION'/);
});

test('activityStatusService uses reference-first lookup', () => {
  const src = readSource('../services/activityStatusService.js');
  assert.match(src, /extractShortId/);
  assert.match(src, /lookupActivityByReference/);
  assert.match(src, /trackingContext/);
});

test('processQuestionMessage handles general messages without throwing', async () => {
  const { processQuestionMessage } = await import('../services/questionAnswerService.js');
  const business = {
    businessMode: 'RESTAURANT',
    menuItems: [{ name: 'Domoda', price: 200, available: true }],
    payment: { currency: 'GMD' },
  };
  const session = { customerPhone: '2201234567', tenantId: 'test', data: {} };
  const reply = await processQuestionMessage({
    session,
    message: 'hello',
    business,
    tenant: {},
    intent: 'FAQ',
  });
  assert.ok(reply.body);
  assert.equal(reply.type, 'text');
  assert.equal(reply.buttons, undefined);
});

test('webhook ENQUIRY path uses resolveQuestionReply and recordQuestionHistory', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.match(src, /resolveQuestionReply/);
  assert.match(src, /persistQuestionSession/);
  assert.match(src, /recordQuestionHistory/);
});
