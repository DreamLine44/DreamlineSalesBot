// tests/multiImageGalleryController.test.mjs
//
// Regression tests for [FEAT-MULTI-IMAGE]'s controller endpoints:
// uploadMenuItemGalleryImages / removeMenuItemGalleryImage
// (controllers/menuImageController.js).
//
// removeMenuItemGalleryImage never touches Cloudinary's actual network API
// unless CLOUDINARY_ENABLED is true (deleteMenuImage() no-ops otherwise), so
// its DB logic is fully testable here by stubbing the BusinessConfig Model
// statics directly — same technique as postFlowAckStaleness.test.mjs (no
// live Mongo connection available in this environment).
//
// uploadMenuItemGalleryImages' two early-exit guards (missing files, and
// Cloudinary not configured) are also testable this way, since neither
// touches the DB. The cap-check / rollback-on-partial-failure logic that
// runs AFTER those guards requires an actual Cloudinary connection to
// exercise end-to-end, so — consistent with this codebase's established
// convention for logic that needs a live external service this environment
// doesn't have (see waCatalogCrudSync.test.mjs, v21CatalogImagesAudit.
// test.mjs) — that part is covered by a source-text guard instead.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import BusinessConfig from '../models/BusinessConfig.js';
import {
  uploadMenuItemGalleryImages,
  removeMenuItemGalleryImage,
} from '../controllers/menuImageController.js';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

function mockRes() {
  let statusCode = 200;
  let body = null;
  return {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

// ── uploadMenuItemGalleryImages: early-exit guards (no DB involved) ────────

test('uploadMenuItemGalleryImages: 400 when no files are provided', async () => {
  const req = { params: { tenantId: 't1', itemId: 'i1' }, files: [] };
  const res = mockRes();
  await uploadMenuItemGalleryImages(req, res);
  assert.equal(res.getStatus(), 400);
  assert.match(res.getBody().error, /No image files provided/);
});

test('uploadMenuItemGalleryImages: 503 when Cloudinary is not configured (this test environment has no Cloudinary credentials)', async () => {
  const req = {
    params: { tenantId: 't1', itemId: 'i1' },
    files: [{ buffer: Buffer.from('x'), mimetype: 'image/jpeg' }],
  };
  const res = mockRes();
  await uploadMenuItemGalleryImages(req, res);
  assert.equal(res.getStatus(), 503);
  assert.match(res.getBody().error, /not configured/);
});

// ── removeMenuItemGalleryImage: full DB-level behavior, stubbed Model ──────

function withStubbedBusinessConfig({ existingItem, updatedItem }, run) {
  const originalFindOne = BusinessConfig.findOne;
  const originalFindOneAndUpdate = BusinessConfig.findOneAndUpdate;
  let updateCallArgs = null;

  BusinessConfig.findOne = () => ({
    lean: async () => existingItem,
  });
  BusinessConfig.findOneAndUpdate = (filter, update) => {
    updateCallArgs = { filter, update };
    return Promise.resolve(updatedItem);
  };

  return run({ getUpdateCallArgs: () => updateCallArgs }).finally(() => {
    BusinessConfig.findOne = originalFindOne;
    BusinessConfig.findOneAndUpdate = originalFindOneAndUpdate;
  });
}

test('removeMenuItemGalleryImage: 404 when the menu item itself does not exist', async () => {
  await withStubbedBusinessConfig({ existingItem: null, updatedItem: null }, async () => {
    const req = { params: { tenantId: 't1', itemId: 'missing-item', imageId: 'img1' } };
    const res = mockRes();
    await removeMenuItemGalleryImage(req, res);
    assert.equal(res.getStatus(), 404);
    assert.match(res.getBody().error, /Menu item not found/);
  });
});

test('removeMenuItemGalleryImage: 404 when the image id does not belong to this item\'s gallery', async () => {
  const existingItem = {
    menuItems: [{ _id: 'i1', images: [{ _id: 'img-real', url: 'https://x/1.jpg', public_id: 'p1' }] }],
  };
  await withStubbedBusinessConfig({ existingItem, updatedItem: null }, async () => {
    const req = { params: { tenantId: 't1', itemId: 'i1', imageId: 'img-does-not-exist' } };
    const res = mockRes();
    await removeMenuItemGalleryImage(req, res);
    assert.equal(res.getStatus(), 404);
    assert.match(res.getBody().error, /Gallery image not found/);
  });
});

test('removeMenuItemGalleryImage: pulls the matching image by _id (not by Cloudinary public_id) and leaves the rest of the gallery intact', async () => {
  const existingItem = {
    menuItems: [{
      _id: 'i1',
      images: [
        { _id: 'img-1', url: 'https://x/1.jpg', public_id: 'folder/sub/1' },
        { _id: 'img-2', url: 'https://x/2.jpg', public_id: 'folder/sub/2' },
      ],
    }],
  };
  const updatedItem = {
    menuItems: [{ _id: 'i1', images: [{ _id: 'img-2', url: 'https://x/2.jpg', public_id: 'folder/sub/2' }] }],
  };
  await withStubbedBusinessConfig({ existingItem, updatedItem }, async ({ getUpdateCallArgs }) => {
    const req = { params: { tenantId: 't1', itemId: 'i1', imageId: 'img-1' } };
    const res = mockRes();
    await removeMenuItemGalleryImage(req, res);

    assert.equal(res.getStatus(), 200);
    assert.equal(res.getBody().ok, true);

    const { filter, update } = getUpdateCallArgs();
    assert.equal(filter.tenantId, 't1');
    assert.equal(filter['menuItems._id'], 'i1');
    // Must pull by the gallery subdocument's own _id, never by public_id
    // (which routinely contains '/' from its Cloudinary folder path and
    // can't safely round-trip through a URL path segment).
    assert.deepEqual(update.$pull['menuItems.$.images'], { _id: 'img-1' });

    const returnedItem = res.getBody().menuItem;
    assert.equal(returnedItem.images.length, 1);
    assert.equal(returnedItem.images[0]._id, 'img-2');
  });
});

// ── source-text guard: logic that requires a live Cloudinary connection ───

const controllerSrc = read('../controllers/menuImageController.js');

test('uploadMenuItemGalleryImages: enforces the 10-image cap BEFORE any Cloudinary upload happens', () => {
  const idx = controllerSrc.indexOf('export async function uploadMenuItemGalleryImages');
  const capIdx = controllerSrc.indexOf('MAX_GALLERY_IMAGES', idx);
  const uploadIdx = controllerSrc.indexOf('uploadMenuImage(', idx);
  assert.ok(capIdx !== -1 && uploadIdx !== -1, 'expected both the cap check and an upload call in this function');
  assert.ok(capIdx < uploadIdx, 'the gallery-size cap must be checked before any file is uploaded to Cloudinary');
});

test('uploadMenuItemGalleryImages: rolls back any images that DID upload if a later file in the same batch fails', () => {
  const idx = controllerSrc.indexOf('export async function uploadMenuItemGalleryImages');
  const end = controllerSrc.indexOf('\nexport async function removeMenuItemGalleryImage', idx);
  const body = controllerSrc.slice(idx, end);
  assert.match(body, /catch \(uploadErr\)/);
  assert.match(body, /for \(const img of uploaded\) await deleteMenuImage\(img\.public_id\)/);
});

test('gallery endpoints never touch the single cover `image` field — only `images`', () => {
  const idx = controllerSrc.indexOf('export async function uploadMenuItemGalleryImages');
  const end = controllerSrc.indexOf('\n/**\n * DELETE /:tenantId/menu/:itemId/image\n');
  assert.ok(idx !== -1 && end !== -1 && end > idx, 'could not locate the gallery functions block');
  const body = controllerSrc.slice(idx, end);
  assert.doesNotMatch(body, /'menuItems\.\$\.image'(?!s)/, 'gallery endpoints must not write the singular menuItems.$.image field');
});
