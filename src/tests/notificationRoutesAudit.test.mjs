// tests/notificationRoutesAudit.test.mjs
//
// [ADMIN-NOTIFY-3] Source-text guard for the new GET/POST/PATCH /notifications
// routes in routes/adminRoutes.js. This is a source-text guard (not a live-DB
// test), consistent with how leadCaptureTriggerAudit.test.mjs / postFlowSentimentAI.test.mjs
// guard other fixes in modules that need a Mongo connection wired up to import
// directly — see leadCaptureTriggerAudit.test.mjs's own header comment for the
// same rationale.
//
// Focuses on the SECURITY-relevant structural properties that a live-DB test
// would otherwise need to exercise:
//   - direction is derived from the caller's role, never read from the request body
//   - a tenant admin can never forge another tenant's tenantId on POST
//   - broadcast fan-out is restricted to the super-admin branch only
//   - PATCH .../read enforces direction-aware ownership, not just tenantId match
//   - pingTenantAdmin() reuses the SAME adminPhone fallback convention used
//     everywhere else in this codebase, never a new/separate one
//
// Does NOT modify any existing source file.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const src = read('../routes/adminRoutes.js');

test('POST /notifications: direction is derived from req.isSuperAdmin, never read from req.body', () => {
  assert.doesNotMatch(
    src,
    /const\s*\{[^}]*\bdirection\b[^}]*\}\s*=\s*req\.body/,
    'direction must never be destructured from req.body — it must be hardcoded per branch (TO_TENANT for super admin, TO_ADMIN for tenant admin)'
  );
  const postStart = src.indexOf("r.post('/notifications'");
  assert.ok(postStart !== -1, 'POST /notifications route not found');
  const postBody = src.slice(postStart, postStart + 3500);
  assert.match(postBody, /direction:\s*'TO_TENANT'/, 'super-admin branch must hardcode TO_TENANT');
  assert.match(postBody, /direction:\s*'TO_ADMIN'/, 'tenant-admin branch must hardcode TO_ADMIN');
});

test('POST /notifications: tenant-admin branch always uses req.tenantId, never a body-supplied tenantId', () => {
  const postStart = src.indexOf("r.post('/notifications'");
  const postBody  = src.slice(postStart, postStart + 3500);
  // The tenant-admin (else) branch's AdminNotification.create call must key off
  // req.tenantId — find the SECOND create() call site (after the super-admin one)
  const createCalls = [...postBody.matchAll(/AdminNotification\.create\(\{([\s\S]*?)\}\)/g)];
  assert.ok(createCalls.length >= 2, 'expected at least two AdminNotification.create call sites (tenant-targeted + tenant-admin-sent)');
  const tenantAdminCreate = createCalls[createCalls.length - 1][1];
  assert.match(tenantAdminCreate, /tenantId:\s*req\.tenantId/, 'tenant-admin send must use req.tenantId, never a body-supplied value');
});

test('POST /notifications: broadcast fan-out is only reachable inside the req.isSuperAdmin branch', () => {
  const postStart = src.indexOf("r.post('/notifications'");
  const superAdminBranchStart = src.indexOf('if (req.isSuperAdmin)', postStart);
  const superAdminBranchEnd   = src.indexOf('// Tenant admin →', postStart);
  assert.ok(superAdminBranchStart !== -1 && superAdminBranchEnd !== -1 && superAdminBranchStart < superAdminBranchEnd,
    'could not locate the super-admin branch boundaries');
  const superAdminBranch = src.slice(superAdminBranchStart, superAdminBranchEnd);
  assert.match(superAdminBranch, /broadcast/, 'broadcast handling must live inside the super-admin branch');
  assert.match(superAdminBranch, /insertMany/, 'broadcast must fan out via insertMany (one doc per tenant)');
  assert.match(superAdminBranch, /broadcastId/, 'broadcast docs must share a broadcastId');

  const tenantAdminBranch = src.slice(superAdminBranchEnd);
  const tenantAdminBranchEnd = tenantAdminBranch.indexOf("r.patch('/notifications/:id/read'");
  assert.doesNotMatch(
    tenantAdminBranch.slice(0, tenantAdminBranchEnd === -1 ? undefined : tenantAdminBranchEnd),
    /broadcast/,
    'a tenant admin must never be able to trigger a broadcast fan-out'
  );
});

test('PATCH /notifications/:id/read: super admin can only mark TO_ADMIN notifications read', () => {
  const patchStart = src.indexOf("r.patch('/notifications/:id/read'");
  assert.ok(patchStart !== -1, 'PATCH /notifications/:id/read route not found');
  const patchBody = src.slice(patchStart, patchStart + 1800);
  assert.match(
    patchBody,
    /if\s*\(req\.isSuperAdmin\)\s*\{[\s\S]*?direction\s*!==\s*'TO_ADMIN'/,
    'super-admin branch must reject marking a TO_TENANT notification read (that belongs to the tenant, not the super admin)'
  );
});

test('PATCH /notifications/:id/read: tenant admin can only mark their OWN tenant\'s TO_TENANT notifications read', () => {
  const patchStart = src.indexOf("r.patch('/notifications/:id/read'");
  const patchBody  = src.slice(patchStart, patchStart + 1800);
  assert.match(
    patchBody,
    /String\(notification\.tenantId\)\s*!==\s*req\.tenantId/,
    'tenant-admin branch must compare notification.tenantId against req.tenantId (not a body-supplied value)'
  );
  assert.match(
    patchBody,
    /direction\s*!==\s*'TO_TENANT'/,
    'tenant-admin branch must reject marking a TO_ADMIN (their own outgoing) notification read'
  );
});

test('pingTenantAdmin: reuses the same adminPhone fallback convention used everywhere else in the codebase', () => {
  assert.match(
    src,
    /const\s+adminPhone\s*=\s*business\?\.adminPhone\s*\|\|\s*tenant\?\.adminPhone/,
    'pingTenantAdmin must use the SAME business?.adminPhone || tenant?.adminPhone fallback used throughout modules/*, paymentService.js, leadCaptureService.js, etc — not a new convention'
  );
});

test('pingTenantAdmin: never throws — a failed WhatsApp send must not break the notification write', () => {
  const fnStart = src.indexOf('async function pingTenantAdmin');
  assert.ok(fnStart !== -1, 'pingTenantAdmin function not found');
  const fnBody = src.slice(fnStart, fnStart + 900);
  assert.match(fnBody, /try\s*\{[\s\S]*?catch/, 'pingTenantAdmin must wrap the dispatch call in try/catch');
});

test('GET /notifications: uses buildNotificationAccessFilter, never a hand-rolled filter', () => {
  const getStart = src.indexOf("r.get('/notifications'");
  assert.ok(getStart !== -1, 'GET /notifications route not found');
  const getBody = src.slice(getStart, getStart + 900);
  assert.match(getBody, /buildNotificationAccessFilter\(/, 'GET /notifications must reuse buildNotificationAccessFilter for scoping');
});

test('POST /notifications: subject/body/severity are validated via validateNotificationInput before any DB write', () => {
  const postStart = src.indexOf("r.post('/notifications'");
  const postBody  = src.slice(postStart, postStart + 600);
  assert.match(postBody, /validateNotificationInput\(/, 'POST /notifications must validate input before writing');
});
