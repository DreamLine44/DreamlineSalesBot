// tests/multiImageCatalogSync.test.mjs
//
// Regression tests for [FEAT-MULTI-IMAGE]'s Meta catalog sync side:
// waCatalogService.js's buildItemData() must send gallery photos
// (menuItemSchema.images) under Meta's own `additional_image_urls` product
// feed field, entirely separate from the existing `image_link` (which stays
// sourced from the single cover `image` field, unchanged).
//
// buildItemData() is an inner closure inside syncMenuToCatalog(), not
// exported, so — consistent with this codebase's existing convention for
// this exact file (see waCatalogCrudSync.test.mjs, waCatalogPartialUpdate.
// test.mjs: "source-text guard ... since this environment doesn't have
// mongoose installed to actually construct a Tenant/BusinessConfig
// document") — these are source-text guards over waCatalogService.js.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const svcSrc = read('../modules/catalog/waCatalogService.js');

test('buildItemData sends gallery images as additional_image_urls, separate from image_link', () => {
  assert.match(
    svcSrc,
    /additional_image_urls:\s*item\.images\.slice\(0,\s*MAX_ADDITIONAL_IMAGES\)\.map\(img => img\.url\)\.filter\(Boolean\)/,
    'expected gallery images to be mapped to Meta\'s additional_image_urls field',
  );
  // image_link must still come from the single cover `image` field, not from
  // `images` — the primary sync contract must be completely unchanged.
  assert.match(svcSrc, /image_link:\s*item\.image\.url/);
});

test('additional_image_urls is only included when the item actually has gallery images (never sent as an empty array)', () => {
  const idx = svcSrc.indexOf('additional_image_urls: item.images');
  assert.ok(idx !== -1, 'anchor not found');
  const before = svcSrc.slice(Math.max(0, idx - 200), idx);
  assert.match(
    before,
    /Array\.isArray\(item\.images\)\s*&&\s*item\.images\.length/,
    'expected additional_image_urls to be conditionally spread in, matching the existing image_link/description pattern',
  );
});

test('additional_image_urls is capped at 10 items via a named constant, matching the schema-level gallery cap', () => {
  assert.match(svcSrc, /const MAX_ADDITIONAL_IMAGES = 10;/);
  assert.match(svcSrc, /item\.images\.slice\(0,\s*MAX_ADDITIONAL_IMAGES\)/);
});

test('additional_image_urls participates in hashItemData()\'s content hash, so gallery changes trigger a re-sync', () => {
  // buildItemData()'s return value (which now includes additional_image_urls)
  // is exactly what gets passed into hashItemData() below it — confirm the
  // additional_image_urls line lives inside buildItemData's returned object,
  // between its opening brace and the function's closing `};`.
  const startIdx = svcSrc.indexOf('const buildItemData = (item, variantName = null) => {');
  const endIdx = svcSrc.indexOf('\n  };', startIdx);
  assert.ok(startIdx !== -1 && endIdx !== -1, 'could not locate buildItemData function body');
  const body = svcSrc.slice(startIdx, endIdx);
  assert.match(body, /additional_image_urls/, 'additional_image_urls must be part of the object buildItemData returns (and therefore part of the hash)');
});

test('the FIX-CATALOG-FIELD-NAMES image_link contract (single required cover photo) is untouched by the gallery addition', () => {
  // Guards against a regression where someone "simplifies" by folding the
  // cover image into the images array instead of keeping them independent.
  assert.match(svcSrc, /\.\.\.\(item\.image\?\.url\s*\?\s*\{ image_link: item\.image\.url \}\s*:\s*\{\}\),/);
});
