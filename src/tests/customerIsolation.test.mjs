// tests/customerIsolation.test.mjs
//
// Pure, additive regression tests for the [AUDIT-FIX-TRACE-5] fixes:
// four customer-triggered Order/Booking write paths were missing
// `customerPhone` in their query filter (scoped only by shortId + tenantId).
// In normal use the shortId always belongs to the acting customer's own
// session, but the query itself should not be the only thing standing
// between one customer's action and another customer's order/booking
// within the same tenant. Pins that all four now include the requesting
// customer's phone number directly in the filter object.
//
// These are source-text guards (not live-DB tests) — consistent with how
// patterns.test.mjs guards BUTTON_ID_MAP by re-parsing source text — since
// these controllers/services are not designed for isolated unit import
// without a Mongo connection.
//
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('webhookController.js: ORDER_STATUS_* picker query is scoped to the requesting customer', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    src.includes('shortId: pickedShortId, tenantId, customerPhone: from,'),
    'pickedOrder query should be scoped by customerPhone, not just shortId + tenantId'
  );
});

test('webhookController.js: COLLECTED_* handler query is scoped to the requesting customer', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    src.includes("{ shortId: shortIdCollect, tenantId, customerPhone: from, status: { $in: ['ready', 'confirmed'] } }"),
    'COLLECTED_* order-completion write should be scoped by customerPhone'
  );
});

test('postFlowHandler.js: SWITCH_YES order-cancel write is scoped to the requesting customer', () => {
  const src = read('../services/postFlowHandler.js');
  assert.ok(
    src.includes("{ shortId: cancelShortId, tenantId, customerPhone: from, status: { $nin: ['cancelled', 'completed'] } }"),
    'SWITCH_YES cancel write should be scoped by customerPhone'
  );
});

test('postFlowHandler.js: ORDER_READY collected write is scoped to the requesting customer', () => {
  const src = read('../services/postFlowHandler.js');
  assert.ok(
    src.includes("{ shortId: shortIdRef, tenantId, customerPhone: from, status: 'ready' }"),
    'ORDER_READY collected write should be scoped by customerPhone'
  );
});

test('postFlowHandler.js: RESCHEDULE old-booking cancel write is scoped to the requesting customer', () => {
  const src = read('../services/postFlowHandler.js');
  assert.ok(
    src.includes("{ shortId: flowData.shortId, tenantId, customerPhone: from, status: { $nin: ['cancelled', 'completed'] } }"),
    'RESCHEDULE old-booking cancel write should be scoped by customerPhone'
  );
});
