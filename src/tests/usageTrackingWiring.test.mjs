// tests/usageTrackingWiring.test.mjs
//
// [AUDIT-FIX-USAGE-WIRE] Regression tests for the fix wiring
// services/usageService.js into the rest of the app.
//
// Bug: usageService.js's own header comment claimed incrementTenantUsage()
// was "called fire-and-forget from webhookController" and that
// getTenantUsageSummary() was "exposed ... for the dashboard overview" —
// but neither claim was true. incrementTenantUsage was never imported or
// called anywhere in the codebase (Tenant.usage.messagesThisMonth stayed
// at 0 forever, for every tenant, regardless of plan or traffic), and
// getTenantUsageSummary was never imported into any controller or route
// (no dashboard endpoint could ever surface plan/usage data).
//
// Fix:
//   (a) webhookController.js now calls incrementTenantUsage(tenantId)
//       fire-and-forget, right after a genuine inbound message clears the
//       dedup + empty-message + BusinessConfig-lookup guards.
//   (b) dashboardController.js's getDashboardOverview now calls
//       getTenantUsageSummary(tenantId) and includes it in the response
//       as `usage`.
//
// This environment has no live MongoDB (see paymentProofWindow.test.mjs
// and others for the same constraint), so this file has two parts:
//   1. Source-text guards confirming both call sites actually exist, in
//      the right place relative to the guards they must come after/before.
//   2. A stubbed-model re-implementation of usageService.js's own logic
//      (incrementTenantUsage's reset-window rollover, getTenantUsageSummary's
//      shape/defaults), proving the underlying service logic itself is
//      correct, using the same Model-method-stubbing pattern as
//      paymentProofWindow.test.mjs.
//
// Run with:  node --test src/tests/

import test   from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';

import Tenant from '../models/Tenant.js';
import { incrementTenantUsage, getTenantUsageSummary } from '../services/usageService.js';

// ── 1. Source-text guards ────────────────────────────────────────────────

test('webhookController.js calls incrementTenantUsage, after the empty-message guard and BusinessConfig lookup', () => {
  const src = fs.readFileSync(new URL('../controllers/webhookController.js', import.meta.url), 'utf8');
  assert.match(src, /incrementTenantUsage\(tenantId\)/);

  const emptyGuardIdx  = src.indexOf('Message has no text and no image');
  const businessLoadIdx = src.indexOf('No BusinessConfig found for tenant — message dropped');
  const usageCallIdx   = src.indexOf('incrementTenantUsage(tenantId)');

  assert.ok(emptyGuardIdx !== -1 && businessLoadIdx !== -1 && usageCallIdx !== -1);
  assert.ok(
    usageCallIdx > emptyGuardIdx && usageCallIdx > businessLoadIdx,
    'incrementTenantUsage must fire after the empty-message and BusinessConfig guards, so retries/empty pings/unknown tenants are never counted',
  );
});

test('dashboardController.js getDashboardOverview reads and returns usage via getTenantUsageSummary', () => {
  const src = fs.readFileSync(new URL('../controllers/dashboardController.js', import.meta.url), 'utf8');
  assert.match(src, /getTenantUsageSummary\(tenantId\)/);

  const fnStart = src.indexOf('export async function getDashboardOverview');
  const fnEnd   = src.indexOf('\n}', fnStart);
  const fnBody  = src.slice(fnStart, fnEnd);
  assert.match(fnBody, /getTenantUsageSummary/, 'getTenantUsageSummary must be called inside getDashboardOverview');
  assert.match(fnBody, /usage[,:]/, 'the usage summary must be included in the JSON response');
});

// ── 2. Stubbed-model logic tests (mirrors paymentProofWindow.test.mjs's approach) ──

function withStubbedTenant({ findByIdResult, capture }, run) {
  const originalFindById  = Tenant.findById;
  const originalUpdateOne = Tenant.updateOne;
  Tenant.findById = () => ({
    select: () => ({ lean: () => Promise.resolve(findByIdResult) }),
  });
  Tenant.updateOne = (filter, update) => {
    if (capture) capture.push({ filter, update });
    return Promise.resolve({ acknowledged: true });
  };
  return run().finally(() => {
    Tenant.findById  = originalFindById;
    Tenant.updateOne = originalUpdateOne;
  });
}

test('incrementTenantUsage: resets to 1 when resetDate is missing (never tracked before)', async () => {
  const calls = [];
  await withStubbedTenant({ findByIdResult: { usage: {} }, capture: calls }, async () => {
    await incrementTenantUsage('tenant1');
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].update.$set && Object.keys(calls[0].update.$set).sort(),
    ['usage.messagesThisMonth', 'usage.resetDate']);
  assert.equal(calls[0].update.$set['usage.messagesThisMonth'], 1);
});

test('incrementTenantUsage: resets to 1 when resetDate rolled into a new calendar month', async () => {
  const calls = [];
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  await withStubbedTenant({ findByIdResult: { usage: { resetDate: lastMonth, messagesThisMonth: 42 } }, capture: calls }, async () => {
    await incrementTenantUsage('tenant1');
  });
  assert.equal(calls[0].update.$set['usage.messagesThisMonth'], 1);
});

test('incrementTenantUsage: increments in place when resetDate is still within the current calendar month', async () => {
  const calls = [];
  await withStubbedTenant({ findByIdResult: { usage: { resetDate: new Date(), messagesThisMonth: 7 } }, capture: calls }, async () => {
    await incrementTenantUsage('tenant1');
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].update.$inc, { 'usage.messagesThisMonth': 1 });
  assert.ok(!calls[0].update.$set, 'must not reset an in-window counter, only $inc it');
});

test('incrementTenantUsage: never throws when the tenant lookup fails (fire-and-forget contract)', async () => {
  const originalFindById = Tenant.findById;
  Tenant.findById = () => { throw new Error('connection lost'); };
  try {
    await assert.doesNotReject(() => incrementTenantUsage('tenant1'));
  } finally {
    Tenant.findById = originalFindById;
  }
});

test('incrementTenantUsage: no-ops silently when the tenant does not exist', async () => {
  const calls = [];
  await withStubbedTenant({ findByIdResult: null, capture: calls }, async () => {
    await incrementTenantUsage('ghost-tenant');
  });
  assert.equal(calls.length, 0);
});

test('getTenantUsageSummary: returns plan/limits/usage with documented defaults when unset', async () => {
  const originalFindById = Tenant.findById;
  Tenant.findById = () => ({ select: () => ({ lean: () => Promise.resolve({}) }) });
  try {
    const summary = await getTenantUsageSummary('tenant1');
    assert.deepEqual(summary, {
      plan: 'FREE',
      limits: { messagesPerMonth: 500, maxMenuItems: 10, maxAdmins: 1 },
      usage: { messagesThisMonth: 0, resetDate: null },
    });
  } finally {
    Tenant.findById = originalFindById;
  }
});

test('getTenantUsageSummary: passes through real plan/limits/usage values when set', async () => {
  const originalFindById = Tenant.findById;
  Tenant.findById = () => ({
    select: () => ({
      lean: () => Promise.resolve({
        plan: 'PRO',
        limits: { messagesPerMonth: 5000, maxMenuItems: 200, maxAdmins: 5 },
        usage: { messagesThisMonth: 123, resetDate: new Date('2026-08-01') },
      }),
    }),
  });
  try {
    const summary = await getTenantUsageSummary('tenant1');
    assert.equal(summary.plan, 'PRO');
    assert.equal(summary.limits.messagesPerMonth, 5000);
    assert.equal(summary.usage.messagesThisMonth, 123);
  } finally {
    Tenant.findById = originalFindById;
  }
});

test('getTenantUsageSummary: returns null for a tenant that no longer exists', async () => {
  const originalFindById = Tenant.findById;
  Tenant.findById = () => ({ select: () => ({ lean: () => Promise.resolve(null) }) });
  try {
    const summary = await getTenantUsageSummary('ghost-tenant');
    assert.equal(summary, null);
  } finally {
    Tenant.findById = originalFindById;
  }
});
