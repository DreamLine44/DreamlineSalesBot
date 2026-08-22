// tests/directOrderConfirmBypassFix.test.mjs
//
// [FIX-INIT-HIJACK] Regression test for the reported bug: a fully resolved
// direct order — "i want to order two plates of Yassa Chicken" — was
// landing on the legacy buildMenuUI() "View Menu" list with a stale
// "You still have N items in your cart" note, instead of bypassing straight
// to the Order Summary (Confirm / Add More Items / Cancel).
//
// Root cause: moduleRegistry.js's direct-order handoff (and the
// cart-modification handoff, and webhookController.js's ambiguity-resolution
// handoff) all call advance() with message: null and step already set to
// 'CONFIRM' with a pre-populated cart — specifically so handleOrderFlow()
// renders the CONFIRM step directly. But orderFlow.js's INIT block
// (`if (message === null)`) ran unconditionally BEFORE the step switch, so
// it always reset step back to 'SELECT_ITEM' and showed the menu/catalog
// instead, no matter what step the caller had deliberately set.
//
// NOTE: this is deliberately NOT the same scenario as
// catalogCartConfirmHandoff.test.mjs, which calls handleOrderFlow with
// message: '' (an empty string). message === '' never triggered the old
// bug — only the literal `null` production code actually sends. This file
// reproduces the exact call shape moduleRegistry.js / webhookController.js
// use in production.
//
// Run with:  node --test src/tests/

import test   from 'node:test';
import assert from 'node:assert/strict';

import { handleOrderFlow } from '../modules/restaurant/flows/orderFlow.js';
import { mergeCartLines }  from '../core/shared/cartEngine.js';

const business = {
  _id: 'biz1',
  tenantId: 't1',
  name: 'DreamLine Restaurant',
  menuItems: [
    { _id: 'superkanja', name: 'Superkanja', price: 150, available: true },
    { _id: 'yassa',      name: 'Yassa Chicken', price: 200, available: true },
  ],
  payment: { currency: 'GMD' },
  waCatalog: {
    enabled: true,
    catalogId: 'cat_123',
    lastSyncedAt: new Date(),
    syncedRetailerIds: ['superkanja', 'yassa'],
  },
};

const tenant = { adminPhone: '111' };

test('a direct-order handoff (message: null, step already CONFIRM) lands straight on the Order Summary — not the menu/catalog', async () => {
  const cart = mergeCartLines([], [
    { item: business.menuItems[1], quantity: 2, variant: null, addOns: [] }, // 2x Yassa Chicken
  ]);
  const session = {
    customerPhone: '2203532423',
    tenantId:      't1',
    currentFlow:   'ORDER',
    step:          'CONFIRM',
    data:          { cart },
  };

  const reply = await handleOrderFlow({ session, message: null, business, tenant });

  assert.equal(reply.type, 'buttons');
  assert.match(reply.body, /Would you like to confirm this order\?/);
  assert.match(reply.body, /2× Yassa Chicken/);
  const ids = reply.buttons.map(b => b.id);
  assert.deepEqual(ids, ['CONFIRM', 'ADD_MORE_ITEMS', 'CANCEL']);
  // Must NOT be the legacy list menu.
  assert.notEqual(reply.type, 'list');
  assert.ok(!reply.buttonLabel || reply.buttonLabel !== 'View Menu');
});

test('a genuine fresh flow start (message: null, no step set) on a WA-Catalog-ready tenant goes straight to catalog — not the legacy list', async () => {
  const session = {
    customerPhone: '2203532423',
    tenantId:      't1',
    currentFlow:   'ORDER',
    step:          null,
    data:          {},
  };

  const reply = await handleOrderFlow({ session, message: null, business, tenant });

  // [AUDIT-FIX-XZ-REMOVE] `business` here has a fully live, synced WA
  // Catalog (isCatalogEnabled() === true). Per that fix, a catalog-ready
  // tenant is routed to the catalog even when the session never stamped
  // data.orderViaCatalog — the legacy text/list menu is retired for these
  // tenants. This must NOT be the legacy list.
  assert.notEqual(reply.type, 'list');
});

test('a genuine fresh flow start (message: null, no step set) on a tenant WITHOUT WA Catalog still shows the normal legacy list menu — no regression', async () => {
  const nonCatalogBusiness = {
    ...business,
    waCatalog: { enabled: false },
  };
  const session = {
    customerPhone: '2203532423',
    tenantId:      't1',
    currentFlow:   'ORDER',
    step:          null,
    data:          {},
  };

  const reply = await handleOrderFlow({ session, message: null, business: nonCatalogBusiness, tenant });

  // No catalog session flag set (data.orderViaCatalog !== true) and
  // isCatalogEnabled() is false, so this legitimately falls back to the
  // text/list menu — unchanged behavior for non-catalog tenants.
  assert.equal(reply.type, 'list');
  assert.equal(reply.buttonLabel, 'View Menu');
});
