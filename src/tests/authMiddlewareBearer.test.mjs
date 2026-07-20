// tests/authMiddlewareBearer.test.mjs
//
// Regression tests for [FEATURE-MULTIADMIN-1]'s missing Bearer-auth wiring
// in middleware/authMiddleware.js. Before this fix:
//   - routes/adminUserRoutes.js imported `requireRole` from authMiddleware.js,
//     which did not export it — a load-time SyntaxError (ERR crash) the
//     moment anything actually imported that route file.
//   - requireApiKey never checked the Authorization header at all, so every
//     route expecting req.adminUser (me(), requireRole()) would have silently
//     seen it as undefined forever, even with a perfectly valid session token.
//
// Mocks AdminUser.findById (no live DB) — matches the codebase's own
// established pattern of pure-logic tests for auth/crypto primitives (see
// adminAuthService.test.mjs's own header comment).
//
// Run with: node --test src/tests/
// Requires ADMIN_SESSION_SECRET set (same requirement as adminAuthService.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-secret-do-not-use-in-prod';
process.env.SUPER_ADMIN_API_KEY  = process.env.SUPER_ADMIN_API_KEY  || 'test-super-key';

const { createSessionToken } = await import('../services/adminAuthService.js');
const AdminUser = (await import('../models/AdminUser.js')).default;

const FAKE_ADMIN_ID  = new mongoose.Types.ObjectId().toString();
const FAKE_TENANT_ID = new mongoose.Types.ObjectId().toString();

let mockAdminRecord = {
  _id: FAKE_ADMIN_ID, name: 'Test Owner', role: 'OWNER',
  status: 'ACTIVE', tenantId: FAKE_TENANT_ID,
};

// Monkey-patch findById so this test never needs a live Mongo connection.
AdminUser.findById = () => ({
  select: () => ({
    lean: async () => mockAdminRecord,
  }),
});

const { requireApiKey, requireRole } = await import('../middleware/authMiddleware.js');

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return { json: (b) => { res.body = b; } }; };
  return res;
}

test('requireApiKey: a valid Bearer session token sets req.adminUser/tenantId/isSuperAdmin and calls next()', async () => {
  const token = createSessionToken({ _id: FAKE_ADMIN_ID, tenantId: FAKE_TENANT_ID, role: 'OWNER' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  let nextCalled = false;

  await requireApiKey(req, mockRes(), () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.adminUser, { id: FAKE_ADMIN_ID, name: 'Test Owner', role: 'OWNER' });
  assert.equal(req.tenantId, FAKE_TENANT_ID);
  assert.equal(req.isSuperAdmin, false);
});

test('requireApiKey: a malformed/tampered Bearer token falls through to the x-api-key path, not an immediate crash', async () => {
  const req = { headers: { authorization: 'Bearer not-a-real-token' } };
  const res = mockRes();
  await requireApiKey(req, res, () => {});
  // No x-api-key present either -> the legacy path's own 401, not an unhandled throw.
  assert.equal(res.statusCode, 401);
});

test('requireApiKey: a DISABLED AdminUser is rejected even with a structurally valid, unexpired token', async () => {
  mockAdminRecord = { ...mockAdminRecord, status: 'DISABLED' };
  try {
    const token = createSessionToken({ _id: FAKE_ADMIN_ID, tenantId: FAKE_TENANT_ID, role: 'OWNER' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    await requireApiKey(req, res, () => {});
    assert.equal(res.statusCode, 401, 'a DISABLED admin must not authenticate, even with a valid-looking token');
  } finally {
    mockAdminRecord = { ...mockAdminRecord, status: 'ACTIVE' };
  }
});

test('requireRole: super admin always bypasses, regardless of allowed roles', () => {
  const req = { isSuperAdmin: true };
  let nextCalled = false;
  requireRole('OWNER')(req, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireRole: a legacy x-api-key caller (no req.adminUser) bypasses as OWNER-equivalent', () => {
  const req = { isSuperAdmin: false, adminUser: undefined };
  let nextCalled = false;
  requireRole('OWNER')(req, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requireRole: an AdminUser session with a disallowed role is rejected with 403', () => {
  const req = { isSuperAdmin: false, adminUser: { id: 'x', name: 'Staffer', role: 'STAFF' } };
  const res = mockRes();
  let nextCalled = false;
  requireRole('OWNER')(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireRole: an AdminUser session with an allowed role (multi-role gate) passes', () => {
  const req = { isSuperAdmin: false, adminUser: { id: 'x', name: 'Manager', role: 'MANAGER' } };
  let nextCalled = false;
  requireRole('OWNER', 'MANAGER')(req, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('routes/adminUserRoutes.js: GET /dashboard/:tenantId/admins is gated to OWNER/MANAGER (was missing entirely)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../routes/adminUserRoutes.js', import.meta.url), 'utf8');
  const start = src.indexOf("'/dashboard/:tenantId/admins'");
  assert.ok(start !== -1, 'listAdmins route not found');
  const body = src.slice(Math.max(0, start - 200), start + 200);
  assert.match(body, /requireRole\(\s*'OWNER'\s*,\s*'MANAGER'\s*\)/,
    'GET /dashboard/:tenantId/admins must be gated to OWNER/MANAGER per adminUserController.js\'s own documented intent');
});

test('app.js: adminUserRoutes is mounted, and BEFORE the blanket /dashboard requireApiKey mount', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const adminUserMountIdx = src.indexOf("app.use('/', adminUserRoutes)");
  // Search for the actual CODE line (with its rateLimiter/requireApiKey args),
  // not just the bare "app.use('/dashboard'" prefix — that string also appears
  // inside this file's own explanatory comment above the real mount line,
  // which sits earlier in the file and would give a false "wrong order" result.
  const dashboardMountIdx = src.indexOf("app.use('/dashboard', createRateLimiter(120), requireApiKey, dashboardRoutes)");
  assert.ok(adminUserMountIdx !== -1, 'adminUserRoutes must actually be mounted in app.js');
  assert.ok(dashboardMountIdx !== -1, 'dashboard mount not found');
  assert.ok(adminUserMountIdx < dashboardMountIdx,
    'adminUserRoutes must be mounted BEFORE the /dashboard blanket requireApiKey mount, or /dashboard/auth/login would always 401');
});
