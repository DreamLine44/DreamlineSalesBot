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
  return {
    tenantId: 't1',
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'AI_DECIDES' },
    menuItems: [
      { _id: 'i1', name: 'Burger',   category: 'Mains',  available: true },
      { _id: 'i2', name: 'Fries',    category: 'Mains',  available: true },
      { _id: 'i3', name: 'Cola',     category: 'Drinks', available: true },
      { _id: 'i4', name: 'Old Item', category: 'Mains',  available: false }, // excluded
      { _id: 'i5', name: 'T-Shirt',  category: 'Apparel', available: true, variants: ['S', 'M'] },
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

test('buildCategorizedSections falls back to a single "Products" section when no item has a category', () => {
  const business = makeBusiness({
    menuItems: [
      { _id: 'a', name: 'A', available: true },
      { _id: 'b', name: 'B', available: true },
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
  assert.equal(shouldShowCatalogButton(makeBusiness({ waCatalog: { enabled: true, catalogId: 'C', mode: 'MANUAL_ONLY' } })), true);
  assert.equal(shouldShowCatalogButton(makeBusiness({ waCatalog: { enabled: true, catalogId: 'C', mode: 'AI_DECIDES' } })), true);
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
