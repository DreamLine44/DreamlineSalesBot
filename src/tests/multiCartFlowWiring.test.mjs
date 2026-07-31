// tests/multiCartFlowWiring.test.mjs
//
// [MULTICART-FLOW-1] Regression tests for the restaurant orderFlow.js wiring
// that lets a customer order multiple different items in one typed message
// (e.g. "2 burgers and a coke"), reusing the parser in
// utils/multiItemParser.js (see multiItemParser.test.mjs for its own
// coverage) and the real items[] persistence contract already established in
// services/orderService.js ([MULTICART-v39]/[FIX-CATALOG-CART-2]).
//
// orderFlow.js pulls in Mongoose models and session/dispatch services that
// are not safe to exercise end-to-end without a live Mongo connection and
// Express app context — consistent with how v18FlowSystemAudit.test.mjs /
// v19FlowsAudit.test.mjs / v22RestaurantFlowAudit.test.mjs already test this
// same file, these are source-text guards.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const orderFlowSrc  = read('../modules/restaurant/flows/orderFlow.js');
const uiBuildersSrc = read('../modules/restaurant/handlers/uiBuilders.js');

test('orderFlow.js imports the multi-item parser and the cart UI builders', () => {
  assert.match(orderFlowSrc, /extractCartLines.*from ['"]\.\.\/\.\.\/\.\.\/utils\/multiItemParser\.js['"]/);
  assert.match(orderFlowSrc, /buildCartSummaryUI/);
  assert.match(orderFlowSrc, /buildCartOrderSummary/);
  assert.match(orderFlowSrc, /buildCartOrderSuccess/);
});

test('SELECT_ITEM tries multi-item parsing BEFORE the single-item fuzzy match, gated on 2+ matches', () => {
  const selectStart = orderFlowSrc.indexOf("case 'SELECT_ITEM'");
  const fuzzyIdx     = orderFlowSrc.indexOf('findBestMatch(menu, clean)', selectStart);
  const cartParseIdx = orderFlowSrc.indexOf('extractCartLines(raw, menu)', selectStart);

  assert.ok(selectStart !== -1, 'SELECT_ITEM case not found');
  assert.ok(cartParseIdx !== -1, 'expected extractCartLines() call inside SELECT_ITEM');
  assert.ok(fuzzyIdx !== -1, 'expected the original findBestMatch() call to still be present');
  assert.ok(cartParseIdx < fuzzyIdx, 'cart parsing must run before the single-item fuzzy match, not after');

  const gateSlice = orderFlowSrc.slice(cartParseIdx, fuzzyIdx);
  assert.match(gateSlice, /matchedCount\s*>=\s*2/, 'cart branch must require 2+ distinct matched items — a single match should fall through unchanged to findBestMatch()');
});

test('a CART_REVIEW step exists and handles checkout, add-more, and merging new lines', () => {
  const start = orderFlowSrc.indexOf("case 'CART_REVIEW'");
  assert.ok(start !== -1, 'CART_REVIEW case not found');
  const body = orderFlowSrc.slice(start, start + 2000);

  assert.match(body, /wantsCheckout/);
  assert.match(body, /step:\s*'CONFIRM'/, 'checkout must hand off to the existing CONFIRM step');
  assert.match(body, /wantsAddMore/);
  assert.match(body, /_mergeCartLines/, 'new items typed mid-review must merge into the existing cart, not replace it');
});

test('_mergeCartLines sums quantities for a repeated item instead of duplicating the line', () => {
  const start = orderFlowSrc.indexOf('function _mergeCartLines');
  assert.ok(start !== -1, '_mergeCartLines helper not found');
  const body = orderFlowSrc.slice(start, start + 700);
  assert.match(body, /existing\.quantity\s*\+=/, 'expected quantities to be summed for a repeated item');
});

test('CONFIRM step saves cart orders through the real items[] contract, not a duplicate persistence path', () => {
  const start = orderFlowSrc.indexOf("case 'CONFIRM'");
  assert.ok(start !== -1, 'CONFIRM case not found');
  const body = orderFlowSrc.slice(start, start + 3500);

  assert.match(body, /const isCart = Array\.isArray\(data\.cart\)/);
  assert.match(body, /items:\s*isCart/, 'saveOrder() call must pass items[] when isCart, mirroring resolveOrderFields()\'s contract');
  assert.match(body, /unitPrice:\s*typeof l\.item\.price === 'number' \? l\.item\.price : undefined/, 'partial/missing pricing must be passed through as undefined, not coerced to 0 (0 would silently corrupt resolveOrderFields()\'s all-priced total check)');
});

test('CONFIRM step falls back to the original single-item saveOrder() call shape when there is no cart', () => {
  const start = orderFlowSrc.indexOf("case 'CONFIRM'");
  const body  = orderFlowSrc.slice(start, start + 2500);
  assert.match(body, /item:\s*isCart \? undefined : displayItem/);
  assert.match(body, /quantity:\s*isCart \? undefined : data\.quantity/);
});

test('uiBuilders.js exports the new cart UI builders alongside the original single-item ones', () => {
  assert.match(uiBuildersSrc, /export function buildCartSummaryUI/);
  assert.match(uiBuildersSrc, /export function buildCartOrderSummary/);
  assert.match(uiBuildersSrc, /export function buildCartOrderSuccess/);
  // Original single-item builders must still be present, untouched.
  assert.match(uiBuildersSrc, /export function buildOrderSummary/);
  assert.match(uiBuildersSrc, /export function buildOrderSuccess/);
});

test('buildCartOrderSuccess does not re-prefix an outer quantity onto an items label that already carries per-line quantities', () => {
  const start = uiBuildersSrc.indexOf('export function buildCartOrderSuccess');
  assert.ok(start !== -1);
  const body = uiBuildersSrc.slice(start, start + 400);
  // Regression guard: buildOrderSuccess's `${quantity}× ${name}` pattern must
  // NOT appear here — a cart label like "2× Burger, 1× Coke" would otherwise
  // get wrongly double-prefixed as "1× 2× Burger, 1× Coke".
  assert.doesNotMatch(body, /\$\{qty/i);
});
