// tests/updateTenantCatalogIdSync.test.mjs
//
// Regression tests for [FIX-CATALOGID-BUSINESSCONFIG-SYNC] / [FIX-SILENT-DROP-1].
//
// Bug: PATCH /admin/tenants/:id (updateTenant, tenantController.js) is the
// endpoint the admin panel's "Save Credentials" button calls. Its ALLOWED
// allowlist governs which fields get written to the Tenant document — but
// waCatalog.catalogId was never in it, and isn't even a Tenant schema field
// (it lives on BusinessConfig). Result: an admin typing a Catalog ID and
// saving got a "Credentials saved" toast while the ID was silently discarded
// and never written anywhere — the tenant's own Catalog page kept showing
// "Not set yet" indefinitely, and WA Catalog sync stayed permanently broken
// with no error pointing at the actual cause.
//
// Fix: catalogId is read out of req.body separately (both nested and flat
// forms) and written directly to BusinessConfig, mirroring the existing
// [AUDIT-P1-A] phoneNumberId sync block. A stale waCatalog.lastSyncError is
// cleared at the same time. Separately, any request field that isn't
// recognized (ALLOWED, the cross-model list, or `activate`) is now surfaced
// in the response as `ignored`, so this class of silent-drop bug can't hide
// behind a 200 again.
//
// This is a source-text guard (not a live-DB test), consistent with
// waCatalogSyncRoute.test.mjs and other fixes in modules that need Mongo
// wired up to invoke live.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const src = read('../controllers/tenantController.js');

function updateTenantBody() {
  const start = src.indexOf('export async function updateTenant');
  assert.notEqual(start, -1, 'updateTenant() should exist');
  const end = src.indexOf('export async function updateTenantStatus');
  assert.notEqual(end, -1, 'updateTenantStatus() should exist (used as the end boundary)');
  return src.slice(start, end);
}

test('updateTenant(): waCatalog.catalogId is NOT added to the Tenant-document ALLOWED list', () => {
  const body = updateTenantBody();
  const allowedIdx = body.indexOf('const ALLOWED = [');
  const allowedBlock = body.slice(allowedIdx, body.indexOf('];', allowedIdx));
  assert.ok(
    !/waCatalog\.catalogId/.test(allowedBlock),
    'waCatalog.catalogId must not be in ALLOWED — it is not a Tenant schema field; ' +
    'putting it there would either be silently dropped by Mongoose or sit unused ' +
    'on the wrong document instead of reaching BusinessConfig, where sync actually reads it from'
  );
});

test('updateTenant(): reads catalogId from both nested and flat request shapes', () => {
  const body = updateTenantBody();
  assert.match(
    body,
    /req\.body\.waCatalog\?\.catalogId\s*\?\?\s*req\.body\[['"]waCatalog\.catalogId['"]\]/,
    'must accept both { waCatalog: { catalogId } } and flat { "waCatalog.catalogId": ... }, ' +
    'matching the convention used for every other field on this endpoint'
  );
});

test('updateTenant(): writes catalogId straight to BusinessConfig, not to the Tenant document', () => {
  const body = updateTenantBody();
  const idx = body.indexOf('catalogIdUpdate');
  assert.notEqual(idx, -1);
  assert.match(
    body,
    /BusinessConfig\.findOneAndUpdate\(\s*\{\s*tenantId:\s*String\(req\.params\.id\)\s*\},\s*\{\s*\$set:\s*\{\s*['"]waCatalog\.catalogId['"]:\s*catalogIdUpdate/,
    'catalogId must be written directly to BusinessConfig keyed by tenantId, mirroring the ' +
    'existing phoneNumberId sync block ([AUDIT-P1-A]) already in this same function'
  );
});

test('updateTenant(): clears any stale waCatalog.lastSyncError when a new catalogId is set', () => {
  const body = updateTenantBody();
  const idx = body.indexOf("'waCatalog.catalogId':    catalogIdUpdate");
  assert.notEqual(idx, -1, 'the BusinessConfig $set block setting catalogId should exist');
  const nearby = body.slice(idx, idx + 300);
  assert.match(
    nearby,
    /waCatalog\.lastSyncError['"]:\s*\{\s*reason:\s*null,\s*at:\s*null\s*\}/,
    'setting a new catalog ID must clear waCatalog.lastSyncError — otherwise a stale ' +
    'GRAPH_ERROR from before the ID was fixed keeps showing on the tenant Catalog page ' +
    'even once the real problem is resolved'
  );
});

test('updateTenant(): a catalogId-only request does not 400 with "No valid fields to update"', () => {
  const body = updateTenantBody();
  const guardIdx = body.indexOf("No valid fields to update");
  assert.notEqual(guardIdx, -1);
  const guardLine = body.slice(body.lastIndexOf('if (', guardIdx), guardIdx);
  assert.match(
    guardLine,
    /!catalogIdUpdate/,
    'the empty-update guard must also check catalogIdUpdate, or a request containing ' +
    'ONLY a catalog ID (no Tenant-side fields) would incorrectly 400 before ever reaching ' +
    'the BusinessConfig write'
  );
});

test('updateTenant(): unrecognized request fields are surfaced as `ignored` instead of silently discarded', () => {
  const body = updateTenantBody();
  assert.match(
    body,
    /function findIgnoredFields/,
    'must compute which submitted fields were not recognized by ALLOWED/CROSS_MODEL_FIELDS/activate'
  );
  assert.match(
    body,
    /ignoredFields\.length\s*\?\s*\{\s*ignored:\s*ignoredFields\s*\}/,
    'the response must include an `ignored` array whenever unrecognized fields were submitted, ' +
    'so a future silently-dropped field (the same class of bug as catalogId) is visible ' +
    'immediately in the API response rather than requiring another debugging session'
  );
});

test('updateTenant(): response includes the updated BusinessConfig waCatalog state when a catalogId write was attempted', () => {
  const body = updateTenantBody();
  assert.match(
    body,
    /updatedBusiness\s*\?\s*\{\s*business:\s*\{\s*waCatalog:\s*updatedBusiness\.waCatalog\s*\}\s*\}/,
    'the response should let the caller confirm the catalogId actually persisted, rather than ' +
    'the frontend trusting a bare 200 the way it did before this fix'
  );
});
