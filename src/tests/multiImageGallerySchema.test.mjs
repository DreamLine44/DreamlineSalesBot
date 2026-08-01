// tests/multiImageGallerySchema.test.mjs
//
// Regression tests for [FEAT-MULTI-IMAGE]: menuItemSchema.images gallery
// array (models/BusinessConfig.js).
//
// `images` is deliberately additive to the existing single `image` (cover
// photo) field — every existing reader of item.image.url (bot flows,
// waCatalogService.buildItemData's image_link) is completely unaffected by
// this field's existence. These tests exercise Mongoose's schema casting
// directly (constructing a document without saving — no live Mongo
// connection required, same technique as menuItemVariantsSchema.test.mjs)
// to confirm: (a) images survive casting instead of being silently dropped
// by strict mode the way `variants` once was, (b) each gallery image gets
// its own _id for safe by-id removal, (c) the 10-image cap is enforced,
// and (d) the existing `image` field is completely untouched by any of this.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import BusinessConfig from '../models/BusinessConfig.js';

function castMenuItems(menuItems) {
  const doc = new BusinessConfig({
    tenantId: `test-${new mongoose.Types.ObjectId()}`,
    menuItems,
  });
  return doc.toObject().menuItems;
}

test('menuItemSchema persists an images gallery array through casting', () => {
  const [cast] = castMenuItems([
    {
      name: 'Burger', price: 10,
      images: [
        { url: 'https://example.com/a.jpg', public_id: 'pid-a' },
        { url: 'https://example.com/b.jpg', public_id: 'pid-b' },
      ],
    },
  ]);
  assert.equal(cast.images.length, 2);
  assert.equal(cast.images[0].url, 'https://example.com/a.jpg');
  assert.equal(cast.images[1].public_id, 'pid-b');
});

test('menuItemSchema defaults images to an empty array when omitted', () => {
  const [cast] = castMenuItems([{ name: 'Plain Item', price: 5 }]);
  assert.deepEqual(cast.images, []);
});

test('menuItemSchema assigns each gallery image its own _id (needed for by-id removal, since Cloudinary public_ids contain "/")', () => {
  const [cast] = castMenuItems([
    { name: 'Shirt', price: 20, images: [{ url: 'https://example.com/x.jpg', public_id: 'folder/sub/x' }] },
  ]);
  assert.ok(cast.images[0]._id, 'expected an auto-generated _id on the gallery image subdocument');
});

test('menuItemSchema rejects more than 10 gallery images (Meta additional_image_urls limit)', () => {
  const tooMany = Array.from({ length: 11 }, (_, i) => ({ url: `https://example.com/${i}.jpg` }));
  const doc = new BusinessConfig({
    tenantId: new mongoose.Types.ObjectId(),
    menuItems: [{ name: 'Overloaded Item', price: 1, images: tooMany }],
  });
  const err = doc.validateSync();
  assert.ok(err, 'expected a validation error for 11 gallery images');
  assert.match(String(err), /Max 10 additional images per item/);
});

test('menuItemSchema accepts exactly 10 gallery images (boundary, not off-by-one)', () => {
  const exactlyTen = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}.jpg` }));
  const doc = new BusinessConfig({
    tenantId: new mongoose.Types.ObjectId(),
    menuItems: [{ name: 'Full Gallery Item', price: 1, images: exactlyTen }],
  });
  const err = doc.validateSync();
  assert.equal(err, undefined, 'exactly 10 images must pass validation');
});

test('the single cover `image` field is completely unaffected by an images gallery being present', () => {
  const [cast] = castMenuItems([
    {
      name: 'Pizza', price: 12,
      image: { url: 'https://example.com/cover.jpg', public_id: 'cover-pid' },
      images: [{ url: 'https://example.com/extra1.jpg' }, { url: 'https://example.com/extra2.jpg' }],
    },
  ]);
  assert.equal(cast.image.url, 'https://example.com/cover.jpg');
  assert.equal(cast.image.public_id, 'cover-pid');
  assert.equal(cast.images.length, 2);
});
