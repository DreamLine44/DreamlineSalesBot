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
  faq: [{ trigger: 'delivery', answer: 'We deliver within 5km.' }],
};

// ── Reference extraction ────────────────────────────────────────────────────

test('extractShortId parses #F921EB and order #F921EB forms', () => {
  assert.equal(extractShortId('track order #F921EB'), 'F921EB');
  assert.equal(extractShortId('Cancel order #A1B2C3'), 'A1B2C3');
  assert.equal(extractShortId('hello'), null);
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

test('tryDatabaseAnswer returns FAQ answer without AI', async () => {
  const result = await tryDatabaseAnswer({
    message: 'Do you offer delivery?',
    business,
    session: {},
  });
  assert.equal(result.handled, true);
  assert.match(result.body, /deliver within 5km/i);
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

test('question handlers use processQuestionMessage', () => {
  const restaurant = readSource('../modules/restaurant/flows/orderFlow.js');
  const general = readSource('../modules/general/flows/index.js');
  assert.match(restaurant, /processQuestionMessage/);
  assert.match(general, /processQuestionMessage/);
  assert.match(general, /persistQuestionSession/);
});

test('activityStatusService uses reference-first lookup', () => {
  const src = readSource('../services/activityStatusService.js');
  assert.match(src, /extractShortId/);
  assert.match(src, /lookupActivityByReference/);
  assert.match(src, /trackingContext/);
});

test('webhook ENQUIRY path uses DB-first questionAnswerService', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.match(src, /processQuestionMessage/);
  assert.match(src, /persistQuestionSession/);
});
