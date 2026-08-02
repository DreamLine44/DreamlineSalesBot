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
  const catalogIdx = body.indexOf("session?.orderChannel === 'catalog'");
  const offerIdx = body.indexOf('offerCatalogOnStartOrder(');
  assert.ok(catalogIdx !== -1, 'START_ORDER must check persisted catalog channel');
  assert.ok(offerIdx !== -1, 'START_ORDER must still call offerCatalogOnStartOrder');
  assert.ok(catalogIdx < offerIdx, 'catalog channel check must run before automatic offer logic');
});

test('postFlowHandler: status commands fall through instead of generic menu', () => {
  const src = readSource('../services/postFlowHandler.js');
  assert.match(src, /isStatusCommand\(msg\)/);
  assert.match(src, /return false/);
});

test('activityStatusService: isStatusCommand recognises track phrases', async () => {
  const { isStatusCommand } = await import('../services/activityStatusService.js');
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
