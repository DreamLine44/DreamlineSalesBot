// tests/enhancedNlu.test.mjs
//
// [ENHANCED-NLU] Regression tests for the Groq understanding layer.
// Verifies product resolution, feature flags, and wiring into intentEngine /
// moduleRegistry without requiring a live GROQ_API_KEY.
//
// Run with:  node --test src/tests/enhancedNlu.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  resolveProductEntities,
} from '../core/nlu/extraction/enhancedNlu.js';
import {
  isEnhancedNluEnabled,
  buildConversationContext,
  appendAiHistoryTurn,
  getAiHistoryMessages,
} from '../core/nlu/extraction/nluContext.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const business = {
  businessMode: 'RESTAURANT',
  menuItems: [
    { _id: '1', name: 'Domoda', price: 150, available: true },
    { _id: '2', name: 'Benachin', price: 180, available: true },
    { _id: '3', name: 'Yassa Chicken', price: 200, available: false },
  ],
};

// ── nluContext.js ─────────────────────────────────────────────────────────────

test('isEnhancedNluEnabled: off when ENHANCED_NLU=false even with API key', () => {
  const prevFlag = process.env.ENHANCED_NLU;
  const prevKey = process.env.GROQ_API_KEY;
  process.env.ENHANCED_NLU = 'false';
  process.env.GROQ_API_KEY = 'test-key';
  assert.equal(isEnhancedNluEnabled(), false);
  process.env.ENHANCED_NLU = prevFlag;
  process.env.GROQ_API_KEY = prevKey;
});

test('isEnhancedNluEnabled: on when GROQ_API_KEY present and flag unset', () => {
  const prevFlag = process.env.ENHANCED_NLU;
  const prevKey = process.env.GROQ_API_KEY;
  delete process.env.ENHANCED_NLU;
  process.env.GROQ_API_KEY = 'test-key';
  assert.equal(isEnhancedNluEnabled(), true);
  process.env.ENHANCED_NLU = prevFlag;
  process.env.GROQ_API_KEY = prevKey;
});

test('buildConversationContext includes flow, cart, and order channel', () => {
  const ctx = buildConversationContext({
    session: {
      currentFlow: 'ORDER',
      step: 'SELECT_ITEM',
      orderChannel: 'catalog',
      data: { cart: [{ item: { name: 'Domoda', price: 150 }, quantity: 2 }] },
    },
    business,
  });
  assert.match(ctx, /Active flow: ORDER/);
  assert.match(ctx, /Shopping channel: catalog/);
  assert.match(ctx, /Cart:/);
});

test('aiHistory helpers trim and cap turns', () => {
  let session = { aiHistory: [] };
  session = { ...session, aiHistory: appendAiHistoryTurn(session, 'user', 'Hello there') };
  session = { ...session, aiHistory: appendAiHistoryTurn(session, 'assistant', 'Hi! How can I help?') };
  const msgs = getAiHistoryMessages(session);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
});

// ── resolveProductEntities ────────────────────────────────────────────────────

test('resolveProductEntities: exact and fuzzy HIGH matches only', () => {
  const resolved = resolveProductEntities([
    { name: 'Domoda', quantity: 2 },
    { name: 'domoda', quantity: 1 },
    { name: 'Completely Unknown Dish XYZ', quantity: 1 },
  ], business);

  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].item.name, 'Domoda');
  assert.equal(resolved[0].quantity, 2);
  assert.equal(resolved[1].item.name, 'Domoda');
});

test('resolveProductEntities: skips unavailable menu items', () => {
  const resolved = resolveProductEntities([{ name: 'Yassa Chicken', quantity: 1 }], business);
  assert.equal(resolved.length, 0);
});

test('resolveProductEntities: empty input returns empty array', () => {
  assert.deepEqual(resolveProductEntities([], business), []);
  assert.deepEqual(resolveProductEntities(null, business), []);
});

// ── Source wiring assertions ──────────────────────────────────────────────────

test('groqProvider.js: classifyMessageStructured exports JSON NLU shape', () => {
  const src = readSource('../core/nlu/extraction/groqProvider.js');
  assert.match(src, /export async function classifyMessageStructured/);
  assert.match(src, /primaryIntent/);
  assert.match(src, /secondaryIntents/);
  assert.match(src, /clarificationNeeded/);
  assert.match(src, /entities/);
});

test('intentEngine.js: classifyWithAI delegates to enhanced NLU when enabled', () => {
  const src = readSource('../core/nlu/classification/intentEngine.js');
  assert.match(src, /classifyMessageEnhanced/);
  assert.match(src, /isEnhancedNluEnabled/);
  assert.match(src, /nlu:\s*\{/);
});

test('moduleRegistry.js: START_ORDER pre-seeds cart from _nluPending products', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  assert.match(src, /_nluPending\?\.products/);
  assert.match(src, /mergeCartLines/);
});

test('webhookController.js: persists _nluPending and aiHistory', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.match(src, /_nluPending: nlu\.entities/);
  assert.match(src, /appendAiHistoryTurn\(session, 'user'/);
  assert.match(src, /appendAiHistoryTurn\(s, 'assistant'/);
});

test('moduleRouter.js: CLARIFY uses nlu clarification when present', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  assert.match(src, /nlu\?\.clarification/);
  assert.match(src, /getAiHistoryMessages/);
});

test('Session model: aiHistory field defined', () => {
  const src = readSource('../models/Session.js');
  assert.match(src, /aiHistory:/);
});
