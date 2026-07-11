// tests/menuItemVariantsSchema.test.mjs
//
// Regression test for [FIX-VARIANTS-SCHEMA].
//
// Bug found and fixed: menuItemSchema (models/BusinessConfig.js) had no
// `variants` field declared. Mongoose's default strict mode silently drops
// any key not declared on a (sub)document schema when casting a write —
// so every `variants` array sent via addMenuItem/updateMenuItem/updateMenu
// (dashboardController.js and businessController.js), or via scripts/seed.js's
// BusinessConfig.create(), was stripped before it ever reached Mongo. No
// error was raised anywhere; the request just "succeeded" with the field
// quietly gone.
//
// This broke, all at once:
//   - fashion/flows/index.js SELECT_ITEM: `if (item.variants?.length)` was
//     always false, so every fashion item skipped size selection entirely.
//   - retail/flows/index.js SELECT_VARIANT: `hasVariants` was always false,
//     so every retail item skipped variant selection entirely.
//   - waCatalogHelpers.js resolveCatalogItem(): variant-specific retailer_id
//     suffixes (`<id>::<slug>`) could never resolve back to a variant, since
//     item.variants was never actually populated on any persisted item.
//
// This test constructs a MenuItem subdocument directly via the actual
// exported Mongoose model/schema (no DB connection required — schema
// casting happens client-side before Mongo is ever contacted) and asserts
// that a `variants` array survives the cast, both as plain strings (the
// scripts/seed.js shape) and as `{ name }` objects (the shape every reader
// also accepts via `v.name || v`).

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import BusinessConfig from '../models/BusinessConfig.js';

function castMenuItems(menuItems) {
  // Constructing a document (without saving) is enough to exercise Mongoose's
  // schema casting — no live Mongo connection is needed for this.
  const doc = new BusinessConfig({
    tenantId: `test-${new mongoose.Types.ObjectId()}`,
    menuItems,
  });
  return doc.toObject().menuItems;
}

test('menuItemSchema persists plain-string variants through casting', () => {
  const [cast] = castMenuItems([
    { name: 'Kaftan Set', price: 1200, variants: ['S', 'M', 'L', 'XL'] },
  ]);
  assert.deepEqual(cast.variants, ['S', 'M', 'L', 'XL']);
});

test('menuItemSchema persists {name}-object variants through casting', () => {
  const [cast] = castMenuItems([
    { name: 'Blue Shirt', price: 20, variants: [{ name: 'Small' }, { name: 'Large' }] },
  ]);
  assert.deepEqual(cast.variants, [{ name: 'Small' }, { name: 'Large' }]);
});

test('menuItemSchema defaults variants to an empty array when omitted', () => {
  const [cast] = castMenuItems([{ name: 'Plain Item', price: 5 }]);
  assert.deepEqual(cast.variants, []);
});

test('menuItemSchema rejects more than 20 variants on a single item', () => {
  const tooMany = Array.from({ length: 21 }, (_, i) => `V${i}`);
  const doc = new BusinessConfig({
    tenantId: `test-${new mongoose.Types.ObjectId()}`,
    menuItems: [{ name: 'Overloaded Item', price: 5, variants: tooMany }],
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error for >20 variants');
});
