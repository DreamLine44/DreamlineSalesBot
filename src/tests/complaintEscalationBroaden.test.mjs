// tests/complaintEscalationBroaden.test.mjs
//
// [AUDIT-FIX-COMPLAINT-BROADEN-1] Regression tests.
//
// Bug: negationGuard.js's COMPLAINT_RE only covered specific product/order
// complaints ("wrong order", "cold food"...). General anger/frustration at
// the bot/conversation itself ("this is ridiculous", "your bot is useless",
// "connect me with a real person") did NOT match it, so those messages fell
// through to the FALLBACK/CLARIFY path — an AI-guessed reply plus the
// default welcome menu, with only a cosmetic "Sorry about that" tone prefix
// stuck on top (see core/sentiment/emotionEngine.js). A frustrated customer
// effectively got "sorry — here's our menu" instead of being routed to the
// existing SUPPORT flow (human handoff + admin alert).
//
// This test does not import negationGuard.js's live dependents (webhookController,
// moduleRouter) since those need a live DB/env — it exercises analyzeMessage()
// directly, same pattern as declineDetection.test.mjs pins DECLINE_RE.
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage } from '../core/intents/negationGuard.js';

test('general frustration/anger phrases now trigger the complaint guard', () => {
  const angry = [
    'this is ridiculous, i need it now',
    'your bot is useless',
    'i am so angry right now',
    "i'm so frustrated with this",
    'sick of this, cancel everything',
    'why is this not working',
    'completely unacceptable',
    'this is a disaster',
  ];
  for (const msg of angry) {
    assert.ok(analyzeMessage(msg).complaint, `"${msg}" should trigger the complaint guard`);
  }
});

test('free-form requests for a human agent now trigger the complaint guard', () => {
  const humanRequests = [
    'can I talk to a real person please',
    'connect me with an agent',
    'i want to speak to a manager about this',
  ];
  for (const msg of humanRequests) {
    assert.ok(analyzeMessage(msg).complaint, `"${msg}" should trigger the complaint guard`);
  }
});

test('ordinary ordering language is NOT swallowed by the broadened guard', () => {
  const benign = [
    'i want to order 2 burgers',
    'the small one please, not the large',
    'i want a burger and fries',
    'do you have this in medium',
  ];
  for (const msg of benign) {
    assert.ok(!analyzeMessage(msg).complaint, `"${msg}" should NOT trigger the complaint guard`);
  }
});

test('existing narrow complaint phrases still match (no regression)', () => {
  const existing = [
    'my order was wrong',
    'the food was cold',
    'i want a refund',
    'i have a complaint',
  ];
  for (const msg of existing) {
    assert.ok(analyzeMessage(msg).complaint, `"${msg}" should still trigger the complaint guard`);
  }
});
