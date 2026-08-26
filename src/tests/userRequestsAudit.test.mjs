// tests/userRequestsAudit.test.mjs
//
// End-to-end regression audit for customer-requested fixes in this release train.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractShortId } from '../services/activityLookupService.js';
import {
  isInformationalActivityQuestion,
  isBookingInfoQuestion,
  isStayInQuestionMessage,
  isGreetingMessage,
  isHumanHandoffRequest,
} from '../services/questionModeHelper.js';
import { isCatalogBrowseRequest } from '../core/intents/menuIntentDetector.js';
import { tryDatabaseAnswer } from '../services/questionAnswerService.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const restaurantBusiness = {
  businessMode: 'RESTAURANT',
  name: 'DreamLine Restaurant',
  description: 'A Gambian eatery serving benachin and domoda.',
  payment: { currency: 'GMD' },
  menuItems: [{ name: 'Benachin (Fish)', price: 150, available: true }],
  waCatalog: {
    enabled: true,
    catalogId: 'cat123',
    mode: 'ALWAYS_OFFER',
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    syncedRetailerIds: ['benachin-fish'],
  },
};

test('audit: bare cancel is not treated as a #CANCEL reference', () => {
  assert.equal(extractShortId('cancel'), null);
  assert.equal(extractShortId('Cancel my order'), null);
});

test('audit: mid-flow Cancel Order defers to cancelFlow when nothing is saved yet', () => {
  const lifecycle = readSource('../services/activityLifecycleService.js');
  assert.match(lifecycle, /session\?\.currentFlow[\s\S]*return null/);
  const webhook = readSource('../controllers/webhookController.js');
  assert.match(webhook, /tryCustomerCancelRequest\([\s\S]*session,/);
  assert.match(webhook, /upperMsg === 'CANCEL'/);
});

test('audit: menu browse sends catalog directly — no intermediate tap-below step', () => {
  const router = readSource('../core/conversations/moduleRouter.js');
  const block = router.match(/case 'BROWSE_CATALOG':\s*\{[\s\S]*?\n    \}/)[0];
  assert.doesNotMatch(block, /Here's how to see what we have/);
  assert.match(block, /browseCatalogExplicit/);
});

test('audit: natural menu phrases are catalog browse requests', () => {
  for (const phrase of [
    'what do you have on your menu',
    'what can i eat',
    'i want to order food',
  ]) {
    assert.ok(isCatalogBrowseRequest(phrase), `"${phrase}" should open catalog`);
  }
});

test('audit: booking info questions stay in Q&A — not catalog, not switch', () => {
  for (const phrase of ['what can i book', 'what i can o book', 'what do you offer for booking']) {
    assert.ok(isInformationalActivityQuestion(phrase), `"${phrase}" is informational`);
    assert.ok(isBookingInfoQuestion(phrase), `"${phrase}" is booking info`);
    assert.equal(isCatalogBrowseRequest(phrase), false, `"${phrase}" must not open catalog`);
  }
  assert.equal(isInformationalActivityQuestion('what do you have on your menu'), false);
});

test('audit: menu questions are not misclassified as booking info', async () => {
  const menuAnswer = await tryDatabaseAnswer({
    message: 'what do you have on your menu',
    business: restaurantBusiness,
    session: {},
  });
  assert.equal(menuAnswer.showCatalog, true);

  const bookingAnswer = await tryDatabaseAnswer({
    message: 'what can i book',
    business: restaurantBusiness,
    session: {},
  });
  assert.equal(bookingAnswer.handled, true);
  assert.match(bookingAnswer.body, /book/i);
  assert.notEqual(bookingAnswer.showCatalog, true);
});

test('audit: stay-in-question phrasing is recognised', () => {
  assert.ok(isStayInQuestionMessage('am still asking'));
  assert.ok(isStayInQuestionMessage('keep asking'));
});

test('audit: about questions use business description', async () => {
  const result = await tryDatabaseAnswer({
    message: 'what is this all about',
    business: restaurantBusiness,
    session: {},
  });
  assert.match(result.body, /benachin|domoda/i);
});

test('audit: tryShowCatalogForMenuRequest skips booking-info questions', () => {
  const src = readSource('../modules/catalog/waCatalogFlow.js');
  assert.match(src, /isBookingInfoQuestion\(raw\)/);
});

test('audit: bare hi/hello in Q&A routes to welcome menu with options', () => {
  const src = readSource('../controllers/webhookController.js');
  const block = src.slice(
    src.indexOf('// ── 13. Question Mode'),
    src.indexOf('// ── 14. Post-flow acknowledgement'),
  );
  assert.match(block, /isGreetingMessage\(messageText\)/);
  assert.match(block, /action: 'GREET'/);
  assert.match(src, /welcome_sequence/);
});

test('audit: greeting helper and handler finalizer exist', () => {
  assert.ok(isGreetingMessage('hello'));
  const qas = readSource('../services/questionAnswerService.js');
  assert.match(qas, /finalizeQuestionHandlerReply/);
  assert.match(qas, /welcome_sequence/);
});

test('audit: Question Mode answers before switch prompt', () => {
  const src = readSource('../controllers/webhookController.js');
  const block = src.slice(
    src.indexOf('// ── 13. Question Mode'),
    src.indexOf('// ── 14. Post-flow acknowledgement'),
  );
  assert.match(block, /tryShowCatalogForMenuRequest/);
  assert.match(block, /isStayInQuestionMessage/);
  assert.match(block, /resolveQuestionReply/);
  assert.match(src, /function _resolveQuestionModeSwitch[\s\S]*isInformationalActivityQuestion/);
});

test('audit: human handoff in Q&A routes to SUPPORT — not catalog', () => {
  for (const phrase of [
    'i want to talk to human',
    'i want to talk to boss',
    'speak to someone',
  ]) {
    assert.ok(isHumanHandoffRequest(phrase), `"${phrase}" should escalate to human support`);
  }
  assert.equal(isHumanHandoffRequest('i want to order food'), false);

  const catalogFlow = readSource('../modules/catalog/waCatalogFlow.js');
  assert.match(catalogFlow, /isHumanHandoffRequest\(raw\)/);

  const webhook = readSource('../controllers/webhookController.js');
  const block = webhook.slice(
    webhook.indexOf('// ── 13. Question Mode'),
    webhook.indexOf('// ── 14. Post-flow acknowledgement'),
  );
  assert.match(block, /isHumanHandoffRequest\(messageText\)/);
  assert.match(block, /action: 'SUPPORT'/);
});
