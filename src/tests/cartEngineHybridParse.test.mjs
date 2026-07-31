// tests/cartEngineHybridParse.test.mjs
//
// [MULTICART-HYBRID-PARSE] Regression tests for the hybrid fallback added to
// core/shared/cartEngine.js's parseMultiItemMessage(): when the existing
// separator-based segment-split pass resolves fewer than 2 distinct items,
// it now also runs utils/multiItemParser.js's extractCartLines() (a direct
// known-name scan with no splitting) and folds in anything new by _id. This
// is what lets the restaurant/salon flows (the two verticals wired to
// cartEngine.js) understand messages the segment-split pass alone would
// miss — no connector word between items, or a segment that fails fuzzy
// matching but still contains an exact/plural known item name.
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMultiItemMessage } from '../core/shared/cartEngine.js';

const MENU = [
  { _id: '1', name: 'Burger', price: 100 },
  { _id: '2', name: 'Coke', price: 20 },
  { _id: '3', name: 'Fish and Chips', price: 150 },
  { _id: '4', name: 'Fries', price: 30 },
  { _id: '5', name: 'Jollof Rice', price: 120 },
];

function byName(result) {
  return Object.fromEntries(result.lines.map(l => [l.item.name, l.quantity]));
}

test('messages with no connector word still resolve via the direct-scan fallback', () => {
  // No "and"/","/"+" between the two items — the segment-split pass alone
  // (segments.length < 2) would return null here without the fallback.
  const r = parseMultiItemMessage(MENU, '2 burgers 3 cokes');
  assert.ok(r, 'expected a multi-item result');
  assert.equal(r.lines.length, 2);
  const names = byName(r);
  assert.equal(names['Burger'], 2);
  assert.equal(names['Coke'], 3);
});

test('a compound item name is still matched whole via the fallback, not torn apart', () => {
  const r = parseMultiItemMessage(MENU, 'fish and chips 2 fries');
  assert.ok(r, 'expected a multi-item result');
  const names = byName(r);
  assert.equal(names['Fish and Chips'], 1);
  assert.equal(names['Fries'], 2);
});

test('segment-split and direct-scan agreeing on an item never double-counts it', () => {
  // "2 burgers and 3 cokes" resolves cleanly via the segment-split pass
  // alone — the fallback must not also run and inflate quantities.
  const r = parseMultiItemMessage(MENU, '2 burgers and 3 cokes');
  assert.ok(r);
  const names = byName(r);
  assert.equal(names['Burger'], 2);
  assert.equal(names['Coke'], 3);
});

test('a normal single-item message is unaffected by the fallback', () => {
  const r = parseMultiItemMessage(MENU, 'jollof rice');
  assert.equal(r, null);
});

test('gibberish text resolves to null via both passes, not a false positive', () => {
  const r = parseMultiItemMessage(MENU, 'asdkjfh random gibberish');
  assert.equal(r, null);
});

test('three items with no connectors and mixed digit/word quantities', () => {
  const r = parseMultiItemMessage(MENU, '2 burgers a coke 3 fries');
  assert.ok(r);
  const names = byName(r);
  assert.equal(names['Burger'], 2);
  assert.equal(names['Coke'], 1);
  assert.equal(names['Fries'], 3);
});
