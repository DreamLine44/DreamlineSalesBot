// tests/auditFixCatalogStartOrderWiring.test.mjs
//
// Regression tests for [AUDIT-FIX-CATALOG-STARTORDER]:
//
//   modules/catalog/waCatalogFlow.js's offerCatalogOnStartOrder() was fully
//   implemented and documented as being called from moduleRegistry.js's
//   START_ORDER action override ("[CATALOG-REG-1]") — but that override never
//   actually called it. Same "implemented but unwired" bug class as
//   withCatalogWelcomeOption() ([AUDIT-FIX-CATALOG-WELCOME]).
//
//   The critical requirement driving the fix: tapping "🍔 Order Food" must
//   keep showing the View Menu list IMMEDIATELY, with no added delay and no
//   risk of a silent/dropped reply, for every tenant that hasn't explicitly
//   enabled WA Catalog (the default). shouldOfferCatalog() is a synchronous
//   field/array check with zero I/O for that case, so offerCatalogOnStartOrder
//   resolves instantly and moduleRegistry's START_ORDER handler falls straight
//   through to the same startFlow({ flowName: 'ORDER' }) call it always ran.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { offerCatalogOnStartOrder } from '../modules/catalog/waCatalogFlow.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

function makeSession(overrides = {}) {
  return { customerPhone: '+2201234567', tenantId: 't1', currentFlow: null, step: null, ...overrides };
}

// ── 1. Immediate, zero-I/O fallback for the default (non-catalog) case ─────

test('offerCatalogOnStartOrder: resolves to { offered: false } immediately for a business with no waCatalog config at all', async () => {
  const business = { menuItems: [{ name: 'Burger', available: true }] }; // no waCatalog field
  const result = await offerCatalogOnStartOrder({ session: makeSession(), business, tenant: {}, intent: 'ORDER' });
  assert.deepEqual(result, { offered: false });
});

test('offerCatalogOnStartOrder: resolves to { offered: false } when WA Catalog is explicitly disabled', async () => {
  const business = {
    waCatalog: { enabled: false, catalogId: 'CAT_1' },
    menuItems: [{ name: 'Burger', available: true }],
  };
  const result = await offerCatalogOnStartOrder({ session: makeSession(), business, tenant: {}, intent: 'ORDER' });
  assert.deepEqual(result, { offered: false });
});

test('offerCatalogOnStartOrder: resolves to { offered: false } when there are no sellable products', async () => {
  const business = {
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'ALWAYS_OFFER' },
    menuItems: [{ name: 'Burger', available: false }],
  };
  const result = await offerCatalogOnStartOrder({ session: makeSession(), business, tenant: {}, intent: 'ORDER' });
  assert.deepEqual(result, { offered: false });
});

test('offerCatalogOnStartOrder: resolves to { offered: false } in MANUAL_ONLY mode even when fully enabled+configured', async () => {
  const business = {
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'MANUAL_ONLY' },
    menuItems: [{ name: 'Burger', available: true }],
  };
  const result = await offerCatalogOnStartOrder({ session: makeSession(), business, tenant: {}, intent: 'ORDER' });
  assert.deepEqual(result, { offered: false });
});

// ── 2. moduleRegistry.js — the wiring itself ────────────────────────────────

test('moduleRegistry.js: START_ORDER now imports and calls offerCatalogOnStartOrder, falling back to startFlow(ORDER)', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_ORDER'");
  const end   = src.indexOf("registerAction('START_BOOKING'");
  assert.ok(start !== -1, 'START_ORDER registration must exist');
  const body = src.slice(start, end);

  assert.ok(body.includes("import('../../modules/catalog/waCatalogFlow.js')"),
    'START_ORDER must import waCatalogFlow.js to reach offerCatalogOnStartOrder');
  assert.ok(body.includes('offerCatalogOnStartOrder('),
    'START_ORDER must actually call offerCatalogOnStartOrder — not just document it');
  assert.ok(body.includes("startFlow({ flowName: 'ORDER'"),
    'START_ORDER must still fall back to the normal ORDER flow (View Menu) when catalog is not offered');
});

test('moduleRegistry.js: START_ORDER passes `intent` through so shouldOfferCatalog can make its AI_DECIDES decision', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_ORDER'");
  const end   = src.indexOf("registerAction('START_BOOKING'");
  const body = src.slice(start, end);
  assert.match(body, /async \(\{[^}]*\bintent\b[^}]*\}\)/, 'the handler must destructure `intent` from its args');
});
