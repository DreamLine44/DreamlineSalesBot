// tests/catalogCartConfirmHandoff.test.mjs
//
// [FIX-CATALOG-CART-CONFIRM] End-to-end-ish regression test for the fix
// described in modules/catalog/waCatalogFlow.js's handleMultiItemCatalogOrder():
//
//   1. A WhatsApp Catalog checkout with 2+ items must land the customer on
//      the SAME "🧾 Order Summary ... Would you like to confirm this order?"
//      review screen (✅ Confirm Order / ➕ Add More Items / ❌ Cancel Order)
//      that a typed/tapped multi-item order already gets — not an
//      already-saved "Order received!" notice with no way to review, fix, or
//      cancel it.
//
//   2. Two catalog cart lines for the SAME item (e.g. the customer added
//      "Superkanja" to their WhatsApp cart twice) must be merged into ONE
//      summed line, never shown twice.
//
// This drives modules/restaurant/flows/orderFlow.js's real handleOrderFlow()
// directly at step 'CONFIRM' with an empty message — exactly what
// handleMultiItemCatalogOrder() does after merging the resolved catalog
// lines into session.data.cart — using plain objects only (no mongoose),
// matching this module's existing no-DB testing style.

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
    { _id: 'akara',      name: 'Akara (Bean Fritters)', price: 25,  available: true },
    { _id: 'domoda',     name: 'Domoda (Chicken)', price: 175, available: true },
  ],
  payment: { currency: 'D' },
};

function makeSession(cart) {
  return {
    customerPhone: '2203532423',
    tenantId:      't1',
    currentFlow:   'ORDER',
    step:          'CONFIRM',
    data:          { cart },
  };
}

test('a merged WA Catalog cart with a duplicate item line shows ONE summed line, not two', () => {
  // Mirrors handleMultiItemCatalogOrder(): two separate resolved catalog
  // lines for the same menu item (e.g. two "Superkanja" cart rows).
  const resolvedAsCartLines = [
    { item: business.menuItems[0], quantity: 1, variant: null, addOns: [] }, // Superkanja x1
    { item: business.menuItems[1], quantity: 2, variant: null, addOns: [] }, // Akara x2
    { item: business.menuItems[0], quantity: 1, variant: null, addOns: [] }, // Superkanja x1 again (duplicate)
  ];
  const merged = mergeCartLines([], resolvedAsCartLines);

  assert.equal(merged.length, 2, 'duplicate Superkanja lines must merge into one');
  const superkanjaLine = merged.find(l => l.item._id === 'superkanja');
  assert.equal(superkanjaLine.quantity, 2, 'merged Superkanja line must sum to quantity 2, not appear as two separate 1x lines');
});

test('the CONFIRM step, reached fresh from a WA Catalog handoff (empty message), shows the Confirm/Add More Items/Cancel review screen — not an already-placed order', async () => {
  const cart = mergeCartLines([], [
    { item: business.menuItems[0], quantity: 1, variant: null, addOns: [] },
    { item: business.menuItems[1], quantity: 2, variant: null, addOns: [] },
    { item: business.menuItems[0], quantity: 1, variant: null, addOns: [] },
  ]);
  const session = makeSession(cart);

  const reply = await handleOrderFlow({ session, message: '', business, tenant: { adminPhone: '111' } });

  assert.equal(reply.type, 'buttons');
  assert.match(reply.body, /Would you like to confirm this order\?/);
  assert.match(reply.body, /2× Superkanja/); // merged quantity shown correctly
  const ids = reply.buttons.map(b => b.id);
  assert.deepEqual(ids, ['CONFIRM', 'ADD_MORE_ITEMS', 'CANCEL']);
});
