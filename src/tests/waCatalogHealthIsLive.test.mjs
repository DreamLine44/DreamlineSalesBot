// tests/waCatalogHealthIsLive.test.mjs
//
// Regression tests for [FIX-CATALOG-HEALTH-ISLIVE]: GET /:tenantId/wacatalog/health
// (businessController.js) previously returned enabled/catalogId/lastSyncedAt/
// lastSyncError/itemsReady — every one of which could look green — while the
// tenant still failed isCatalogEnabled() (waCatalogConfig.js) purely because
// waCatalog.syncedRetailerIds was empty, since that field was never exposed.
// isCatalogEnabled() is the literal gate every send path (shouldOfferCatalog,
// shouldShowCatalogButton) checks, so a "healthy" response could coexist with
// a customer never seeing the catalog.
//
// This fix makes getWaCatalogHealth() call the real isCatalogEnabled()
// (not a re-derived copy of its conditions) and return it as `isLive`, plus
// a `blockedBy` array naming every failing precondition, and exposes
// `syncedRetailerIds` as a count.
//
// This is a source-text guard (not a live-DB test), consistent with
// waCatalogSyncRoute.test.mjs / waCatalogPartialUpdate.test.mjs.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const controllerSrc = read('../controllers/businessController.js');
const configSrc      = read('../modules/catalog/waCatalogConfig.js');

function healthBody() {
  const idx = controllerSrc.indexOf('export async function getWaCatalogHealth');
  assert.notEqual(idx, -1, 'getWaCatalogHealth() should exist');
  return controllerSrc.slice(idx);
}

test('getWaCatalogHealth(): imports and calls the real isCatalogEnabled(), not a re-derived copy', () => {
  const body = healthBody();
  assert.match(
    body,
    /import\(['"]\.\.\/modules\/catalog\/waCatalogConfig\.js['"]\)/,
    'must import from waCatalogConfig.js — the single source of truth for the gate'
  );
  assert.match(
    body,
    /isLive:\s*isCatalogEnabled\(business\)/,
    'isLive must be the direct result of calling isCatalogEnabled(business), ' +
    'so it can never drift out of sync with what send paths actually check'
  );
});

test('getWaCatalogHealth(): blockedBy names every precondition isCatalogEnabled() checks', () => {
  const body = healthBody();
  // isCatalogEnabled() checks: enabled, catalogId, lastSyncedAt, syncedRetailerIds.length > 0
  for (const key of ['not_enabled', 'no_catalog_id', 'never_synced', 'no_synced_retailer_ids', 'no_sellable_products']) {
    assert.ok(body.includes(`'${key}'`), `blockedBy must be able to report '${key}'`);
  }
});

test('getWaCatalogHealth(): exposes syncedRetailerIds as a count, closing the original blind spot', () => {
  const body = healthBody();
  assert.match(
    body,
    /syncedRetailerIds:\s*syncedRetailerCount/,
    'response must expose syncedRetailerIds — the field isCatalogEnabled() checks that ' +
    'was previously invisible to this endpoint entirely'
  );
});

test('sanity: isCatalogEnabled() in waCatalogConfig.js still checks all four preconditions blockedBy models', () => {
  const idx = configSrc.indexOf('export function isCatalogEnabled');
  const body = configSrc.slice(idx, idx + 400);
  assert.match(body, /wc\?\.enabled/);
  assert.match(body, /wc\?\.catalogId/);
  assert.match(body, /wc\?\.lastSyncedAt/);
  assert.match(body, /syncedRetailerIds/);
});
