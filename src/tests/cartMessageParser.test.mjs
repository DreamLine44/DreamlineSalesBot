// tests/cartMessageParser.test.mjs
//
// [AUDIT-FIX-GREETING-LEADIN] Regression tests for core/nlu/resolution/
// cartMessageParser.js's lead-in stripping.
//
// BUG: parseNaturalOrderMessage() and parseMultiItemMessage() stripped
// order-intent filler ("I want", "can I get") but never a leading greeting
// ("hi", "hello", "good morning"). extractQuantityAndName()'s
// leading-quantity regex requires the quantity token to sit at the very
// start of the (sub)string, so a message like:
//
//   "hi I want to order two plates of Domoda and a plate of denachin"
//
// left "hi I want to order two" in front of "plates of Domoda" — the
// quantity regex never matched, so quantity silently defaulted to 1 even
// though the item itself still fuzzy-matched via findBestMatch's substring
// rule (the garbled string still *contains* "Domoda"). The customer's
// actual "two" was dropped with no error, no warning, nothing — a silent
// data-corruption bug, not a hard failure, which is why it wasn't caught by
// the existing multi-item cart tests (none of which prefixed a greeting).
//
// FIX: stripOrderLeadIn() (greeting + order-intent phrases, looped so
// stacked lead-ins fully resolve) now runs inside both parsing functions,
// so every caller gets correct quantity extraction regardless of whether
// the message arrives pre-stripped or completely raw off the webhook.
//
// Pure-function tests only — consistent with matchEngine.js/
// multiItemCartOrderService.test.mjs's isolation rationale.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripOrderLeadIn,
  extractQuantityAndName,
  parseNaturalOrderMessage,
  parseMultiItemMessage,
} from '../core/nlu/resolution/cartMessageParser.js';

const menu = [
  { _id: '1', name: 'Domoda', keywords: [] },
  { _id: '2', name: 'Benachin', keywords: [] },
  { _id: '3', name: 'Yassa Chicken', keywords: [] },
  { _id: '4', name: 'Mac and Cheese', keywords: [] },
];

// ── stripOrderLeadIn ─────────────────────────────────────────────────────

test('stripOrderLeadIn removes a leading greeting', () => {
  assert.equal(stripOrderLeadIn('hi two plates of Domoda'), 'two plates of Domoda');
  assert.equal(stripOrderLeadIn('hello, two plates of Domoda'), 'two plates of Domoda');
  assert.equal(stripOrderLeadIn('good morning two plates of Domoda'), 'two plates of Domoda');
});

test('stripOrderLeadIn removes a stacked greeting + intent phrase in one pass', () => {
  assert.equal(
    stripOrderLeadIn('hi I want to order two plates of Domoda'),
    'two plates of Domoda',
  );
  assert.equal(
    stripOrderLeadIn('hi, please can I get two Domoda'),
    'two Domoda',
  );
});

test('stripOrderLeadIn handles the "I\'d like" contraction, not just "I would like"', () => {
  assert.equal(stripOrderLeadIn("I'd like two Domoda"), 'two Domoda');
  assert.equal(stripOrderLeadIn('I would like two Domoda'), 'two Domoda');
});

test('stripOrderLeadIn strips trailing politeness', () => {
  assert.equal(stripOrderLeadIn('two Domoda please'), 'two Domoda');
  assert.equal(stripOrderLeadIn('two Domoda, thanks'), 'two Domoda');
});

test('stripOrderLeadIn removes "hey there" without eating a real item name', () => {
  assert.equal(stripOrderLeadIn('hey there two Domoda'), 'two Domoda');
  assert.equal(stripOrderLeadIn('Hibiscus tea'), 'Hibiscus tea', '"Hi" must not be stripped out of "Hibiscus"');
});

test('stripOrderLeadIn is a no-op on a plain item message', () => {
  assert.equal(stripOrderLeadIn('two plates of Domoda'), 'two plates of Domoda');
  assert.equal(stripOrderLeadIn('Domoda'), 'Domoda');
});

// ── extractQuantityAndName (post-strip) ─────────────────────────────────

test('extractQuantityAndName still reads the leading quantity once the greeting is gone', () => {
  const { quantity, name } = extractQuantityAndName(stripOrderLeadIn('hi two plates of Domoda'));
  assert.equal(quantity, 2);
  assert.equal(name, 'Domoda');
});

// ── parseNaturalOrderMessage (single item) ──────────────────────────────

test('parseNaturalOrderMessage: a greeting no longer swallows the quantity', () => {
  const result = parseNaturalOrderMessage(menu, 'hi I want two plates of Domoda');
  assert.ok(result, 'expected a match');
  assert.equal(result.lines[0].quantity, 2, 'quantity must be 2, not silently default to 1');
  assert.equal(result.lines[0].item.name, 'Domoda');
});

test('parseNaturalOrderMessage: still works with no greeting at all (no regression)', () => {
  const result = parseNaturalOrderMessage(menu, 'two plates of Domoda');
  assert.equal(result.lines[0].quantity, 2);
  assert.equal(result.lines[0].item.name, 'Domoda');
});

test('parseNaturalOrderMessage: item names containing "and" still resolve as one item', () => {
  const result = parseNaturalOrderMessage(menu, 'mac and cheese');
  assert.ok(result);
  assert.equal(result.lines[0].item.name, 'Mac and Cheese');
});

// ── parseMultiItemMessage (multi item) ───────────────────────────────────

test('parseMultiItemMessage: reported bug — greeting + multi-item message keeps correct quantities', () => {
  const result = parseMultiItemMessage(
    menu,
    'hi I want to order two plates of Domoda and a plate of denachin',
  );
  assert.ok(result, 'expected a multi-item match');
  assert.equal(result.lines.length, 2);

  const domoda = result.lines.find(l => l.item.name === 'Domoda');
  assert.ok(domoda, 'Domoda line must be present');
  assert.equal(domoda.quantity, 2, 'quantity must be 2, not silently default to 1');

  const benachin = result.lines.find(l => l.item.name === 'Benachin');
  assert.ok(benachin, '"denachin" must still fuzzy-resolve to Benachin');
  assert.equal(benachin.quantity, 1);
});

test('parseMultiItemMessage: stacked "hi, please can I get X and Y, thanks" resolves both lines', () => {
  const result = parseMultiItemMessage(menu, 'hi, please can I get two Domoda and a Benachin, thanks');
  assert.ok(result);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines.find(l => l.item.name === 'Domoda').quantity, 2);
  assert.equal(result.lines.find(l => l.item.name === 'Benachin').quantity, 1);
});

test('parseMultiItemMessage: still returns null for an ordinary single-item message (no regression)', () => {
  assert.equal(parseMultiItemMessage(menu, 'two plates of Domoda'), null);
  assert.equal(parseMultiItemMessage(menu, 'hi, two plates of Domoda'), null);
});

test('parseMultiItemMessage: item names containing "and" are not wrongly split (no regression)', () => {
  assert.equal(parseMultiItemMessage(menu, 'mac and cheese'), null);
});
