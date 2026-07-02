// tests/tenantStatusExposure.test.mjs
//
// Pure, additive regression tests for the [AUDIT-FIX-17] fix in
// controllers/businessController.js's getBusinessConfig():
//   - The tenant-facing GET /:tenantId response now also returns a
//     `tenantStatus` block (status/onboardingStep/plan/whatsapp.connected)
//     sourced from req.tenant, so the dashboard no longer has to guess
//     onboarding progress from BusinessConfig.phoneNumberId alone.
//   - req.tenant is a `.lean()` object, so Mongoose's toJSON secret-stripping
//     transform does NOT run on it. getBusinessConfig must build tenantStatus
//     as an explicit whitelist rather than spreading req.tenant, or it will
//     leak whatsapp.accessToken / verifyToken / webhookSecret to the client.
//
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import BusinessConfig from '../models/BusinessConfig.js';
import { getBusinessConfig } from '../controllers/businessController.js';

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function withStubbedBusinessConfig(fakeBiz, run) {
  const original = BusinessConfig.findOne;
  BusinessConfig.findOne = () => ({ lean: () => Promise.resolve(fakeBiz) });
  return run().finally(() => { BusinessConfig.findOne = original; });
}

const fakeBiz = { tenantId: 't1', name: 'Test Biz', phoneNumberId: '12345' };

test('getBusinessConfig: super-admin caller (no req.tenant) gets tenantStatus: null, not a crash', async () => {
  await withStubbedBusinessConfig(fakeBiz, async () => {
    const req = { params: { tenantId: 't1' } }; // no req.tenant — super-admin path
    const res = fakeRes();
    await getBusinessConfig(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.business, fakeBiz);
    assert.equal(res.body.tenantStatus, null);
  });
});

test('getBusinessConfig: tenant caller gets a populated tenantStatus block', async () => {
  const fakeTenant = {
    _id: 't1', status: 'ACTIVE', onboardingStep: 4, plan: 'PRO',
    whatsapp: {
      connected: true, phone: '2207000000', phoneNumberId: 'pn1',
      wabaId: 'waba1', connectedAt: '2026-06-01T00:00:00Z', lastVerifiedAt: '2026-07-01T00:00:00Z',
      accessToken: 'SECRET-TOKEN', verifyToken: 'SECRET-VERIFY', webhookSecret: 'SECRET-WEBHOOK',
    },
    apiKeyHash: 'SECRET-HASH',
  };
  await withStubbedBusinessConfig(fakeBiz, async () => {
    const req = { params: { tenantId: 't1' }, tenant: fakeTenant };
    const res = fakeRes();
    await getBusinessConfig(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.tenantStatus, {
      status: 'ACTIVE',
      onboardingStep: 4,
      plan: 'PRO',
      whatsapp: {
        connected: true,
        phone: '2207000000',
        phoneNumberId: 'pn1',
        wabaId: 'waba1',
        connectedAt: '2026-06-01T00:00:00Z',
        lastVerifiedAt: '2026-07-01T00:00:00Z',
      },
    });
  });
});

test('getBusinessConfig: tenantStatus never leaks whatsapp secrets or apiKeyHash', async () => {
  const fakeTenant = {
    _id: 't1', status: 'ACTIVE', onboardingStep: 4, plan: 'PRO',
    whatsapp: { connected: true, accessToken: 'SECRET-TOKEN', verifyToken: 'SECRET-VERIFY', webhookSecret: 'SECRET-WEBHOOK' },
    apiKeyHash: 'SECRET-HASH',
  };
  await withStubbedBusinessConfig(fakeBiz, async () => {
    const req = { params: { tenantId: 't1' }, tenant: fakeTenant };
    const res = fakeRes();
    await getBusinessConfig(req, res);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('SECRET-TOKEN'), 'accessToken must not appear in the response');
    assert.ok(!serialized.includes('SECRET-VERIFY'), 'verifyToken must not appear in the response');
    assert.ok(!serialized.includes('SECRET-WEBHOOK'), 'webhookSecret must not appear in the response');
    assert.ok(!serialized.includes('SECRET-HASH'), 'apiKeyHash must not appear in the response');
  });
});

test('getBusinessConfig: missing whatsapp sub-object on req.tenant does not throw', async () => {
  const fakeTenant = { _id: 't1', status: 'PENDING', onboardingStep: 1, plan: 'FREE' }; // no .whatsapp at all
  await withStubbedBusinessConfig(fakeBiz, async () => {
    const req = { params: { tenantId: 't1' }, tenant: fakeTenant };
    const res = fakeRes();
    await getBusinessConfig(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.tenantStatus.whatsapp, {
      connected: false, phone: null, phoneNumberId: null, wabaId: null, connectedAt: null, lastVerifiedAt: null,
    });
  });
});

test('getBusinessConfig: still returns 404 for an unknown tenantId (unchanged behavior)', async () => {
  await withStubbedBusinessConfig(null, async () => {
    const req = { params: { tenantId: 'nope' }, tenant: { status: 'ACTIVE' } };
    const res = fakeRes();
    await getBusinessConfig(req, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'Not found' });
  });
});
