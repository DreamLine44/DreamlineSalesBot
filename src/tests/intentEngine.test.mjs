// tests/intentEngine.test.mjs
//
// Pure, additive regression tests for core/intents/intentEngine.js.
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, normalise } from '../core/intents/intentEngine.js';

test('normalise() lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normalise('  Hello,   World!! '), 'hello world');
  assert.equal(normalise(''), '');
  assert.equal(normalise(undefined), '');
});

test('detectIntent: barber-pole emoji now routes to BOOKING, not FALLBACK', async () => {
  // Direct regression test for the live bug found and fixed in patterns.js:
  // EMOJI_MAP['💈'] was 'START_BOOKING' (not a valid intentToAction() key),
  // so a customer texting only 💈 got routed to FALLBACK instead of booking.
  const result = await detectIntent({ message: '💈', isInteractive: false, business: { businessMode: 'BARBERSHOP' } });
  assert.equal(result.action, 'START_BOOKING');
  assert.notEqual(result.action, 'FALLBACK');
});

test('detectIntent: known button tap ID resolves via BUTTON_ID_MAP, case-insensitive', async () => {
  const result = await detectIntent({ message: 'order', isInteractive: true, business: {} });
  assert.equal(result.action, 'START_ORDER');
  assert.equal(result.source, 'button');
});

test('detectIntent: unmapped interactive ID falls back to CONTINUE_FLOW, not FALLBACK', async () => {
  // Protects in-flow list selections (e.g. a product row ID) from being
  // misrouted to the global fallback message.
  const result = await detectIntent({ message: 'SOME_UNMAPPED_ROW_ID', isInteractive: true, business: {} });
  assert.equal(result.action, 'CONTINUE_FLOW');
});

test('detectIntent: bare numeric, non-interactive message is treated as CONTINUE_FLOW', async () => {
  // Guards the quantity/date-digit path documented in the file's own
  // "GOLDEN RULES" comment: short/numeric inputs must never trigger a flow.
  const result = await detectIntent({ message: '3', isInteractive: false, business: {} });
  assert.equal(result.action, 'CONTINUE_FLOW');
});

test('detectIntent: other documented emoji shortcuts still resolve to a real action', async () => {
  const cases = [
    ['🛒', 'START_ORDER'],
    ['📅', 'START_BOOKING'],
    ['❓', 'QUESTION'],
    ['👍', 'ACKNOWLEDGE'],
  ];
  for (const [emoji, expectedAction] of cases) {
    const result = await detectIntent({ message: emoji, isInteractive: false, business: {} });
    assert.equal(result.action, expectedAction, `emoji '${emoji}' should resolve to '${expectedAction}'`);
  }
});
