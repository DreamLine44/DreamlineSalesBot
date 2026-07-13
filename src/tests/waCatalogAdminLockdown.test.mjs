// tests/waCatalogAdminLockdown.test.mjs
//
// [AUDIT-FIX-CATALOG-ADMIN-1] / [AUDIT-FIX-CATALOG-TENANT-LOCKDOWN-1]
//
// Production incident 2026-07-13: a tenant's WhatsApp Catalog sync failed
// for hours across a chain of misconfigurations (wrong Catalog ID, wrong
// Business Portfolio, missing system-user asset permission) that took an
// hour of navigating Meta Commerce Manager + Business Settings + System
// Users to diagnose and fix — none of which a tenant business owner has
// access to. Catalog ID belongs alongside the other Meta credentials
// (meta.appId/appSecret, whatsapp.accessToken) that only the platform admin
// can obtain and set, not on the tenant-facing updateBusinessConfig
// endpoint. This is a source-text guard (not a live-DB test), consistent
// with waCatalogCrudSync.test.mjs and friends, since this environment
// doesn't have mongoose installed to construct real documents.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const tenantSrc   = read('../controllers/tenantController.js');
const businessSrc = read('../controllers/businessController.js');

test('updateTenant (admin) accepts waCatalog.catalogId and waCatalog.mode', () => {
  assert.match(tenantSrc, /'waCatalog\.catalogId',\s*'waCatalog\.mode'/);
});

test('updateTenant routes waCatalog fields to BusinessConfig instead of leaving them in the Tenant $set', () => {
  // Tenant schema has no waCatalog field — leaving these in `updates` would be
  // silently dropped by Mongoose strict mode on Tenant.findByIdAndUpdate,
  // exactly like the phoneNumberId/menu-alias bugs already fixed elsewhere.
  assert.match(tenantSrc, /delete updates\['waCatalog\.catalogId'\]/);
  assert.match(tenantSrc, /delete updates\['waCatalog\.mode'\]/);
  assert.match(tenantSrc, /waCatalogUpdates\.catalogId\s*=/);
  assert.match(
    tenantSrc,
    /await BusinessConfig\.updateOne\(\s*\{ tenantId: String\(req\.params\.id\) \},\s*\{ \$set: set \}/,
  );
});

test('the ONE-SHOT auto-enable-catalog-on-activation path is skipped when the admin explicitly set waCatalog fields in the same request', () => {
  // Prevents the auto-enable block from racing the explicit BusinessConfig
  // write above when an admin sends the new flat 'waCatalog.catalogId' key
  // (rather than the older nested `waCatalog: {...}` object) in an
  // activate:true request.
  assert.match(
    tenantSrc,
    /wantsActivate && updates\['whatsapp\.phoneNumberId'\] && req\.body\.waCatalog === undefined\s*\n\s*&& !Object\.keys\(waCatalogUpdates\)\.length/,
  );
});

test('the tenant-facing updateBusinessConfig endpoint strips catalogId from both nested and flat request shapes', () => {
  assert.match(businessSrc, /delete update\.waCatalog\.catalogId/);
  assert.match(businessSrc, /delete update\['waCatalog\.catalogId'\]/);
});

test('the tenant-facing lockdown runs BEFORE the waCatalog dot-notation flattening, so a flat catalogId key cannot slip through', () => {
  const lockdownIdx  = businessSrc.indexOf("delete update['waCatalog.catalogId']");
  const flattenIdx   = businessSrc.indexOf('for (const [k, v] of Object.entries(update.waCatalog))');
  assert.ok(lockdownIdx > -1 && flattenIdx > -1, 'both markers must be present');
  assert.ok(lockdownIdx < flattenIdx, 'catalogId strip must run before flattening, or a bare {"waCatalog.catalogId": "X"} body would bypass it entirely');
});

test('tenants can still self-serve waCatalog.enabled and waCatalog.mode (only catalogId moved to admin-only)', () => {
  // The lockdown deletes update.waCatalog.catalogId specifically, before the
  // whole update.waCatalog object gets flattened into dot-notation and
  // deleted as a normal part of that step — enabled/mode must still survive
  // that flattening untouched.
  assert.match(businessSrc, /update\[`waCatalog\.\$\{k\}`\] = v;/);
  assert.match(businessSrc, /for \(const \[k, v\] of Object\.entries\(update\.waCatalog\)\)/);
});
