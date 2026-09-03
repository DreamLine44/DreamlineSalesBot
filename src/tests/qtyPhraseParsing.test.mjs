// tests/qtyPhraseParsing.test.mjs
//
// [AUDIT-FIX-QTY-PHRASE] Regression tests for core/nlu/resolution/
// cartMessageParser.js's word-quantity-phrase handling.
//
// BUG: "a dozen donuts", "a couple of burgers", "a few samosas", "half a
// dozen eggs", and their article-less forms ("couple of burgers") were all
// silently mis-parsed:
//
//   - LEADING_QTY_RE's group 1 greedily captured the WHOLE two-word phrase
//     ("a dozen"), which parseQuantity() doesn't recognise as a single key,
//     so it returned null.
//   - extractQuantityAndName() then retried with just the FIRST token ("a"),
//     which parseQuantity() resolves to 1 — silently discarding the real
//     count ("dozen" = 12) and leaving it stuck on the front of the item
//     name ("dozen donuts"), which then also failed to fuzzy-match any real
//     menu item.
//   - The article-less form ("couple of burgers") hit the same retry path
//     and left the partitive "of" stuck on the front of the name
//     ("of burgers"), also breaking the menu match.
//
// A customer typing "a dozen donuts" was silently recorded as ordering 1
// (unmatched) item instead of 12 donuts — a silent data-corruption bug, the
// same class as [AUDIT-FIX-GREETING-LEADIN] above.
//
// FIX: QTY_PHRASE_RE strips the optional leading article and trailing
// partitive "of" so parseQuantity() receives the exact key it already
// recognises ("dozen", "half dozen", "couple", "few", "several").
//
// Pure-function tests only — consistent with cartMessageParser.test.mjs's
// isolation rationale.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractQuantityAndName,
  parseNaturalOrderMessage,
} from '../core/nlu/resolution/cartMessageParser.js';

test('extractQuantityAndName: "a dozen donuts" resolves to quantity 12, name "donuts"', () => {
  const { quantity, name } = extractQuantityAndName('a dozen donuts');
  assert.equal(quantity, 12);
  assert.equal(name, 'donuts');
});

test('extractQuantityAndName: "dozen donuts" (no article) also resolves correctly', () => {
  const { quantity, name } = extractQuantityAndName('dozen donuts');
  assert.equal(quantity, 12);
  assert.equal(name, 'donuts');
});

test('extractQuantityAndName: "half a dozen eggs" resolves to quantity 6', () => {
  const { quantity, name } = extractQuantityAndName('half a dozen eggs');
  assert.equal(quantity, 6);
  assert.equal(name, 'eggs');
});

test('extractQuantityAndName: "half dozen eggs" (no "a") also resolves to quantity 6', () => {
  const { quantity, name } = extractQuantityAndName('half dozen eggs');
  assert.equal(quantity, 6);
  assert.equal(name, 'eggs');
});

test('extractQuantityAndName: "a couple of burgers" resolves to quantity 2, name "burgers" (not "of burgers")', () => {
  const { quantity, name } = extractQuantityAndName('a couple of burgers');
  assert.equal(quantity, 2);
  assert.equal(name, 'burgers');
});

test('extractQuantityAndName: "couple of burgers" (no article) also strips the partitive "of"', () => {
  const { quantity, name } = extractQuantityAndName('couple of burgers');
  assert.equal(quantity, 2);
  assert.equal(name, 'burgers');
});

test('extractQuantityAndName: "a few samosas" resolves to quantity 3, name "samosas"', () => {
  const { quantity, name } = extractQuantityAndName('a few samosas');
  assert.equal(quantity, 3);
  assert.equal(name, 'samosas');
});

test('extractQuantityAndName: "several burgers" (no "plates of") resolves to quantity 4', () => {
  const { quantity, name } = extractQuantityAndName('several burgers');
  assert.equal(quantity, 4);
  assert.equal(name, 'burgers');
});

test('extractQuantityAndName: "several plates of rice" still resolves via the plate pattern (no regression)', () => {
  const { quantity, name } = extractQuantityAndName('several plates of rice');
  assert.equal(quantity, 4);
  assert.equal(name, 'rice');
});

test('extractQuantityAndName: ordinary "a burger" is unaffected — still defaults to quantity 1 (no regression)', () => {
  const { quantity, name } = extractQuantityAndName('a burger');
  assert.equal(quantity, 1);
  assert.equal(name, 'burger');
});

test('extractQuantityAndName: "2 burgers" (digit quantity) is unaffected (no regression)', () => {
  const { quantity, name } = extractQuantityAndName('2 burgers');
  assert.equal(quantity, 2);
  assert.equal(name, 'burgers');
});

test('parseNaturalOrderMessage: "a dozen donuts" produces a cart line with quantity 12 against a real menu', () => {
  const menu = [
    { _id: '1', name: 'Donut', keywords: [] },
    { _id: '2', name: 'Burger', keywords: [] },
  ];
  const result = parseNaturalOrderMessage(menu, 'a dozen donuts');
  assert.ok(result);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].quantity, 12);
  assert.equal(result.lines[0].item.name, 'Donut');
});

test('parseNaturalOrderMessage: "hi I want a couple of burgers please" — greeting/intent lead-in AND quantity phrase both strip correctly', () => {
  const menu = [
    { _id: '1', name: 'Burger', keywords: [] },
  ];
  const result = parseNaturalOrderMessage(menu, 'hi I want a couple of burgers please');
  assert.ok(result);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].quantity, 2);
  assert.equal(result.lines[0].item.name, 'Burger');
});
