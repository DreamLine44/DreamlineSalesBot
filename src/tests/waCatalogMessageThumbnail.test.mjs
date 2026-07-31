// tests/waCatalogMessageThumbnail.test.mjs
//
// Regression test for [FIX-CATALOG-MSG-PARAMS] in waCatalogService.js:
// sendCatalogMessage() now passes the first entry of
// business.waCatalog.syncedRetailerIds as ui.thumbnailProductRetailerId when
// it falls through to the catalog_message (>INLINE_LIST_ROW_THRESHOLD items)
// branch, so the message shows a deliberate thumbnail instead of leaving it
// to Meta's own default.
//
// Exercised end-to-end through dispatchMessage() in SIMULATION_MODE (no
// network, no tenant credentials needed — same isolation used by
// waCatalogDispatcherPayload.test.mjs), so this proves the wiring actually
// reaches the outbound Graph payload, not just that the two files agree in
// isolation.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIMULATION_MODE = 'true';

const { sendCatalogMessage } = await import('../modules/catalog/waCatalogService.js');

function makeLargeBusiness(overrides = {}) {
  const img = { url: 'https://example.com/img.jpg' };
  // > INLINE_LIST_ROW_THRESHOLD (30) TOTAL sellable items forces the
  // catalog_message branch (vs. product_list) in sendCatalogMessage().
  // buildCategorizedSections() caps each individual section at 30 items
  // (maxItemsPerSection), so these are spread across two categories —
  // 20 + 20 = 40 total rows — to genuinely exceed the threshold rather
  // than being capped back down within a single section.
  const menuItems = [
    ...Array.from({ length: 20 }, (_, i) => ({
      _id: `m${i + 1}`, name: `Main ${i + 1}`, category: 'Mains',
      available: true, price: 5, image: img,
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      _id: `d${i + 1}`, name: `Drink ${i + 1}`, category: 'Drinks',
      available: true, price: 2, image: img,
    })),
  ];
  return {
    tenantId: 't1',
    name: 'Test Biz',
    waCatalog: { catalogId: 'CAT_1', syncedRetailerIds: ['sku-first', 'sku-second'], ...overrides.waCatalog },
    menuItems,
  };
}

test('sendCatalogMessage passes the first syncedRetailerIds entry through to the outbound thumbnail_product_retailer_id', async () => {
  const business = makeLargeBusiness();
  const result = await sendCatalogMessage('1234567890', business, {});

  assert.equal(result.payload.interactive.type, 'catalog_message');
  assert.deepEqual(
    result.payload.interactive.action.parameters,
    { thumbnail_product_retailer_id: 'sku-first' },
    'must use the FIRST synced retailer id as the thumbnail'
  );
});

test('sendCatalogMessage omits the thumbnail parameter when syncedRetailerIds is empty (tenant never synced)', async () => {
  const business = makeLargeBusiness({ waCatalog: { syncedRetailerIds: [] } });
  const result = await sendCatalogMessage('1234567890', business, {});

  assert.equal(result.payload.interactive.type, 'catalog_message');
  assert.equal(
    result.payload.interactive.action.parameters,
    undefined,
    'no synced items means no thumbnail to offer — falls through to Meta\'s own default'
  );
});
