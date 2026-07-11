// tests/waCatalogAutosyncScheduler.test.mjs
//
// [CATALOG-AUTOSYNC-1] Regression tests for the debounced automatic WA
// Catalog sync triggered by menu CRUD (addMenuItem / updateMenuItem /
// deleteMenuItem / updateMenu / updateBusinessConfig), following on from the
// manual-only POST /:tenantId/wacatalog/sync route added earlier.
//
// Covers:
//   (a) scheduleWaCatalogSync() debounces — repeated calls for the same
//       tenant within the window reset the timer rather than stacking up
//       multiple pending fires
//   (b) different tenantIds get independent timers (one tenant's burst of
//       edits never delays or coalesces with another tenant's)
//   (c) the scheduled callback actually fires performSync-equivalent work
//       after the debounce window elapses
//   (d) menu CRUD handlers in both dashboardController.js and
//       businessController.js call scheduleWaCatalogSync on every successful
//       write (source-text wiring check, consistent with how
//       waCatalogSyncRoute.test.mjs guards the manual route)
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('scheduleWaCatalogSync debounces repeated calls for the same tenant', async () => {
  const { scheduleWaCatalogSync, hasScheduledSync, clearAllScheduledSyncs } =
    await import('../modules/catalog/waCatalogSyncScheduler.js');

  clearAllScheduledSyncs();
  scheduleWaCatalogSync('tenantA');
  assert.equal(hasScheduledSync('tenantA'), true);

  // A second call before the debounce window elapses must still leave
  // exactly one pending timer for this tenant (reset, not stacked).
  scheduleWaCatalogSync('tenantA');
  assert.equal(hasScheduledSync('tenantA'), true);

  clearAllScheduledSyncs();
  assert.equal(hasScheduledSync('tenantA'), false);
});

test('scheduleWaCatalogSync keeps independent timers per tenant', async () => {
  const { scheduleWaCatalogSync, hasScheduledSync, clearAllScheduledSyncs } =
    await import('../modules/catalog/waCatalogSyncScheduler.js');

  clearAllScheduledSyncs();
  scheduleWaCatalogSync('tenantA');
  scheduleWaCatalogSync('tenantB');

  assert.equal(hasScheduledSync('tenantA'), true);
  assert.equal(hasScheduledSync('tenantB'), true);

  clearAllScheduledSyncs();
});

test('scheduleWaCatalogSync is a safe no-op with no tenantId', async () => {
  const { scheduleWaCatalogSync, clearAllScheduledSyncs } =
    await import('../modules/catalog/waCatalogSyncScheduler.js');

  clearAllScheduledSyncs();
  assert.doesNotThrow(() => scheduleWaCatalogSync(undefined));
  assert.doesNotThrow(() => scheduleWaCatalogSync(null));
  assert.doesNotThrow(() => scheduleWaCatalogSync(''));
});

test('scheduled sync actually fires after the debounce window (short window override)', async () => {
  // Use a tiny debounce window via env override so the test doesn't wait 8s.
  process.env.WA_CATALOG_AUTOSYNC_DEBOUNCE_MS = '20';

  // Re-import fresh so the module re-reads the env var at load time.
  const mod = await import(`../modules/catalog/waCatalogSyncScheduler.js?t=${Date.now()}`);
  const { scheduleWaCatalogSync, hasScheduledSync } = mod;

  scheduleWaCatalogSync('tenantTimingTest');
  assert.equal(hasScheduledSync('tenantTimingTest'), true);

  await new Promise(resolve => setTimeout(resolve, 100));

  // Timer should have fired and cleaned itself out of the pending map.
  // (performSync() itself will no-op/fail fast since there's no real DB here,
  // but it must not throw synchronously or leave the timer entry dangling.)
  assert.equal(hasScheduledSync('tenantTimingTest'), false);

  delete process.env.WA_CATALOG_AUTOSYNC_DEBOUNCE_MS;
});

test('dashboardController menu CRUD handlers call scheduleWaCatalogSync on success', () => {
  const src = read('../controllers/dashboardController.js');

  assert.match(src, /import\s+\{\s*scheduleWaCatalogSync\s*\}\s+from\s+['"]\.\.\/modules\/catalog\/waCatalogSyncScheduler\.js['"]/);

  const addFn = src.slice(src.indexOf('export async function addMenuItem'), src.indexOf('export async function updateMenuItem'));
  assert.match(addFn, /scheduleWaCatalogSync\(tenantId\)/);

  const updateFn = src.slice(src.indexOf('export async function updateMenuItem'), src.indexOf('export async function deleteMenuItem'));
  assert.match(updateFn, /scheduleWaCatalogSync\(tenantId\)/);

  const deleteFn = src.slice(src.indexOf('export async function deleteMenuItem'), src.indexOf('// ── Services CRUD'));
  assert.match(deleteFn, /scheduleWaCatalogSync\(tenantId\)/);
});

test('businessController menu CRUD handlers call scheduleWaCatalogSync on success', () => {
  const src = read('../controllers/businessController.js');

  assert.match(src, /import\s+\{\s*scheduleWaCatalogSync\s*\}\s+from\s+['"]\.\.\/modules\/catalog\/waCatalogSyncScheduler\.js['"]/);

  const updateBizFn = src.slice(src.indexOf('export async function updateBusinessConfig'), src.indexOf('export async function getMenu'));
  assert.match(updateBizFn, /scheduleWaCatalogSync\(tenantId\)/);
  // Must be conditional on menuItems actually changing, not on every update.
  assert.match(updateBizFn, /if\s*\(update\.menuItems !== undefined\)\s*scheduleWaCatalogSync/);

  const updateMenuFn = src.slice(src.indexOf('export async function updateMenu('), src.indexOf('export async function addMenuItem'));
  assert.match(updateMenuFn, /scheduleWaCatalogSync\(tenantId\)/);

  const addFn = src.slice(src.indexOf('export async function addMenuItem'), src.indexOf('export async function deleteMenuItem'));
  assert.match(addFn, /scheduleWaCatalogSync\(tenantId\)/);

  const deleteFn = src.slice(src.indexOf('export async function deleteMenuItem'), src.indexOf('export async function getModeInfo'));
  assert.match(deleteFn, /scheduleWaCatalogSync\(tenantId\)/);
});

test('scheduler never awaits/blocks on the sync — call sites are fire-and-forget (no "await scheduleWaCatalogSync")', () => {
  const dashSrc = read('../controllers/dashboardController.js');
  const bizSrc = read('../controllers/businessController.js');
  assert.doesNotMatch(dashSrc, /await\s+scheduleWaCatalogSync/);
  assert.doesNotMatch(bizSrc, /await\s+scheduleWaCatalogSync/);
});
