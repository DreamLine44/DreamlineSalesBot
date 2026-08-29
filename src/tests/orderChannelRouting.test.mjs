// tests/orderChannelRouting.test.mjs
//
// Regression: customers who tap "Browse Catalog" must stay on the catalog path
// for follow-up "New Order" taps — including MANUAL_ONLY tenants where automatic
// catalog offers are disabled.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('Session model persists orderChannel across flow completion', () => {
  const src = readSource('../models/Session.js');
  assert.match(src, /orderChannel/);
});

test('sendAndArmCatalog sets orderChannel to catalog', () => {
  const src = readSource('../modules/catalog/waCatalogFlow.js');
  assert.match(src, /orderChannel:\s*'catalog'/);
});

test('START_ORDER honors session.orderChannel === catalog before offerCatalogOnStartOrder', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_ORDER'");
  const end = src.indexOf("registerAction('START_BOOKING'");
  const body = src.slice(start, end);
  const catalogIdx = body.indexOf("orderChannel === 'catalog'");
  const offerIdx = body.indexOf('offerCatalogOnStartOrder(');
  assert.ok(catalogIdx !== -1, 'START_ORDER must check persisted catalog channel');
  assert.ok(offerIdx !== -1, 'START_ORDER must still call offerCatalogOnStartOrder');
  assert.ok(catalogIdx < offerIdx, 'catalog channel check must run before automatic offer logic');
});

test('START_ORDER sends resolved NLU products directly to the existing cart review step', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_ORDER'");
  const block = src.slice(start, src.indexOf("registerAction('START_BOOKING'", start));
  const nluBranch = block.indexOf('const nluProducts = session?.data?._nluPending?.products;');
  assert.ok(nluBranch !== -1, 'START_ORDER must inspect resolved NLU products');
  assert.match(block.slice(nluBranch, nluBranch + 1300), /step: 'CONFIRM'/);
  assert.match(block.slice(nluBranch, nluBranch + 1500), /advance\(/);
});

test('START_BOOKING has a direct all-in-one booking path for party, date, and time', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_BOOKING'");
  const end = src.indexOf("registerAction('WALKIN'", start);
  const block = src.slice(start, end);
  assert.match(block, /parseDirectBookingRequest/);
  assert.match(block, /resolveDirectBookingStep/);
  assert.match(block, /advance\(/);
});

test('START_ORDER applies free-text cart modifications before starting a new order flow', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_ORDER'");
  const block = src.slice(start, src.indexOf("registerAction('START_BOOKING'", start));
  assert.match(block, /parseCartModification/);
  assert.match(block, /applyCartModification/);
  assert.match(block, /existingCart/);
});

test('START_ORDER has safe handoffs for product modes with required next steps', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  assert.match(src, /function directOrderHandoff/);
  assert.match(src, /case 'RETAIL':/);
  assert.match(src, /case 'DELIVERY':/);
  assert.match(src, /case 'ELECTRONICS':/);
  assert.match(src, /case 'FASHION':/);
  assert.match(src, /SELECT_VARIANT|SELECT_SIZE|DELIVERY_ADDRESS|ITEM_DETAIL/);
});

test('webhook accepts named buttons produced by natural-order clarification', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.match(src, /pendingNaturalCandidate/);
  assert.match(src, /!pendingNaturalCandidate/);
});

test('webhook consumes pending natural-order selections before generic flow routing', () => {
  const src = readSource('../controllers/webhookController.js');
  const active = src.indexOf('// ── 15. Active flow');
  const collision = src.indexOf('[FIX-LISTNAV-ORDER-COLLISION]', active);
  const block = src.slice(active, collision);
  assert.match(block, /pendingNaturalQuantity/);
  assert.match(block, /mergeCartLines/);
  assert.match(block, /step: 'CONFIRM'/);
  assert.match(block, /message: null/);
});

test('postFlowHandler: status commands fall through instead of generic menu', () => {
  const src = readSource('../services/postFlowHandler.js');
  assert.match(src, /isStatusCommand\(msg\)/);
  assert.match(src, /return false/);
});

test('activityStatusService: isStatusCommand recognises track phrases', async () => {
  const { isStatusCommand } = await import('../services/activity/activityStatusService.js');
  assert.equal(isStatusCommand('track my order'), true);
  assert.equal(isStatusCommand('track my booking'), true);
  assert.equal(isStatusCommand('hello'), false);
});

test('detectIntent: ORDER button tap returns semantic intent ORDER (not START_ORDER)', async () => {
  const { detectIntent } = await import('../core/intents/intentEngine.js');
  const result = await detectIntent({
    message: 'ORDER',
    isInteractive: true,
    session: { currentFlow: null },
    business: { businessMode: 'RESTAURANT' },
  });
  assert.equal(result.action, 'START_ORDER');
  assert.equal(result.intent, 'ORDER');
  assert.equal(result.source, 'button');
});

test('START_ORDER: explicit ORDER/NEW_ORDER tap opens browseCatalogExplicit for catalog tenants', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_ORDER'");
  const end = src.indexOf("registerAction('START_BOOKING'");
  const body = src.slice(start, end);
  assert.match(body, /explicitOrderTap/);
  assert.match(body, /browseCatalogExplicit/);
  assert.ok(body.indexOf('explicitOrderTap') < body.indexOf('offerCatalogOnStartOrder'), 'explicit ORDER tap must route to catalog before automatic offer logic');
});
