// tests/adminUserAuthWiring.test.mjs
//
// Regression tests for [AUDIT-FIX-MULTIADMIN-SESSION] / [AUDIT-FIX-MULTIADMIN-MOUNT].
//
// Bugs found and fixed:
//
// The entire [FEATURE-MULTIADMIN-1] staff-login feature (controller + service +
// model) was fully built but completely unreachable/broken end-to-end:
//
//   1. routes/adminUserRoutes.js imports `requireRole` from
//      middleware/authMiddleware.js, but that export did not exist — importing
//      the route file would throw a SyntaxError ("does not provide an export
//      named 'requireRole'") the moment anything tried to load it.
//   2. middleware/authMiddleware.js's requireApiKey() never parsed an
//      `Authorization: Bearer <token>` header or called
//      adminAuthService.verifySessionToken() — session tokens issued by
//      login()/acceptInvite()/claimOwner() were verified NOWHERE. req.adminUser
//      was always undefined, so every "authenticated" request was silently
//      treated as a legacy shared tenant/super-admin key call.
//   3. app.js never imported or mounted adminUserRoutes.js at all — even
//      ignoring bugs 1 and 2, none of these routes were reachable.
//
// These tests use source-text guards for the wiring/mounting checks (this
// codebase's established convention — see v18FlowSystemAudit.test.mjs and
// friends — since actually booting app.js requires a live Mongo connection),
// plus behavioural tests for requireRole()'s pure branching logic and
// requireApiKey()'s Bearer path against a stubbed AdminUser/Tenant model.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-secret-do-not-use-in-prod';

// ── Wiring / mounting source guards ─────────────────────────────────────────

test('authMiddleware.js exports requireRole (previously missing, crashing adminUserRoutes.js on import)', () => {
  const src = read('../middleware/authMiddleware.js');
  assert.match(src, /export function requireRole\(/, 'expected a requireRole export');
});

test('authMiddleware.js requireApiKey parses an Authorization: Bearer session and sets req.adminUser', () => {
  const src = read('../middleware/authMiddleware.js');
  assert.match(src, /authHeader\.startsWith\('Bearer '\)/, 'expected Bearer header detection');
  assert.match(src, /verifySessionToken/, 'expected requireApiKey to call verifySessionToken');
  assert.match(src, /req\.adminUser\s*=/, 'expected req.adminUser to be set on a valid session');
});

test('app.js imports and mounts adminUserRoutes.js before the blanket /dashboard requireApiKey mount', () => {
  const src = read('../app.js');
  assert.match(src, /import adminUserRoutes from '\.\/routes\/adminUserRoutes\.js'/, 'expected adminUserRoutes to be imported');

  const mountIdx     = src.indexOf("app.use('/', createRateLimiter(120), adminUserRoutes)");
  const dashboardIdx = src.indexOf("app.use('/dashboard', createRateLimiter(120), requireApiKey, dashboardRoutes)");
  assert.ok(mountIdx !== -1, 'expected adminUserRoutes to be mounted');
  assert.ok(dashboardIdx !== -1, 'expected the blanket /dashboard mount to still be present');
  assert.ok(
    mountIdx < dashboardIdx,
    'adminUserRoutes must be mounted BEFORE the blanket /dashboard requireApiKey mount, or ' +
    '/dashboard/auth/login (meant to be unauthenticated) gets swallowed by requireApiKey first'
  );
});

// ── Behavioural: requireRole() pure branching logic ─────────────────────────

const { requireRole } = await import('../middleware/authMiddleware.js');

function fakeRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('requireRole: a legacy super-admin key bypasses the role check', () => {
  const req = { isSuperAdmin: true, adminUser: undefined };
  const res = fakeRes();
  let calledNext = false;
  requireRole('OWNER')(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(res.statusCode, null);
});

test('requireRole: a legacy tenant x-api-key caller (no adminUser) is treated as OWNER-equivalent', () => {
  const req = { isSuperAdmin: false, adminUser: undefined };
  const res = fakeRes();
  let calledNext = false;
  requireRole('OWNER')(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test('requireRole: an AdminUser session with the matching role passes', () => {
  const req = { isSuperAdmin: false, adminUser: { id: 'a1', role: 'OWNER' } };
  const res = fakeRes();
  let calledNext = false;
  requireRole('OWNER')(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test('requireRole: an AdminUser session with a different role is rejected with 403', () => {
  const req = { isSuperAdmin: false, adminUser: { id: 'a2', role: 'STAFF' } };
  const res = fakeRes();
  let calledNext = false;
  requireRole('OWNER')(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
});

// ── Behavioural: requireApiKey() Bearer session path ────────────────────────

const AdminUser = (await import('../models/AdminUser.js')).default;
const Tenant     = (await import('../models/Tenant.js')).default;
const { requireApiKey } = await import('../middleware/authMiddleware.js');
const { createSessionToken } = await import('../services/adminAuthService.js');

function withStubbedModels({ admin, tenant }, run) {
  const originalFindAdmin  = AdminUser.findById;
  const originalFindTenant = Tenant.findById;

  AdminUser.findById = () => ({
    select: () => ({ lean: () => Promise.resolve(admin) }),
  });
  Tenant.findById = () => ({ lean: () => Promise.resolve(tenant) });

  return run().finally(() => {
    AdminUser.findById = originalFindAdmin;
    Tenant.findById    = originalFindTenant;
  });
}

test('requireApiKey: a valid Bearer session for an ACTIVE admin sets req.adminUser/req.tenantId', async () => {
  const admin  = { _id: 'admin1', name: 'Ada', email: 'ada@biz.com', role: 'MANAGER', status: 'ACTIVE', tenantId: 'tenant1' };
  const tenant = { _id: 'tenant1', status: 'ACTIVE' };
  const token  = createSessionToken({ _id: 'admin1', tenantId: 'tenant1', role: 'MANAGER' });

  await withStubbedModels({ admin, tenant }, async () => {
    const req = { headers: { authorization: `Bearer ${token}` }, path: '/dashboard/auth/me' };
    const res = fakeRes();
    let calledNext = false;
    await requireApiKey(req, res, () => { calledNext = true; });

    assert.equal(calledNext, true, `expected next() to be called; got status ${res.statusCode} body ${JSON.stringify(res.body)}`);
    assert.equal(req.adminUser.role, 'MANAGER');
    assert.equal(req.tenantId, 'tenant1');
    assert.equal(req.isSuperAdmin, false);
  });
});

test('requireApiKey: a Bearer session for a DISABLED admin is rejected with 401', async () => {
  const admin  = { _id: 'admin2', name: 'Bea', role: 'STAFF', status: 'DISABLED', tenantId: 'tenant1' };
  const tenant = { _id: 'tenant1', status: 'ACTIVE' };
  const token  = createSessionToken({ _id: 'admin2', tenantId: 'tenant1', role: 'STAFF' });

  await withStubbedModels({ admin, tenant }, async () => {
    const req = { headers: { authorization: `Bearer ${token}` }, path: '/dashboard/auth/me' };
    const res = fakeRes();
    let calledNext = false;
    await requireApiKey(req, res, () => { calledNext = true; });

    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 401);
  });
});

test('requireApiKey: a tampered Bearer token is rejected with 401 before any DB lookup', async () => {
  const req = { headers: { authorization: 'Bearer not.a.realtoken' }, path: '/dashboard/auth/me' };
  const res = fakeRes();
  let calledNext = false;
  await requireApiKey(req, res, () => { calledNext = true; });

  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 401);
});
