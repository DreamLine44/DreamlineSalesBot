// tests/waCatalogSyncRoute.test.mjs
//
// Regression tests for [CATALOG-SYNC-ROUTE-*]: wiring the previously-unused
// waCatalogService.syncMenuToCatalog() to a real endpoint,
// POST /:tenantId/wacatalog/sync, in businessController.js/businessRoutes.js.
//
// Before this change, syncMenuToCatalog() was fully written and unit-tested
// (waCatalogNormalization / waCatalogDispatcherPayload) but had zero callers
// anywhere in the app — there was no way for a tenant to actually push
// menuItems into their Meta Commerce Catalog short of calling the function
// manually from a Node console.
//
// Covers:
//   (a) the route is registered, tenant-scoped, and rate-limited
//   (b) syncWaCatalog() rejects with 400 BEFORE touching Tenant/Graph API at
//       all when waCatalog isn't enabled or has no catalogId — mirrors
//       isCatalogEnabled() in waCatalogConfig.js so the same "opted in" bar
//       applies everywhere WA Catalog is gated
//   (c) the Tenant document is loaded with .lean() (accessToken must survive —
//       Tenant's toJSON transform strips it, and .lean() bypasses that
//       transform, consistent with every other tenant fetch that needs
//       whatsapp.accessToken, e.g. dashboardController.loadTenant())
//   (d) failure reasons are mapped to the right HTTP status (400 for a
//       caller-fixable NO_TOKEN/NO_CATALOG_ID, 502 for an actual Graph error)
//
// This is a source-text guard (not a live-DB test), consistent with how
// leadCaptureTriggerAudit.test.mjs / waCatalogPartialUpdate.test.mjs guard
// other fixes in modules that need Mongo + Graph API wired up to invoke live.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const controllerSrc = read('../controllers/businessController.js');
const routesSrc      = read('../routes/businessRoutes.js');
const limiterSrc      = read('../middleware/rateLimiter.js');

test('route: POST /:tenantId/wacatalog/sync is registered, tenant-scoped, and rate-limited', () => {
  assert.match(
    routesSrc,
    /r\.post\('\/:tenantId\/wacatalog\/sync',\s*enforceTenantScope,\s*catalogSyncLimiter,\s*syncWaCatalog\)/,
    'sync route must exist with enforceTenantScope + catalogSyncLimiter + syncWaCatalog, in that order'
  );
});

test('rate limiter: catalogSyncLimiter is defined with a strict per-minute cap', () => {
  assert.match(limiterSrc, /export const catalogSyncLimiter/);
  const idx = limiterSrc.indexOf('export const catalogSyncLimiter');
  const block = limiterSrc.slice(idx, idx + 300);
  assert.match(block, /max:\s*(\d+)/);
  const max = Number(block.match(/max:\s*(\d+)/)[1]);
  assert.ok(max <= 10, `catalogSyncLimiter max (${max}) should stay strict — this hits Meta's Graph API`);
});

test('syncWaCatalog(): rejects with 400 before loading Tenant when waCatalog is not enabled or has no catalogId', () => {
  const idx = controllerSrc.indexOf('export async function syncWaCatalog');
  assert.notEqual(idx, -1, 'syncWaCatalog() should exist');
  const body = controllerSrc.slice(idx, controllerSrc.indexOf('export async function listSupportedModes'));

  const enabledCheckIdx = body.search(/waCatalog\?\.enabled|waCatalog\?\.catalogId/);
  const tenantFetchIdx  = body.indexOf("import('../models/Tenant.js')");
  assert.notEqual(enabledCheckIdx, -1, 'must check waCatalog.enabled/catalogId');
  assert.notEqual(tenantFetchIdx, -1, 'must load the Tenant document');
  assert.ok(
    enabledCheckIdx < tenantFetchIdx,
    'the enabled/catalogId guard must run BEFORE the Tenant document is fetched — ' +
    'a misconfigured tenant should get a clear 400, not an unnecessary DB round-trip ' +
    'followed by a confusing downstream Graph API failure'
  );
});

test('syncWaCatalog(): loads the Tenant document with .lean() so the encrypted accessToken is present', () => {
  const idx = controllerSrc.indexOf('export async function syncWaCatalog');
  const body = controllerSrc.slice(idx, controllerSrc.indexOf('export async function listSupportedModes'));
  assert.match(
    body,
    /Tenant\.findById\(tenantId\)\.lean\(\)/,
    'Tenant.findById(tenantId) must be .lean() — toJSON strips accessToken otherwise, ' +
    'and syncMenuToCatalog() needs the raw encrypted token to decrypt and call the Graph API'
  );
});

test('syncWaCatalog(): maps NO_TOKEN/NO_CATALOG_ID to 400 (caller-fixable) and everything else to 502 (upstream failure)', () => {
  const idx = controllerSrc.indexOf('export async function syncWaCatalog');
  const body = controllerSrc.slice(idx, controllerSrc.indexOf('export async function listSupportedModes'));
  assert.match(
    body,
    /reason === 'NO_TOKEN' \|\| result\.reason === 'NO_CATALOG_ID'\s*\?\s*400\s*:\s*502/,
    'result.reason must be mapped to 400 for NO_TOKEN/NO_CATALOG_ID and 502 otherwise'
  );
});
