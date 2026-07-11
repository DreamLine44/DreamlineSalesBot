// tests/waCatalogNormalization.test.mjs
//
// Regression tests for [CATALOG-NORM] in modules/catalog/waCatalogHelpers.js
// and [CATALOG-CONFIG] in modules/catalog/waCatalogConfig.js.
//
// waCatalogHelpers.js is pure (no mongoose, no logger, no network) so it can
// be imported and exercised directly in this sandbox, same as matchEngine.js
// would be if 'fast-levenshtein' were installed here.
//
// Covers:
//   (a) a catalog-enabled tenant's WA Catalog selection normalizes into the
//       EXACT { item, variant } shape SELECT_ITEM/SELECT_VARIANT already
//       produce (retail/flows/index.js data.item / data.variant) — the core
//       "normalize into the same internal representation" requirement.
//   (b) a non-catalog / disabled tenant never has WA Catalog offered —
//       shouldOfferCatalog() returns false in every disabled/unconfigured
//       shape, which is what keeps behaviour byte-for-byte unchanged for
//       every tenant who hasn't opted in.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildRetailerId, parseRetailerId, resolveCatalogItem, normalizeCatalogSelection,
} = await import('../modules/catalog/waCatalogHelpers.js');

const { shouldOfferCatalog, isCatalogEnabled, hasSellableProducts } =
  await import('../modules/catalog/waCatalogConfig.js');

function makeBusiness(overrides = {}) {
  return {
    tenantId: 't1',
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'AI_DECIDES' },
    menuItems: [
      { _id: 'item1', name: 'Blue Shirt', price: 20, available: true, variants: [{ name: 'Small' }, { name: 'Large' }] },
      { _id: 'item2', name: 'Red Hat',    price: 10, available: true, variants: [] },
      { _id: 'item3', name: 'Old Shoes',  price: 5,  available: false },
    ],
    ...overrides,
  };
}

// ── Retailer ID round-trip ───────────────────────────────────────────────────

test('buildRetailerId/parseRetailerId round-trip for plain and variant items', () => {
  const plain = buildRetailerId({ _id: 'item2' });
  assert.equal(plain, 'item2');
  assert.deepEqual(parseRetailerId(plain), { menuItemId: 'item2', variantSlug: null });

  const withVariant = buildRetailerId({ _id: 'item1' }, 'Large');
  assert.equal(withVariant, 'item1::large');
  assert.deepEqual(parseRetailerId(withVariant), { menuItemId: 'item1', variantSlug: 'large' });
});

// ── resolveCatalogItem ───────────────────────────────────────────────────────

test('resolveCatalogItem resolves a plain item with no variant', () => {
  const business = makeBusiness();
  const resolved = resolveCatalogItem(business, 'item2');
  assert.equal(resolved.item.name, 'Red Hat');
  assert.equal(resolved.variant, null);
});

test('resolveCatalogItem resolves a variant-specific retailer_id back to the correct variant name', () => {
  const business = makeBusiness();
  const resolved = resolveCatalogItem(business, 'item1::large');
  assert.equal(resolved.item.name, 'Blue Shirt');
  assert.equal(resolved.variant, 'Large');
});

test('resolveCatalogItem returns null for an unavailable item (never resurrects a discontinued product)', () => {
  const business = makeBusiness();
  assert.equal(resolveCatalogItem(business, 'item3'), null);
});

test('resolveCatalogItem returns null for a retailer_id that matches no menu item', () => {
  const business = makeBusiness();
  assert.equal(resolveCatalogItem(business, 'does-not-exist'), null);
});

// ── normalizeCatalogSelection — the SELECT_ITEM/SELECT_VARIANT-equivalent output ──

test('a single-item WA Catalog order normalizes into { item, variant } exactly matching SELECT_VARIANT\'s output shape', () => {
  const business = makeBusiness();
  const metaOrder = {
    catalog_id: 'CAT_1',
    product_items: [{ product_retailer_id: 'item1::small', quantity: '2', item_price: '20', currency: 'USD' }],
  };
  const normalized = normalizeCatalogSelection(business, metaOrder);

  assert.equal(normalized.item.name, 'Blue Shirt');
  assert.equal(normalized.variant, 'Small');
  assert.equal(normalized.quantity, 2);
  assert.equal(normalized.extraLinesSkipped, 0);
  assert.deepEqual(normalized.queuedLines, []);
});

test('a multi-item WA cart normalizes the first RESOLVABLE line as primary and QUEUES the rest, only counting genuinely unmatched lines as skipped', () => {
  const business = makeBusiness();
  const metaOrder = {
    product_items: [
      { product_retailer_id: 'does-not-exist', quantity: '1' }, // unresolvable — skipped
      { product_retailer_id: 'item2',          quantity: '3' }, // first resolvable line -> primary
      { product_retailer_id: 'item1',          quantity: '1' }, // second resolvable line -> queued
    ],
  };
  const normalized = normalizeCatalogSelection(business, metaOrder);

  assert.equal(normalized.item.name, 'Red Hat');
  assert.equal(normalized.quantity, 3);
  assert.equal(normalized.extraLinesSkipped, 1);
  assert.deepEqual(normalized.queuedLines, [{ retailerId: 'item1', quantity: 1 }]);
});

test('an order with no resolvable line returns null (caller falls back to a normal browse prompt)', () => {
  const business = makeBusiness();
  const metaOrder = { product_items: [{ product_retailer_id: 'nope', quantity: '1' }] };
  assert.equal(normalizeCatalogSelection(business, metaOrder), null);
});

test('an empty/malformed order returns null without throwing', () => {
  assert.equal(normalizeCatalogSelection(makeBusiness(), {}), null);
  assert.equal(normalizeCatalogSelection(makeBusiness(), { product_items: [] }), null);
  assert.equal(normalizeCatalogSelection(makeBusiness(), null), null);
});

// ── shouldOfferCatalog — the "zero behavioural change" guarantee ───────────

test('shouldOfferCatalog is false for a tenant who never enabled WA Catalog (default BusinessConfig shape)', () => {
  const business = { waCatalog: { enabled: false, catalogId: null, mode: 'AI_DECIDES' }, menuItems: [{ available: true }] };
  assert.equal(isCatalogEnabled(business), false);
  assert.equal(shouldOfferCatalog({ business, intent: 'ORDER' }), false);
});

test('shouldOfferCatalog is false when enabled but no catalogId is configured yet', () => {
  const business = { waCatalog: { enabled: true, catalogId: null }, menuItems: [{ available: true }] };
  assert.equal(shouldOfferCatalog({ business, intent: 'ORDER' }), false);
});

test('shouldOfferCatalog is false when the tenant has no sellable products', () => {
  const business = { waCatalog: { enabled: true, catalogId: 'C1' }, menuItems: [{ available: false }] };
  assert.equal(hasSellableProducts(business), false);
  assert.equal(shouldOfferCatalog({ business, intent: 'ORDER' }), false);
});

test('shouldOfferCatalog: AI_DECIDES offers on browse-ish intents but not CHECKOUT/REMOVE_FROM_CART', () => {
  const business = makeBusiness({ waCatalog: { enabled: true, catalogId: 'C1', mode: 'AI_DECIDES' } });
  // [FIX-CATALOG-DEADINTENT] shouldOfferCatalog() is only ever called with the
  // *intent* value (see intentEngine.js intentToAction()) — 'ORDER' and
  // 'ADD_TO_CART' both map to the 'START_ORDER' *action*, but 'START_ORDER' is
  // never itself an intent value, so it must NOT be asserted as true here.
  assert.equal(shouldOfferCatalog({ business, intent: 'ORDER' }), true);
  assert.equal(shouldOfferCatalog({ business, intent: 'ADD_TO_CART' }), true);
  assert.equal(shouldOfferCatalog({ business, intent: 'CHECKOUT' }), false);
  assert.equal(shouldOfferCatalog({ business, intent: 'REMOVE_FROM_CART' }), false);
  assert.equal(shouldOfferCatalog({ business, intent: 'START_ORDER' }), false);
});

test('shouldOfferCatalog: ALWAYS_OFFER ignores intent nuance entirely', () => {
  const business = makeBusiness({ waCatalog: { enabled: true, catalogId: 'C1', mode: 'ALWAYS_OFFER' } });
  assert.equal(shouldOfferCatalog({ business, intent: 'CHECKOUT' }), true);
});

test('shouldOfferCatalog: MANUAL_ONLY never auto-offers, regardless of intent', () => {
  const business = makeBusiness({ waCatalog: { enabled: true, catalogId: 'C1', mode: 'MANUAL_ONLY' } });
  assert.equal(shouldOfferCatalog({ business, intent: 'ORDER' }), false);
});
