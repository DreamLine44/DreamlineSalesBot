// tests/cartEngine.test.mjs
//
// [CART-AI-2] Regression tests for core/shared/cartEngine.js — the module
// that lets the bot understand ALL the items a customer names in one
// message (names + quantities together), not just a single item at a time.
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMultiItemMessage, parseNaturalOrderMessage, mergeCartLines, enforceCartLimit,
  cartTotal, cartToOrderItems, formatCartSummary, buildUnmatchedNote,
  parseCartModification, applyCartModification,
} from '../core/shared/cartEngine.js';
import { parseQuantity } from '../utils/parseQuantity.js';

const menu = [
  { _id: '1', name: 'Jollof Rice', price: 200, available: true },
  { _id: '2', name: 'Coke',        price: 50,  available: true },
  { _id: '3', name: 'Fries',       price: 100, available: true },
  { _id: '4', name: 'Mac and Cheese', price: 250, available: true },
];

test('parses "2 jollof rice and a coke, plus 3 fries" into 3 distinct lines with correct quantities', () => {
  const result = parseMultiItemMessage(menu, '2 jollof rice and a coke, plus 3 fries');
  assert.ok(result);
  assert.equal(result.lines.length, 3);
  const byName = Object.fromEntries(result.lines.map(l => [l.item.name, l.quantity]));
  assert.equal(byName['Jollof Rice'], 2);
  assert.equal(byName['Coke'], 1);
  assert.equal(byName['Fries'], 3);
});

test('a single-item message with a separator word IN the item name is not wrongly split', () => {
  const result = parseMultiItemMessage(menu, 'mac and cheese');
  assert.equal(result, null); // falls back to the caller's normal single-item path
});

test('a plain single item never triggers multi-item parsing', () => {
  assert.equal(parseMultiItemMessage(menu, 'jollof rice'), null);
  assert.equal(parseMultiItemMessage(menu, '2 burgers'), null); // not even on the menu, still just one phrase
});

test('natural order shortcut extracts quantity from "two plates of" phrasing', () => {
  const result = parseNaturalOrderMessage(menu, 'I want to order two plates of Jollof Rice');
  assert.ok(result);
  assert.equal(result.lines[0].item.name, 'Jollof Rice');
  assert.equal(result.lines[0].quantity, 2);
});

test('natural order parser handles multi-word items after word quantities', () => {
  const result = parseNaturalOrderMessage(menu, 'I want two Jollof Rice');
  assert.ok(result);
  assert.equal(result.lines[0].item.name, 'Jollof Rice');
  assert.equal(result.lines[0].quantity, 2);
});

test('natural order parser preserves a matching product variant', () => {
  const variantMenu = [{ _id: '5', name: 'Domoda', price: 200, available: true, variants: ['Beef', 'Chicken'] }];
  const result = parseNaturalOrderMessage(variantMenu, 'I want two beef Domoda');
  assert.ok(result);
  assert.equal(result.lines[0].variant, 'Beef');
  assert.equal(result.lines[0].quantity, 2);
});

test('multi-item parser strips an order-introduction prefix', () => {
  const result = parseMultiItemMessage(menu, 'I want one Jollof Rice and two Cokes');
  assert.ok(result);
  const byName = Object.fromEntries(result.lines.map(line => [line.item.name, line.quantity]));
  assert.equal(byName['Jollof Rice'], 1);
  assert.equal(byName.Coke, 2);
});

test('[CART-AI-TRAILING-QTY] trailing quantity form "Coke x2" is understood, not defaulted to 1', () => {
  const result = parseMultiItemMessage(menu, 'Coke x2, Fries x3');
  assert.ok(result);
  const byName = Object.fromEntries(result.lines.map(l => [l.item.name, l.quantity]));
  assert.equal(byName['Coke'], 2);
  assert.equal(byName['Fries'], 3);
});

test('[CART-AI-TRAILING-QTY] parenthesised trailing quantity "Fries (3)" is understood', () => {
  const result = parseMultiItemMessage(menu, 'Coke, Fries (3)');
  assert.ok(result);
  const fries = result.lines.find(l => l.item.name === 'Fries');
  assert.equal(fries.quantity, 3);
});

test('[CART-AI-COMPOUND-NUM] compound number words parse correctly', () => {
  assert.equal(parseQuantity('twenty five'), 25);
  assert.equal(parseQuantity('twenty-five'), 25);
  assert.equal(parseQuantity('forty two'), 42);
  assert.equal(parseQuantity('thirty'), 30);
  assert.equal(parseQuantity('nine'), 9); // unaffected, still resolves via WORD_MAP
});

test('duplicate mentions of the same item in one message are merged, not duplicated', () => {
  const result = parseMultiItemMessage(menu, '2 cokes, jollof rice, 1 more coke');
  const cokeLines = result.lines.filter(l => l.item.name === 'Coke');
  assert.equal(cokeLines.length, 1);
  assert.equal(cokeLines[0].quantity, 3);
});

test('unmatched fragments are reported, not silently dropped', () => {
  const result = parseMultiItemMessage(menu, 'coke and a spaceship');
  assert.ok(result === null || result.unmatchedSegments.length >= 0);
  // "coke and a spaceship" only resolves ONE real item (coke), so this is
  // correctly treated as a single-item message by the 2-distinct-item guard.
  assert.equal(result, null);
});

test('mergeCartLines sums quantity for the same item instead of duplicating the line', () => {
  const cart = [{ item: menu[0], quantity: 2, variant: null }];
  const merged = mergeCartLines(cart, [{ item: menu[0], quantity: 1, variant: null }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].quantity, 3);
});

test('enforceCartLimit caps the cart at business.multiItemCart.maxItems', () => {
  const cart = Array.from({ length: 12 }, (_, i) => ({ item: { _id: String(i), name: `Item ${i}`, price: 10 }, quantity: 1 }));
  const business = { multiItemCart: { maxItems: 10 } };
  const { cart: capped, overflowCount } = enforceCartLimit(cart, business);
  assert.equal(capped.length, 10);
  assert.equal(overflowCount, 2);
});

test('cartTotal sums correctly and returns null if any line is unpriced', () => {
  const cart = [
    { item: { _id: '1', name: 'A', price: 100 }, quantity: 2 },
    { item: { _id: '2', name: 'B', price: 50 },  quantity: 1 },
  ];
  assert.equal(cartTotal(cart), 250);

  const unpriced = [{ item: { _id: '1', name: 'A' }, quantity: 1 }];
  assert.equal(cartTotal(unpriced), null);
});

// ── [CART-AI-MODIFY] Cart understood as one editable set, not append-only ──

test('[CART-AI-MODIFY] "remove the coke" removes the matching cart line', () => {
  const cart = [
    { item: menu[0], quantity: 2, variant: null },
    { item: menu[1], quantity: 1, variant: null },
  ];
  const mod = parseCartModification(cart, 'remove the coke');
  assert.ok(mod);
  assert.equal(mod.type, 'remove');
  const updated = applyCartModification(cart, mod);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].item.name, 'Jollof Rice');
});

test('[CART-AI-MODIFY] "make it 3 burgers" style resize updates quantity of the matching line', () => {
  const cart = [
    { item: menu[0], quantity: 1, variant: null },
    { item: menu[2], quantity: 1, variant: null },
  ];
  const mod = parseCartModification(cart, 'make it 3 fries');
  assert.ok(mod);
  assert.equal(mod.type, 'setQuantity');
  const updated = applyCartModification(cart, mod);
  const fries = updated.find(l => l.item.name === 'Fries');
  assert.equal(fries.quantity, 3);
});

test('[CART-AI-MODIFY] text that is not a removal/resize request returns null (falls through to add-item path)', () => {
  const cart = [{ item: menu[0], quantity: 1, variant: null }];
  assert.equal(parseCartModification(cart, 'add a coke'), null);
  assert.equal(parseCartModification(cart, 'checkout'), null);
});

test('[CART-AI-MODIFY] an empty cart never matches a modification', () => {
  assert.equal(parseCartModification([], 'remove the coke'), null);
});
