// tests/orderSummaryPolish.test.mjs
//
// [AUDIT-FIX-ORDER-POLISH-*] Regression tests for the restaurant checkout
// polish pass (item review by an external collaborator, screenshots of a
// duplicate-item bug and a few messaging gaps).
//
// Findings when auditing against that review:
//  - Duplicate cart lines / premature order creation / order-created-before-
//    confirm were ALREADY fixed in this codebase (mergeCartLines +
//    handleMultiItemCatalogOrder routing through the module's own CONFIRM
//    step — see modules/catalog/waCatalogFlow.js's [FIX-CATALOG-CART-CONFIRM]
//    comment). Verified directly below rather than re-fixed.
//  - Genuinely missing: item count on the review screen and in messages,
//    a labeled phone display, and a Reference/Status line in the customer's
//    own order-confirmed message (previously only the admin got a reference
//    number).
//
// Run with: node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCartLines, formatCartSummary, cartItemCount, parseNaturalOrderMessage, cartTotal } from '../core/shared/cartEngine.js';
import { formatPhoneDisplay } from '../utils/formatPhone.js';
import { buildCartReviewUI } from '../modules/restaurant/handlers/uiBuilders.js';

test('duplicate catalog lines for the same item are merged into one summed line (already fixed, not regressed)', () => {
  const item = { _id: 'abc123', name: 'Superkanja', price: 150 };
  const newLines = [
    { item, quantity: 1, variant: null, addOns: [] },
    { item, quantity: 1, variant: null, addOns: [] },
  ];
  const merged = mergeCartLines([], newLines);
  assert.equal(merged.length, 1, 'two lines for the same item should merge into one');
  assert.equal(merged[0].quantity, 2, 'quantities should be summed');
  assert.equal(formatCartSummary(merged, { payment: { currency: 'D' } }), '2× Superkanja — D300');
});

test('buildCartReviewUI shows an Items count line when itemCount is provided', () => {
  const ui = buildCartReviewUI({
    summaryText: '2× Superkanja — D300\n1× Akara — D50',
    total: 350,
    itemCount: 3,
    business: { payment: { currency: 'D' } },
  });
  assert.match(ui.body, /Items:\s*\*?3\*?/, 'should show the total item count');
});

test('buildCartReviewUI omits the Items line when itemCount is not provided (backwards compatible)', () => {
  const ui = buildCartReviewUI({
    summaryText: '1× Akara — D50',
    total: 50,
    business: { payment: { currency: 'D' } },
  });
  assert.doesNotMatch(ui.body, /Items:/);
});

test('formatPhoneDisplay labels a raw phone number instead of showing bare digits', () => {
  const out = formatPhoneDisplay('2203532423');
  assert.notEqual(out, '2203532423', 'should not just echo the raw digits');
  assert.match(out, /2203532423/);
});

test('formatPhoneDisplay handles missing input without throwing', () => {
  assert.equal(formatPhoneDisplay(null), '');
  assert.equal(formatPhoneDisplay(undefined), '');
  assert.equal(formatPhoneDisplay(''), '');
});

test('cartItemCount sums quantities across lines (used to populate the new Items line)', () => {
  const cart = [
    { item: { _id: '1', price: 10 }, quantity: 2 },
    { item: { _id: '2', price: 5 },  quantity: 3 },
  ];
  assert.equal(cartItemCount(cart), 5);
});

test('direct natural-language order renders the concise confirmation summary', () => {
  const menu = [{ _id: 'yassa-1', name: 'Yassa Chicken', price: 200, available: true }];
  const parsed = parseNaturalOrderMessage(menu, 'I want to order two plates of Yassa Chicken');
  assert.ok(parsed?.lines?.length);

  const ui = buildCartReviewUI({
    summaryText: formatCartSummary(parsed.lines, { payment: { currency: 'GMD' } }),
    total: cartTotal(parsed.lines),
    itemCount: cartItemCount(parsed.lines),
    business: { payment: { currency: 'GMD' } },
  });

  assert.equal(
    ui.body,
    '🧾 *Order Summary*\n\n' +
    '2× Yassa Chicken — GMD400\n' +
    '━━━━━━━━━━\n' +
    'Items: *2*\n' +
    'Total: *GMD400*\n\n' +
    'Would you like to confirm this order?',
  );
  assert.deepEqual(ui.buttons.map(button => button.id), ['CONFIRM', 'ADD_MORE_ITEMS', 'CANCEL']);
});
