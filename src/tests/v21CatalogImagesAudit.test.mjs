// tests/v21CatalogImagesAudit.test.mjs
//
// Regression tests for the v21 "catalog images not displaying" audit.
//
// Root causes found and fixed:
//
// [FEAT-CATALOG-IMAGES] Only restaurant/flows/orderFlow.js ever sent a
// product's uploaded photo to the customer in chat. The admin upload
// pipeline (menuImageController.js → Cloudinary → BusinessConfig.menuItems[
// ].image.url) was correct for every vertical, and WA Catalog sync
// (waCatalogService.js) correctly reads item.image.url too — but retail,
// fashion, electronics, cosmetics, and bakery never actually dispatched an
// image message, so a tenant on the fallback (non-Meta-Catalog) chat tier
// never saw their product photos regardless of vertical. Fixed by rolling
// out the same [type: 'image', url, caption] + follow-up-prompt array
// pattern restaurant already used correctly.
//
// [AUDIT-FIX-CATALOG-HEALTH] waCatalogService.js has written
// waCatalog.lastSyncError / lastSyncedAt since an earlier session
// ([CATALOG-HEALTH-4]), with a comment promising a GET .../wacatalog/health
// endpoint to read them — that endpoint was never actually built, so an
// admin had no way to see WHY a catalog sync produced zero visible products
// (not enabled, no catalogId, sync failing, or every item skipped for
// missing an image / invalid price) without reading server logs directly.
//
// [AUDIT-FIX-CATALOG-INVISIBLE-SKIPS] syncWaCatalog's response dropped the
// invalidSkipped count that syncMenuToCatalog() already computed, so
// "{ ok: true, synced: 0 }" gave no indication that the whole catalog was
// silently excluded for missing images.
//
// [AUDIT-FIX-LISTCAP] A corrected sweep (the earlier v20 sweep used a
// literal "?" in a basic-regex grep instead of extended regex, so it
// silently matched nothing) found FIVE more untouched 10-item truncations:
// electronics/handlers/uiBuilders.js's buildProductList, salon/flows/
// index.js's service and stylist pickers (x2), and cosmetics/flows/
// orderFlow.js's product menu and shade picker (x2). All fixed the same way
// as every prior instance — removed, since dispatcher.js now chunks both
// the flat `rows` format and any caller-supplied `sections` entry.
//
// Consistent with this codebase's existing convention: source-text guards,
// since calling the flow handlers directly requires a live Mongo connection.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── catalog health endpoint ────────────────────────────────────────────────

test('businessController.js exports getWaCatalogHealth', () => {
  const src = read('../controllers/businessController.js');
  assert.match(src, /export async function getWaCatalogHealth\(req, res\)/);
  assert.match(src, /lastSyncError:\s*business\.waCatalog\?\.lastSyncError\?\.reason/);
  assert.match(src, /itemsSkipped:\s*skipped\.length/);
});

test('businessRoutes.js registers GET /:tenantId/wacatalog/health', () => {
  const src = read('../routes/businessRoutes.js');
  assert.match(src, /getWaCatalogHealth/);
  assert.match(
    src,
    /r\.get\('\/:tenantId\/wacatalog\/health',\s*enforceTenantScope,\s*getWaCatalogHealth\)/
  );
});

test('businessController.js syncWaCatalog response surfaces skippedInvalid', () => {
  const src = read('../controllers/businessController.js');
  const idx = src.indexOf('export async function syncWaCatalog');
  const end = src.indexOf('\nexport async function getWaCatalogHealth', idx);
  const body = src.slice(idx, end === -1 ? idx + 4000 : end);
  assert.match(body, /skippedInvalid:\s*result\.invalidSkipped \|\| 0,/);
});

// ── image rollout across product verticals ────────────────────────────────

const IMAGE_VERTICALS = [
  { file: '../modules/retail/flows/index.js',            fn: 'function _buildItemDetail' },
  { file: '../modules/fashion/flows/index.js',            fn: '// Check if item has variants' },
  { file: '../modules/electronics/handlers/uiBuilders.js', fn: 'export function buildItemDetail' },
  { file: '../modules/cosmetics/flows/orderFlow.js',       fn: 'let nextPrompt;' },
  { file: '../modules/bakery/flows/orderFlow.js',          fn: 'if (!item) return _buildBakeryMenu' },
];

for (const { file, fn } of IMAGE_VERTICALS) {
  test(`${file.split('/').slice(-3).join('/')}: sends the item photo when one is set`, () => {
    const src = read(file);
    assert.match(src, /import \{ buildWhatsAppImageUrl \} from '.*cloudinary\.js'/, 'expected the cloudinary URL helper to be imported');
    const idx = src.indexOf(fn);
    assert.ok(idx !== -1, `anchor "${fn}" not found`);
    const body = src.slice(idx, idx + 2600);
    assert.match(body, /type:\s*'image'/, 'expected an image message to be built');
    assert.match(body, /buildWhatsAppImageUrl\(imageUrl\)/, 'expected the image URL to go through buildWhatsAppImageUrl');
    assert.match(body, /showImageOnSelect !== false/, 'expected showImageOnSelect to still gate the image, matching restaurant\'s existing behaviour');
  });
}

// ── remaining truncation bugs found by the corrected sweep ────────────────

test('electronics/handlers/uiBuilders.js: buildProductList no longer truncates to 10 items', () => {
  const src = read('../modules/electronics/handlers/uiBuilders.js');
  const idx = src.indexOf('export function buildProductList');
  const body = src.slice(idx, idx + 1200);
  assert.doesNotMatch(body, /\.slice\(0,\s*10\)/);
  assert.match(body, /items\.map\(\(item, i\)/);
});

test('salon/flows/index.js: service and stylist list builders no longer truncate to 10 rows', () => {
  const src = read('../modules/salon/flows/index.js');
  assert.doesNotMatch(src, /services\.slice\(0,\s*10\)/);
  assert.doesNotMatch(src, /options\.slice\(0,\s*10\)/);
});

test('cosmetics/flows/orderFlow.js: product menu and shade picker no longer truncate to 10 rows', () => {
  const src = read('../modules/cosmetics/flows/orderFlow.js');
  assert.doesNotMatch(src, /items\.slice\(0,\s*10\)/);
  assert.doesNotMatch(src, /shades\.slice\(0,\s*10\)/);
});

test('a corrected extended-regex sweep of src/modules finds zero remaining item-count truncations', () => {
  // Guards the regex bug itself: `\.slice\(0, ?10\)` is a BASIC-regex pattern
  // where "?" is a literal character, not "0 or 1 of the preceding space" —
  // it silently matches nothing. The correct pattern is `\.slice\(0,\s*10\)`.
  const dirs = ['../modules/retail', '../modules/fashion', '../modules/electronics',
                '../modules/cosmetics', '../modules/bakery', '../modules/salon',
                '../modules/restaurant', '../modules/delivery', '../modules/services',
                '../modules/general', '../modules/catalog'];
  for (const dir of dirs) {
    const base = new URL(dir + '/', import.meta.url);
    walk(base);
  }
  function walk(dirUrl) {
    let entries;
    try { entries = fs.readdirSync(dirUrl, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
      if (entry.isDirectory()) { walk(childUrl); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const content = fs.readFileSync(childUrl, 'utf8');
      assert.doesNotMatch(
        content,
        /\.slice\(0,\s*10\)/,
        `unexpected item-count truncation found in ${entry.name}`
      );
    }
  }
});
