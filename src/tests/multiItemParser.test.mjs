// tests/multiItemParser.test.mjs
//
// [MULTICART-FLOW-1] Regression tests for utils/multiItemParser.js —
// the free-text scanner that finds multiple known catalog items in a single
// customer message (e.g. "2 burgers and a coke") instead of the old
// single-match-per-message behavior in utils/matchEngine.js.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCartLines } from '../utils/multiItemParser.js';

const MENU = [
  { _id: '1', name: 'Burger' },
  { _id: '2', name: 'Coke' },
  { _id: '3', name: 'Fish and Chips' },
  { _id: '4', name: 'Fries' },
  { _id: '5', name: 'Pizza' },
  { _id: '6', name: 'Jollof Rice' },
];

function names(result) {
  return result.lines.map(l => l.item.name).sort();
}

test('empty text or empty menu returns no lines', () => {
  assert.equal(extractCartLines('', MENU).matchedCount, 0);
  assert.equal(extractCartLines('2 burgers', []).matchedCount, 0);
  assert.equal(extractCartLines(null, MENU).matchedCount, 0);
});

test('two items with digit and word quantities', () => {
  const r = extractCartLines('2 burgers and a coke', MENU);
  assert.equal(r.matchedCount, 2);
  const burger = r.lines.find(l => l.item.name === 'Burger');
  const coke   = r.lines.find(l => l.item.name === 'Coke');
  assert.equal(burger.quantity, 2);
  assert.equal(coke.quantity, 1);
});

test('a compound item name containing "and" is matched whole, not torn apart', () => {
  // The bug this guards against: naively splitting on "and" would produce
  // "Fish" + "Chips" as two separate (and possibly non-existent) items
  // instead of recognizing "Fish and Chips" as one menu item.
  const r = extractCartLines('i want fish and chips and a coke please', MENU);
  assert.equal(r.matchedCount, 2);
  assert.deepEqual(names(r), ['Coke', 'Fish and Chips']);
});

test('three items separated by commas', () => {
  const r = extractCartLines('2 pizzas, 3 fries, and a jollof rice', MENU);
  assert.equal(r.matchedCount, 3);
  const byName = Object.fromEntries(r.lines.map(l => [l.item.name, l.quantity]));
  assert.equal(byName['Pizza'], 2);
  assert.equal(byName['Fries'], 3);
  assert.equal(byName['Jollof Rice'], 1);
});

test('repeated mentions of the same item merge into one line with summed quantity', () => {
  const r = extractCartLines('two burgers and two more burgers', MENU);
  assert.equal(r.matchedCount, 1);
  assert.equal(r.lines[0].item.name, 'Burger');
  assert.equal(r.lines[0].quantity, 4);
});

test('"2x" shorthand notation is parsed as a quantity', () => {
  const r = extractCartLines('2x burger and 1x coke', MENU);
  const byName = Object.fromEntries(r.lines.map(l => [l.item.name, l.quantity]));
  assert.equal(byName['Burger'], 2);
  assert.equal(byName['Coke'], 1);
});

test('a single item in the message still parses correctly (no regression for the common case)', () => {
  const r = extractCartLines('just a coke', MENU);
  assert.equal(r.matchedCount, 1);
  assert.equal(r.lines[0].item.name, 'Coke');
  assert.equal(r.lines[0].quantity, 1);
});

test('word-number quantities ("a dozen") resolve correctly', () => {
  const r = extractCartLines('a dozen fries', MENU);
  assert.equal(r.lines[0].quantity, 12);
});

test('gibberish / off-menu text returns zero matches, not a false positive', () => {
  const r = extractCartLines('asdkjfh random gibberish', MENU);
  assert.equal(r.matchedCount, 0);
});

test('a bare substring of a compound item name does not falsely match on its own', () => {
  // "fish" alone should NOT match "Fish and Chips" when there is no
  // standalone "Fish" item on the menu — plain substring matching would
  // wrongly claim this as a match.
  const r = extractCartLines('I want fish', MENU);
  assert.equal(r.matchedCount, 0);
});

test('item name is matched case-insensitively', () => {
  const r = extractCartLines('2 BURGERS please', MENU);
  assert.equal(r.matchedCount, 1);
  assert.equal(r.lines[0].quantity, 2);
});

test('simple plural of a singular menu item name is recognized', () => {
  const r = extractCartLines('3 pizzas', MENU);
  assert.equal(r.matchedCount, 1);
  assert.equal(r.lines[0].item.name, 'Pizza');
  assert.equal(r.lines[0].quantity, 3);
});

test('no quantity given defaults to 1', () => {
  const r = extractCartLines('burger and fries', MENU);
  const byName = Object.fromEntries(r.lines.map(l => [l.item.name, l.quantity]));
  assert.equal(byName['Burger'], 1);
  assert.equal(byName['Fries'], 1);
});
