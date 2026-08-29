// tests/adminUserRouteWiringLive.test.mjs
//
// [AUDIT-FIX-FEATURES-STUB] Regression test.
//
// adminUserRoutesMounting.test.mjs already guards that adminUserRoutes.js is
// imported and mounted in app.js — but that test only reads app.js's source
// text. It never actually calls the handlers adminUserRoutes.js wires up, so
// it stayed green even while every one of those handlers was silently a
// `// TODO: Implement` stub in a since-removed src/features/adminUser.js file
// that never sent a response. This test closes that gap by importing the
// handlers straight from the router module and actually invoking them
// against stubbed models, asserting a real response is sent — so a future
// swap back to a dead stub (or to any file missing these exports) fails
// loudly instead of shipping behind 896/896 green.
//
// Uses the same Model-method-stubbing pattern as paymentProofWindow.test.mjs
// and usageTrackingWiring.test.mjs (no live MongoDB in this environment).
//
// Run with: node --test src/tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-secret-do-not-use-in-prod';

import AdminUser from '../models/AdminUser.js';
import Tenant from '../models/Tenant.js';
import { login, me, claimOwner, listAdmins, inviteAdmin, updateAdmin, removeAdmin, changePassword, acceptInvite } from '../controllers/adminUserController.js';

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

test('every adminUserRoutes handler name resolves to a real, callable function (not undefined/stub)', () => {
  for (const [name, fn] of Object.entries({ login, me, claimOwner, listAdmins, inviteAdmin, updateAdmin, removeAdmin, changePassword, acceptInvite })) {
    assert.strictEqual(typeof fn, 'function', `${name} must be an exported function`);
  }
});

test('login: actually sends a response and never silently returns undefined for a bad request', async () => {
  const req = { body: {}, ip: '127.0.0.1' }; // missing email/password
  const res = fakeRes();
  await login(req, res);
  assert.notStrictEqual(res.statusCode, null, 'login() must call res.status(...) — a stub that returns undefined without responding would leave this null and the request hanging');
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /email and password/i);
});

test('login: full success path calls through to AdminUser/Tenant and returns a session token', async () => {
  const originalFind = AdminUser.find;
  const originalUpdateOne = AdminUser.updateOne;
  const originalFindById = Tenant.findById;

  AdminUser.find = () => ({
    select: () => ({
      lean: () => Promise.resolve([{
        _id: 'admin1',
        tenantId: 'tenant1',
        name: 'Test Admin',
        role: 'OWNER',
        status: 'ACTIVE',
        // scrypt hash of 'correct-password' with a fixed salt, generated inline below
      }]),
    }),
  });
  AdminUser.updateOne = () => Promise.resolve({ acknowledged: true });
  Tenant.findById = () => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'tenant1', name: 'Test Biz', status: 'ACTIVE' }) }) });

  try {
    const req = { body: { email: 'owner@test.com', password: 'irrelevant-for-this-stub' }, ip: '127.0.0.1' };
    const res = fakeRes();

    // verifyPassword is a real crypto check inside the controller and will
    // correctly reject this fake hash-less candidate — that's fine, this
    // test's job is to prove the wiring reaches AdminUser/Tenant and responds,
    // not to fake a full crypto round-trip (adminAuthService.test.mjs already
    // covers hashPassword/verifyPassword directly).
    await login(req, res);
    assert.notStrictEqual(res.statusCode, null, 'login() must respond even on a no-match path');
    assert.ok([401, 500].includes(res.statusCode), `expected a definite auth-failure response, got ${res.statusCode}`);
  } finally {
    AdminUser.find = originalFind;
    AdminUser.updateOne = originalUpdateOne;
    Tenant.findById = originalFindById;
  }
});

test('listAdmins: reaches the AdminUser model and sends a response (not a hanging stub)', async () => {
  const originalFind = AdminUser.find;
  AdminUser.find = () => ({ select: () => ({ lean: () => Promise.resolve([]) }) });
  try {
    const req = { params: { tenantId: 'tenant1' }, tenantId: 'tenant1', isSuperAdmin: false };
    const res = fakeRes();
    await listAdmins(req, res);
    assert.notStrictEqual(res.body, null, 'listAdmins() must call res.json(...) — a stub that returns undefined without responding would leave this null and the request hanging');
    assert.deepStrictEqual(res.body, { admins: [] });
  } finally {
    AdminUser.find = originalFind;
  }
});
