// tests/waCatalogCrudSync.test.mjs
//
// [CATALOG-CRUD-1] / [CATALOG-CRUD-2] Regression tests for extending
// syncMenuToCatalog() from UPDATE-only to full CRUD against Meta's Catalog
// Batch API:
//   - CREATE/UPDATE: every current menu item (available or not) gets an
//     UPDATE request (Meta's UPDATE method is upsert, so this covers both
//     brand-new items and edits to existing ones)
//   - DELETE: items present in the previous sync (waCatalog.syncedRetailerIds)
//     but no longer in menuItems get an explicit DELETE request
//   - the previously-filtered-out `available === false` items are no longer
//     dropped from the batch entirely — they're sent with `availability:
//     'out of stock'` instead, so toggling availability actually reflects on
//     Meta rather than freezing the item's last-known state forever
//
// This is a source-text guard (not a live-DB/Graph-API test), consistent
// with waCatalogSyncRoute.test.mjs / waCatalogPartialUpdate.test.mjs, since
// this environment doesn't have mongoose installed to actually construct a
// Tenant/BusinessConfig document.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const svcSrc = read('../modules/catalog/waCatalogService.js');
const modelSrc = read('../models/BusinessConfig.js');

test('syncMenuToCatalog no longer filters out unavailable items from the batch', () => {
  // The old, buggy version: menu = menuItems.filter(i => i.available !== false)
  // which built menuItems and IMMEDIATELY dropped anything unavailable before
  // it could ever be sent as an "out of stock" update.
  assert.doesNotMatch(
    svcSrc,
    /const menu = \(business\?\.menuItems \|\| \[\]\)\.filter\(i => i\.available !== false\)/,
  );
  // New version keeps every current item, reflecting availability in the
  // Graph API payload instead of via omission.
  assert.match(svcSrc, /const menu = business\?\.menuItems \|\| \[\]/);
  assert.match(svcSrc, /availability: item\.available !== false \? 'in stock' : 'out of stock'/);
});

test('syncMenuToCatalog builds DELETE requests for retailer_ids dropped since the last sync', () => {
  assert.match(svcSrc, /const currentRetailerIds = new Set\(allCurrentItems\.map\(i => i\.retailer_id\)\)/);
  assert.match(svcSrc, /previouslySynced\s*=\s*business\?\.waCatalog\?\.syncedRetailerIds/);
  assert.match(svcSrc, /method:\s*'DELETE'/);
  // Deletion set must exclude anything still present in the current menu —
  // i.e. it's a genuine diff, not "delete everything ever synced".
  assert.match(svcSrc, /filter\(id => id && !currentRetailerIds\.has\(id\)\)/);
});

test('syncMenuToCatalog sends UPDATE, drift-reconciliation, and DELETE requests in a single combined batch [FIX-CATALOG-DRIFT-RECONCILE]', () => {
  assert.match(svcSrc, /const requests = \[\.\.\.updateRequests, \.\.\.driftRequests, \.\.\.deleteRequests\]/);
});

test('syncMenuToCatalog persists the new syncedRetailerIds snapshot after a successful sync [FIX-CATALOG-OPTIMISTIC-CONFIRM]', () => {
  // Superseded by [FIX-CATALOG-OPTIMISTIC-CONFIRM]: the snapshot now holds only
  // CONFIRMED-live retailer_ids (previouslySynced ∩ currentRetailerIds, plus
  // whatever just cleared its batch handle with no errors) — not every current
  // item unconditionally, since a 200 on the POST doesn't mean every item
  // actually validated on Meta's side.
  assert.match(svcSrc, /'waCatalog\.syncedRetailerIds':\s*\[\.\.\.confirmedRetailerIds\]/);
});

test('syncMenuToCatalog returns synced and deleted counts separately', () => {
  assert.match(svcSrc, /return \{ ok: true, synced: 0, deleted: 0, skipped: allCurrentItems\.length, invalidSkipped: invalidSkipped\.length \}/);
  // [FIX-CATALOG-OPTIMISTIC-CONFIRM] `synced` now counts only items whose
  // batch handle actually resolved clean this run (newlyConfirmed), not every
  // item that was merely included in the UPDATE request.
  assert.match(svcSrc, /synced:\s*newlyConfirmed\.length,/);
});

// [CATALOG-DELTA-1] New regression guards for delta sync: only items whose
// content hash changed since the last sync should be sent as UPDATE requests,
// cutting Graph API payload size as a tenant's catalog grows.
test('syncMenuToCatalog computes a content hash per item and only re-sends changed items', () => {
  assert.match(svcSrc, /function hashItemData\(data\)/);
  assert.match(svcSrc, /const changedItems = allCurrentItems\.filter\(/);
  assert.match(svcSrc, /previousHashes\.get\(i\.retailer_id\) !== i\.hash/);
});

test('syncMenuToCatalog persists syncedItemHashes only for CONFIRMED items — unconfirmed/failed items keep retrying [FIX-CATALOG-OPTIMISTIC-CONFIRM]', () => {
  // Superseded by [FIX-CATALOG-OPTIMISTIC-CONFIRM]: writing every current
  // item's hash unconditionally (the old assertion here) meant an item Meta
  // silently rejected got marked "synced" forever, since the next run's
  // delta-diff would see its hash already matching and never re-upload it.
  // The new snapshot merges unchanged-and-already-confirmed items with only
  // the subset of THIS run's changed items whose batch handle resolved clean.
  assert.match(svcSrc, /const confirmedHashes = \{/);
  assert.match(svcSrc, /'waCatalog\.syncedItemHashes':\s*confirmedHashes/);
  assert.match(svcSrc, /allHandlesCleanNow = handles\.length > 0/);
});

test('BusinessConfig schema stores waCatalog.syncedRetailerIds as a string array defaulting to empty', () => {
  assert.match(modelSrc, /syncedRetailerIds:\s*\{\s*type:\s*\[String\],\s*default:\s*\[\]\s*\}/);
});

test('BusinessConfig schema stores waCatalog.syncedItemHashes as a String map defaulting to empty', () => {
  assert.match(modelSrc, /syncedItemHashes:\s*\{\s*type:\s*Map,\s*of:\s*String,\s*default:\s*\{\}\s*\}/);
});

test('businessController.syncWaCatalog surfaces the deleted count in its response', () => {
  const src = read('../controllers/businessController.js');
  const idx = src.indexOf('export async function syncWaCatalog');
  const end = src.indexOf('\nexport async function getWaCatalogHealth', idx);
  const body = src.slice(idx, end === -1 ? idx + 4000 : end);
  // [AUDIT-FIX-CATALOG-INVISIBLE-SKIPS] Response now also surfaces
  // skippedInvalid (items excluded from sync for missing image/invalid
  // price) — the field this test guards for (deleted) is still present,
  // just formatted across multiple lines instead of one.
  assert.match(body, /synced:\s*result\.synced,/);
  assert.match(body, /deleted:\s*result\.deleted \|\| 0,/);
  assert.match(body, /skippedInvalid:\s*result\.invalidSkipped \|\| 0,/);
});

test('the autosync scheduler logs the deleted count on a successful debounced sync', () => {
  const src = read('../modules/catalog/waCatalogSyncScheduler.js');
  assert.match(src, /synced: result\.synced, deleted: result\.deleted \|\| 0/);
});
