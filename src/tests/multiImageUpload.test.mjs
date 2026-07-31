// tests/multiImageUpload.test.mjs
//
// [FEAT-MULTI-IMAGE] Regression tests for gallery (multi-image) upload
// support. Source-text guards (not a live-DB/Cloudinary/Graph-API test),
// consistent with the other waCatalog*.test.mjs files in this suite, since
// this environment doesn't have mongoose/multer/cloudinary installed to
// actually exercise the endpoints end-to-end.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const modelSrc = read('../models/BusinessConfig.js');
const svcSrc = read('../modules/catalog/waCatalogService.js');
const controllerSrc = read('../controllers/menuImageController.js');
const middlewareSrc = read('../middleware/uploadMiddleware.js');
const routesSrc = read('../routes/dashboardRoutes.js');

test('menuItemSchema gains an images[] gallery array, capped at 10, alongside the untouched primary image field', () => {
  assert.match(modelSrc, /images:\s*\{/);
  assert.match(modelSrc, /v\.length <= 10/);
  // The primary field must remain exactly as-is — every existing reader
  // (WhatsApp single-image sends, Meta image_link, isSyncableForCatalog)
  // depends on this shape not changing.
  assert.match(modelSrc, /image:\s*\{\s*\n\s*url:\s*\{ type: String, default: null, trim: true \},\s*\n\s*public_id:\s*\{ type: String, default: null, trim: true \},\s*\n\s*\},/);
});

test('buildItemData maps item.images[] to Meta additional_image_link without touching image_link', () => {
  assert.match(svcSrc, /additional_image_link/);
  // Primary image mapping (image_link) must be untouched from before this feature.
  assert.match(svcSrc, /item\.image\?\.url\s*\?\s*\{ image_link: item\.image\.url \}/);
  // Additional images are comma-joined and capped at 10, matching Meta's field limit.
  assert.match(svcSrc, /\.slice\(0,\s*10\)/);
  assert.match(svcSrc, /additionalImageLinks\.join\(','\)/);
});

test('buildItemData omits additional_image_link entirely when an item has no gallery photos (no payload change for existing tenants)', () => {
  assert.match(svcSrc, /additionalImageLinks\.length\s*\?\s*\{ additional_image_link: additionalImageLinks\.join\(','\) \}\s*:\s*\{\}/);
});

test('menuImageController exposes multi-image upload and single-gallery-image removal', () => {
  assert.match(controllerSrc, /export async function uploadMenuItemImages/);
  assert.match(controllerSrc, /export async function removeMenuItemGalleryImage/);
  // Uploading must never overwrite the primary image once one already exists.
  assert.match(controllerSrc, /hasPrimary/);
  // Batch size is capped server-side, not just via multer's file-count limit.
  assert.match(controllerSrc, /MAX_GALLERY_IMAGES/);
  // Every image-mutating endpoint in this file must trigger a catalog sync —
  // this was the exact bug [FIX-CATALOG-IMAGE-AUTOSYNC] fixed for the single-image
  // endpoints, and the same gap would apply to a purely-additive gallery endpoint.
  const scheduleSyncCalls = controllerSrc.match(/scheduleWaCatalogSync\(tenantId\)/g) || [];
  assert.ok(scheduleSyncCalls.length >= 4, 'expected scheduleWaCatalogSync to be called from all four image endpoints (upload/remove x single/gallery)');
});

test('uploadMiddleware exposes an array-file uploader for the gallery endpoint with the same type/size validation as uploadSingle', () => {
  assert.match(middlewareSrc, /export function uploadMultiple/);
  assert.match(middlewareSrc, /upload\.array\('images',\s*MAX_FILES_PER_UPLOAD\)/);
});

test('dashboardRoutes wires the gallery endpoints without touching the existing single-image routes', () => {
  assert.match(routesSrc, /r\.post\('\/:tenantId\/menu\/:itemId\/images',\s*enforceTenantScope,\s*uploadMultiple,\s*uploadMenuItemImages\)/);
  assert.match(routesSrc, /r\.delete\('\/:tenantId\/menu\/:itemId\/images\/:publicId',\s*enforceTenantScope,\s*removeMenuItemGalleryImage\)/);
  // Existing single-image routes must still be present, unmodified.
  assert.match(routesSrc, /r\.post\('\/:tenantId\/menu\/:itemId\/image',\s*enforceTenantScope,\s*uploadSingle,\s*uploadMenuItemImage\)/);
  assert.match(routesSrc, /r\.delete\('\/:tenantId\/menu\/:itemId\/image',\s*enforceTenantScope,\s*removeMenuItemImage\)/);
});
