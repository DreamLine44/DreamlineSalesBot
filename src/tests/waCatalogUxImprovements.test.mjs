// tests/waCatalogUxImprovements.test.mjs
//
// Regression tests for the WA Catalog UX improvements:
//   1. buildCategorizedSections() (waCatalogHelpers.js) — groups the sellable
//      menu into Meta product_list sections by category, expanding variant
//      items into one row per variant so every row maps to a retailer_id
//      syncMenuToCatalog() actually uploaded.
//   2. shouldShowCatalogButton() / withCatalogWelcomeOption() (waCatalogConfig.js)
//      — the explicit "🛍 Browse Catalog" welcome-menu button, and the
//      buttons-vs-list fallback that avoids silently exceeding WhatsApp's
//      3-button cap.
//
// All pure, dependency-free (no mongoose/logger/network), same isolation
// rationale as waCatalogNormalization.test.mjs.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildCategorizedSections } = await import('../modules/catalog/waCatalogHelpers.js');
const { shouldShowCatalogButton, withCatalogWelcomeOption } =
  await import('../modules/catalog/waCatalogConfig.js');

function makeBusiness(overrides = {}) {
  const img = { url: 'https://example.com/img.jpg' };
  return {
    tenantId: 't1',
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'AI_DECIDES', lastSyncedAt: new Date(), syncedRetailerIds: ['i1', 'i2', 'i3', 'i5::s', 'i5::m'] },
    menuItems: [
      { _id: 'i1', name: 'Burger',   category: 'Mains',  available: true, price: 5, image: img },
      { _id: 'i2', name: 'Fries',    category: 'Mains',  available: true, price: 3, image: img },
      { _id: 'i3', name: 'Cola',     category: 'Drinks', available: true, price: 2, image: img },
      { _id: 'i4', name: 'Old Item', category: 'Mains',  available: false, price: 4, image: img }, // excluded
      { _id: 'i5', name: 'T-Shirt',  category: 'Apparel', available: true, price: 10, image: img, variants: ['S', 'M'] },
    ],
    ...overrides,
  };
}

// ── buildCategorizedSections ─────────────────────────────────────────────────

test('buildCategorizedSections groups available items into one section per category', () => {
  const sections = buildCategorizedSections(makeBusiness());
  const byTitle = Object.fromEntries(sections.map(s => [s.title, s.productRetailerIds]));

  assert.deepEqual(byTitle['Mains'], ['i1', 'i2']);
  assert.deepEqual(byTitle['Drinks'], ['i3']);
  // Variant item expands to one row per variant, not a bare base id.
  assert.deepEqual(byTitle['Apparel'], ['i5::s', 'i5::m']);
});

test('buildCategorizedSections excludes unavailable items entirely', () => {
  const sections = buildCategorizedSections(makeBusiness());
  const allIds = sections.flatMap(s => s.productRetailerIds);
  assert.ok(!allIds.includes('i4'));
});

// [FIX-CATALOG-VISIBLE-SECTIONS-1] regression test — an item missing an
// image or a valid price is never actually pushed to Meta by
// syncMenuToCatalog() (see isSyncableForCatalog / CATALOG-SYNC-VALIDATE-1),
// so it must never appear in the customer-facing catalog message either —
// otherwise the message references a retailer_id Meta has no product for.
test('buildCategorizedSections excludes items that would never actually sync (missing image / invalid price)', () => {
  const business = makeBusiness({
    waCatalog: { enabled: true, catalogId: 'CAT_1', syncedRetailerIds: ['ok', 'no-image', 'no-price'] },
    menuItems: [
      { _id: 'ok',       name: 'Synced Item',  category: 'Mains', available: true, price: 5, image: { url: 'https://example.com/x.jpg' } },
      { _id: 'no-image', name: 'No Image',     category: 'Mains', available: true, price: 5 }, // never synced — no image
      { _id: 'no-price', name: 'No Price',     category: 'Mains', available: true, image: { url: 'https://example.com/y.jpg' } }, // never synced — no price
    ],
  });
  const sections = buildCategorizedSections(business);
  const allIds = sections.flatMap(s => s.productRetailerIds);
  assert.deepEqual(allIds, ['ok']);
});

test('buildCategorizedSections falls back to a single "Products" section when no item has a category', () => {
  const business = makeBusiness({
    waCatalog: { enabled: true, catalogId: 'CAT_1', syncedRetailerIds: ['a', 'b'] },
    menuItems: [
      { _id: 'a', name: 'A', available: true, price: 1, image: { url: 'https://example.com/a.jpg' } },
      { _id: 'b', name: 'B', available: true, price: 1, image: { url: 'https://example.com/b.jpg' } },
    ],
  });
  const sections = buildCategorizedSections(business);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].title, 'Products');
  assert.deepEqual(sections[0].productRetailerIds, ['a', 'b']);
});


test('buildCategorizedSections returns [] for a tenant with no sellable items (never throws)', () => {
  assert.deepEqual(buildCategorizedSections(makeBusiness({ menuItems: [] })), []);
  assert.deepEqual(buildCategorizedSections({}), []);
});

test('[FIX-CATALOG-CONFIRMED-ONLY] buildCategorizedSections excludes items that are locally valid but not yet CONFIRMED live in Meta (still pending batch verification)', () => {
  // Reproduces the exact production symptom: 3 locally-valid items, but
  // Meta has only confirmed 1 of them (the other 2 are still pending or
  // were never confirmed) — the message must reference only the confirmed one.
  const business = makeBusiness({
    waCatalog: { enabled: true, catalogId: 'CAT_1', syncedRetailerIds: ['confirmed'] },
    menuItems: [
      { _id: 'confirmed', name: 'Confirmed Item', category: 'Mains', available: true, price: 5, image: { url: 'https://example.com/a.jpg' } },
      { _id: 'pending-1', name: 'Pending Item 1', category: 'Mains', available: true, price: 5, image: { url: 'https://example.com/b.jpg' } },
      { _id: 'pending-2', name: 'Pending Item 2', category: 'Mains', available: true, price: 5, image: { url: 'https://example.com/c.jpg' } },
    ],
  });
  const sections = buildCategorizedSections(business);
  const allIds = sections.flatMap(s => s.productRetailerIds);
  assert.deepEqual(allIds, ['confirmed']);
});

test('[FIX-CATALOG-CONFIRMED-ONLY] buildCategorizedSections returns [] when nothing is confirmed yet, even if everything is locally valid', () => {
  const business = makeBusiness({
    waCatalog: { enabled: true, catalogId: 'CAT_1', syncedRetailerIds: [] },
    menuItems: [
      { _id: 'a', name: 'A', available: true, price: 1, image: { url: 'https://example.com/a.jpg' } },
    ],
  });
  assert.deepEqual(buildCategorizedSections(business), []);
});

test('buildCategorizedSections caps at 10 sections and 30 rows per section', () => {
  const menuItems = [];
  for (let cat = 0; cat < 15; cat++) {
    for (let row = 0; row < 35; row++) {
      menuItems.push({ _id: `c${cat}-r${row}`, name: `Item ${cat}-${row}`, category: `Cat${cat}`, available: true });
    }
  }
  const sections = buildCategorizedSections(makeBusiness({ menuItems }));
  assert.ok(sections.length <= 10);
  for (const s of sections) assert.ok(s.productRetailerIds.length <= 30);
});

// ── shouldShowCatalogButton / withCatalogWelcomeOption ───────────────────────

test('shouldShowCatalogButton is true for an enabled+configured tenant with sellable products, regardless of mode', () => {
  assert.equal(shouldShowCatalogButton(makeBusiness({ waCatalog: { enabled: true, catalogId: 'C', mode: 'MANUAL_ONLY', lastSyncedAt: new Date(), syncedRetailerIds: ['i1'] } })), true);
  assert.equal(shouldShowCatalogButton(makeBusiness({ waCatalog: { enabled: true, catalogId: 'C', mode: 'AI_DECIDES', lastSyncedAt: new Date(), syncedRetailerIds: ['i1'] } })), true);
});

test('shouldShowCatalogButton is false when disabled, unconfigured, or nothing sellable', () => {
  assert.equal(shouldShowCatalogButton(makeBusiness({ waCatalog: { enabled: false, catalogId: 'C' } })), false);
  assert.equal(shouldShowCatalogButton(makeBusiness({ waCatalog: { enabled: true, catalogId: null } })), false);
  assert.equal(shouldShowCatalogButton(makeBusiness({ menuItems: [{ _id: 'x', available: false }] })), false);
});

test('withCatalogWelcomeOption is a no-op for a tenant without WA Catalog', () => {
  const buttons = [{ id: 'ORDER', title: '🛍 Shop' }];
  const business = makeBusiness({ waCatalog: { enabled: false } });
  assert.deepEqual(withCatalogWelcomeOption(buttons, business), { buttons });
});

test('withCatalogWelcomeOption appends as a real button when there is room (<=3 total)', () => {
  const buttons = [{ id: 'ORDER', title: '🛍 Shop' }, { id: 'SUPPORT', title: '💬 Help' }];
  const result = withCatalogWelcomeOption(buttons, makeBusiness());
  assert.equal(result.buttons.length, 3);
  assert.equal(result.buttons[2].id, 'BROWSE_CATALOG');
  assert.equal(result.rows, undefined);
});

test('withCatalogWelcomeOption switches to list rows (never silently drops a button) when it would exceed 3', () => {
  const buttons = [
    { id: 'ORDER', title: '🛍 Shop' },
    { id: 'BOOK', title: '📅 Book' },
    { id: 'QUESTION', title: '❓ Ask' },
  ];
  const result = withCatalogWelcomeOption(buttons, makeBusiness());
  assert.equal(result.buttons, undefined);
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.map(r => r.id), ['ORDER', 'BOOK', 'QUESTION', 'BROWSE_CATALOG']);
});
