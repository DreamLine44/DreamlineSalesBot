// tests/waCatalogCartConsolidation.test.mjs
//
// Regression tests for [CATALOG-CART-1] in modules/catalog/waCatalogHelpers.js:
//
//   - normalizeCatalogSelection() additionally returns `resolvedLines` (the
//     full set of resolved cart lines, untouched by the primary/rest split
//     used for the pre-existing single-item sequential-queue path)
//   - buildCatalogCartItems() maps resolvedLines into the exact shape
//     orderService.saveOrder()'s `items` parameter expects
//
// waCatalogFlow.js's handleMultiItemCatalogOrder() itself is orchestration
// (mongoose via saveOrder/updateSession, dispatcher.dispatchMessage) so it's
// covered at the integration level, same as handleCatalogOrderMessage /
// drainCatalogQueue already are per waCatalogQueueDrain.test.mjs's own note.
// These two pure functions hold the actual "did we build the right cart"
// decision logic that CATALOG-CART-1 depends on.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeCatalogSelection, buildCatalogCartItems,
} = await import('../modules/catalog/waCatalogHelpers.js');

function makeBusiness(overrides = {}) {
  return {
    tenantId: 't1',
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'AI_DECIDES' },
    menuItems: [
      { _id: 'item1', name: 'Blue Shirt', price: 20, available: true, variants: [{ name: 'Small' }, { name: 'Large' }] },
      { _id: 'item2', name: 'Red Hat',    price: 10, available: true, variants: [] },
      { _id: 'item3', name: 'Old Shoes',  price: 5,  available: false }, // unavailable
    ],
    ...overrides,
  };
}

function makeMetaOrder(productItems) {
  return { catalog_id: 'CAT_1', product_items: productItems };
}

// ── normalizeCatalogSelection: resolvedLines ────────────────────────────────

test('normalizeCatalogSelection returns resolvedLines with every resolvable line, in cart order', () => {
  const business = makeBusiness();
  const meta = makeMetaOrder([
    { product_retailer_id: 'item2', quantity: '2' },
    { product_retailer_id: 'item1::large', quantity: '1' },
  ]);
  const normalized = normalizeCatalogSelection(business, meta);

  assert.equal(normalized.resolvedLines.length, 2);
  assert.equal(normalized.resolvedLines[0].item.name, 'Red Hat');
  assert.equal(normalized.resolvedLines[0].quantity, 2);
  assert.equal(normalized.resolvedLines[1].item.name, 'Blue Shirt');
  assert.equal(normalized.resolvedLines[1].variant, 'Large');
});

test('normalizeCatalogSelection resolvedLines still excludes unresolvable lines (deleted/unavailable products)', () => {
  const business = makeBusiness();
  const meta = makeMetaOrder([
    { product_retailer_id: 'item2', quantity: '1' },
    { product_retailer_id: 'item3', quantity: '1' }, // unavailable
    { product_retailer_id: 'does-not-exist', quantity: '1' }, // deleted
  ]);
  const normalized = normalizeCatalogSelection(business, meta);

  assert.equal(normalized.resolvedLines.length, 1);
  assert.equal(normalized.resolvedLines[0].item.name, 'Red Hat');
  assert.equal(normalized.extraLinesSkipped, 2);
});

test('normalizeCatalogSelection resolvedLines is a single entry for a single-item cart (pre-existing single-item path unaffected)', () => {
  const business = makeBusiness();
  const meta = makeMetaOrder([{ product_retailer_id: 'item2', quantity: '3' }]);
  const normalized = normalizeCatalogSelection(business, meta);

  assert.equal(normalized.resolvedLines.length, 1);
  // Existing single-item fields still populated exactly as before — this is
  // the additive-only guarantee: nothing existing changed shape.
  assert.equal(normalized.item.name, 'Red Hat');
  assert.equal(normalized.quantity, 3);
  assert.deepEqual(normalized.queuedLines, []);
});

// ── buildCatalogCartItems ────────────────────────────────────────────────────

test('buildCatalogCartItems maps resolvedLines into saveOrder()-ready items[] shape', () => {
  const business = makeBusiness();
  const meta = makeMetaOrder([
    { product_retailer_id: 'item2', quantity: '2' },
    { product_retailer_id: 'item1::small', quantity: '1' },
  ]);
  const { resolvedLines } = normalizeCatalogSelection(business, meta);
  const cartItems = buildCatalogCartItems(resolvedLines);

  assert.deepEqual(cartItems, [
    { item: 'Red Hat', quantity: 2, addOns: [], unitPrice: 10, menuItemId: 'item2' },
    { item: 'Blue Shirt (Small)', quantity: 1, addOns: [], unitPrice: 20, menuItemId: 'item1' },
  ]);
});

test('buildCatalogCartItems folds the variant name into the item label, matching per-vertical CONFIRM-step labeling', () => {
  const business = makeBusiness();
  const meta = makeMetaOrder([{ product_retailer_id: 'item1::large', quantity: '1' }]);
  const { resolvedLines } = normalizeCatalogSelection(business, meta);
  const [cartItem] = buildCatalogCartItems(resolvedLines);

  assert.equal(cartItem.item, 'Blue Shirt (Large)');
});

test('buildCatalogCartItems leaves a plain (no-variant) item label untouched', () => {
  const business = makeBusiness();
  const meta = makeMetaOrder([{ product_retailer_id: 'item2', quantity: '1' }]);
  const { resolvedLines } = normalizeCatalogSelection(business, meta);
  const [cartItem] = buildCatalogCartItems(resolvedLines);

  assert.equal(cartItem.item, 'Red Hat');
});

test('buildCatalogCartItems returns [] for an empty/missing resolvedLines input (never throws)', () => {
  assert.deepEqual(buildCatalogCartItems([]), []);
  assert.deepEqual(buildCatalogCartItems(null), []);
  assert.deepEqual(buildCatalogCartItems(undefined), []);
});

test('buildCatalogCartItems sets unitPrice to null (not 0 or undefined) for a menu item with a non-numeric price', () => {
  const business = makeBusiness({
    menuItems: [{ _id: 'item9', name: 'Mystery Box', price: undefined, available: true, variants: [] }],
  });
  const meta = makeMetaOrder([{ product_retailer_id: 'item9', quantity: '1' }]);
  const { resolvedLines } = normalizeCatalogSelection(business, meta);
  const [cartItem] = buildCatalogCartItems(resolvedLines);

  assert.equal(cartItem.unitPrice, null);
});

// ── Combined: the exact shape resolveOrderFields()/saveOrder() will see ─────

test('buildCatalogCartItems output is directly usable by orderService.resolveOrderFields (all items priced -> computed total)', async () => {
  const { resolveOrderFields } = await import('../services/orderService.js');
  const business = makeBusiness();
  const meta = makeMetaOrder([
    { product_retailer_id: 'item2', quantity: '2' },        // 10 x 2 = 20
    { product_retailer_id: 'item1::small', quantity: '3' },  // 20 x 3 = 60
  ]);
  const { resolvedLines } = normalizeCatalogSelection(business, meta);
  const items = buildCatalogCartItems(resolvedLines);

  const { hasCart, resolvedTotal } = resolveOrderFields({ items });
  assert.equal(hasCart, true);
  assert.equal(resolvedTotal, 80);
});
