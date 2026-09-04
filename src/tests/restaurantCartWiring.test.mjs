// tests/restaurantCartWiring.test.mjs
//
// [MULTICART-v40] Regression tests confirming modules/restaurant/flows/orderFlow.js
// is wired into the shared cart engine and uses ITEM_ADDED → CONFIRM (not the
// bakery/cosmetics CART_REVIEW pattern). Source-text guards — same technique
// as bakeryCartWiring.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const orderFlowSrc = read('../modules/restaurant/flows/orderFlow.js');
const configSrc    = read('../modules/restaurant/configs/index.js');
const catalogSrc   = read('../modules/catalog/waCatalogFlow.js');

test('restaurant orderFlow.js imports the shared cart engine', () => {
  assert.match(orderFlowSrc, /from ['"]\.\.\/\.\.\/\.\.\/core\/shared\/cartEngine\.js['"]/);
  for (const fn of [
    'parseMultiItemMessage', 'mergeCartLines', 'enforceCartLimit',
    'cartTotal', 'cartToOrderItems', 'formatCartSummary',
    'parseCartModification', 'applyCartModification',
  ]) {
    assert.ok(orderFlowSrc.includes(fn), `expected orderFlow.js to use ${fn}`);
  }
});

test('SELECT_ITEM tries parseMultiItemMessage and routes multi-line to ITEM_ADDED', () => {
  const block = orderFlowSrc.slice(
    orderFlowSrc.indexOf("case 'SELECT_ITEM'"),
    orderFlowSrc.indexOf("case 'SUGGESTION_CONFIRM'"),
  );
  assert.match(block, /parseMultiItemMessage\(menu, raw\)/);
  assert.match(block, /step:\s*'ITEM_ADDED'/);
  assert.doesNotMatch(block, /step:\s*'CART_REVIEW'/);
});

test('ITEM_ADDED supports review checkout and add-more paths', () => {
  const block = orderFlowSrc.slice(
    orderFlowSrc.indexOf("case 'ITEM_ADDED'"),
    orderFlowSrc.indexOf("case 'QUANTITY'"),
  );
  assert.match(block, /REVIEW_CART/);
  assert.match(block, /ADD_ANOTHER_ITEM/);
  assert.match(block, /step:\s*'CONFIRM'/);
});

test('CONFIRM accepts both ADD_MORE_ITEMS and ADD_ANOTHER_ITEM for add-more', () => {
  const block = orderFlowSrc.slice(
    orderFlowSrc.indexOf("case 'CONFIRM'"),
    orderFlowSrc.indexOf("case 'EDIT_CART_MENU'"),
  );
  assert.match(block, /ADD_MORE_ITEMS/);
  assert.match(block, /ADD_ANOTHER_ITEM/);
  assert.match(block, /_checkoutCart/);
});

test('legacy CONFIRM_ORDER button remains wired to the active order flow', () => {
  const webhookSrc = read('../controllers/webhookController.js');
  const patternsSrc = read('../core/nlu/classification/patterns.js');
  assert.match(webhookSrc, /'CONFIRM_ORDER'/);
  assert.match(patternsSrc, /'CONFIRM_ORDER':\s*'CONFIRM'/);
  assert.match(orderFlowSrc, /confirm_order/);
});

test('webhook refreshes the session before deciding whether a flow is active', () => {
  const webhookSrc = read('../controllers/webhookController.js');
  const activeFlowIndex = webhookSrc.indexOf('// ── 15. Active flow');
  const refreshIndex = webhookSrc.indexOf('session = await getSession(from, tenantId) || session;', activeFlowIndex);
  const gateIndex = webhookSrc.indexOf('if (session.currentFlow)', activeFlowIndex);
  assert.ok(refreshIndex >= 0 && refreshIndex < gateIndex,
    'the active-flow gate must use a freshly loaded session');
});

test('webhook restores ORDER/CONFIRM when a confirm tap finds a cart without currentFlow', () => {
  const webhookSrc = read('../controllers/webhookController.js');
  const activeFlowIndex = webhookSrc.indexOf('// ── 15. Active flow');
  const block = webhookSrc.slice(activeFlowIndex, activeFlowIndex + 2600);
  assert.match(block, /CONFIRM_ORDER/);
  assert.match(block, /session\.data\?\.cart/);
  assert.match(block, /currentFlow:\s*'ORDER'/);
  assert.match(block, /step:\s*'CONFIRM'/);
  assert.match(block, /advance\(/);
});

test('router has a final CONFIRM recovery instead of treating it as an unknown welcome action', () => {
  const routerSrc = read('../core/conversations/moduleRouter.js');
  assert.match(routerSrc, /recoverConfirmAction/);
  assert.match(routerSrc, /upper === 'CONFIRM' \|\| upper === 'CONFIRM_ORDER'/);
  assert.match(routerSrc, /advance\(/);
  assert.match(routerSrc, /order session has expired/);
});

test('restaurant config documents ITEM_ADDED, not CART_REVIEW', () => {
  assert.match(configSrc, /ORDER:\s*\[[^\]]*'ITEM_ADDED'[^\]]*\]/);
  assert.doesNotMatch(configSrc, /ORDER:\s*\[[^\]]*'CART_REVIEW'[^\]]*\]/);
});

test('resolveNextOrderStep for restaurant config returns QUANTITY (step after SELECT_ITEM)', async () => {
  const { resolveNextOrderStep } = await import('../modules/catalog/waCatalogHelpers.js');
  const { RESTAURANT_CONFIG } = await import('../modules/restaurant/configs/index.js');
  assert.equal(resolveNextOrderStep(RESTAURANT_CONFIG), 'QUANTITY');
});

test('default step handler logs and recovers instead of silent buildMenuUI', () => {
  assert.match(orderFlowSrc, /\[RestaurantOrderFlow\] Unhandled step/);
  assert.match(orderFlowSrc, /REVIEW_CART/);
  assert.doesNotMatch(
    orderFlowSrc.slice(orderFlowSrc.lastIndexOf('default:')),
    /default:\s*\n\s*return buildMenuUI\(business\)/,
  );
});

test('drainCatalogQueue consolidates queued lines into CONFIRM cart path', () => {
  assert.match(catalogSrc, /drainCatalogQueue[\s\S]*step:\s*'CONFIRM'/);
  assert.match(catalogSrc, /drainCatalogQueue[\s\S]*mergeCartLines/);
  assert.doesNotMatch(
    catalogSrc.slice(catalogSrc.indexOf('export async function drainCatalogQueue')),
    /resolveNextOrderStep/,
  );
});

test('handleMultiItemCatalogOrder merges with any existing session cart', () => {
  const block = catalogSrc.slice(
    catalogSrc.indexOf('async function handleMultiItemCatalogOrder'),
    catalogSrc.indexOf('export async function drainCatalogQueue'),
  );
  assert.match(block, /priorCart/);
  assert.match(block, /mergeCartLines\(priorCart/);
  assert.match(block, /orderViaCatalog:\s*true/);
});

test('catalog-sourced orders re-open WA Catalog on Add More via tryResumeCatalogShopping', () => {
  assert.match(catalogSrc, /export async function tryResumeCatalogShopping/);
  assert.match(catalogSrc, /orderViaCatalog/);
  assert.match(catalogSrc, /preserveCart:\s*true/);
  assert.match(orderFlowSrc, /_browseForMoreItems/);
  assert.match(orderFlowSrc, /tryResumeCatalogShopping/);
});

test('catalog-sourced cancel at CONFIRM uses cancelFlow', () => {
  const confirmBlock = orderFlowSrc.slice(
    orderFlowSrc.indexOf("case 'CONFIRM'"),
    orderFlowSrc.indexOf("case 'EDIT_CART_MENU'"),
  );
  assert.match(confirmBlock, /return cancelFlow\(session, business\)/);
});

test('empty-cart fallbacks route through _browseForMoreItems', () => {
  assert.match(orderFlowSrc, /if \(!cart\.length\) return await _browseForMoreItems/);
  assert.match(orderFlowSrc, /Your cart is now empty/);
});
