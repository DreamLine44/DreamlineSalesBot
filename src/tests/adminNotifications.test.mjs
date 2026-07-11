// tests/adminNotifications.test.mjs
//
// [ADMIN-NOTIFY-1] Regression tests for the pure helpers behind the
// super-admin ↔ tenant-admin messaging routes in routes/adminRoutes.js:
//   - validateNotificationInput() — input validation, no DB
//   - buildNotificationAccessFilter() — role-based query scoping, no DB
//
// Both are imported directly from the real route module (not
// reimplemented here) since neither touches Mongo or the network at
// import time — importing adminRoutes.js only registers Express handlers
// and Mongoose schemas.
//
// The scoping test is the security-critical one: it asserts a tenant
// caller can NEVER read another tenant's thread, even if they pass a
// forged ?tenantId query param.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNotificationInput, buildNotificationAccessFilter } from '../routes/adminRoutes.js';

// ── validateNotificationInput ─────────────────────────────────────────────────

test('validateNotificationInput accepts a well-formed message', () => {
  const err = validateNotificationInput({ subject: 'Hello', body: 'World', severity: 'info' });
  assert.equal(err, null);
});

test('validateNotificationInput accepts a message with no severity (defaults elsewhere)', () => {
  const err = validateNotificationInput({ subject: 'Hello', body: 'World' });
  assert.equal(err, null);
});

test('validateNotificationInput rejects a missing subject', () => {
  const err = validateNotificationInput({ subject: '', body: 'World' });
  assert.match(err, /subject is required/);
});

test('validateNotificationInput rejects a whitespace-only subject', () => {
  const err = validateNotificationInput({ subject: '   ', body: 'World' });
  assert.match(err, /subject is required/);
});

test('validateNotificationInput rejects a missing body', () => {
  const err = validateNotificationInput({ subject: 'Hello', body: '' });
  assert.match(err, /body is required/);
});

test('validateNotificationInput rejects an oversized subject', () => {
  const err = validateNotificationInput({ subject: 'x'.repeat(151), body: 'World' });
  assert.match(err, /150 characters or fewer/);
});

test('validateNotificationInput accepts a subject at exactly the length cap', () => {
  const err = validateNotificationInput({ subject: 'x'.repeat(150), body: 'World' });
  assert.equal(err, null);
});

test('validateNotificationInput rejects an oversized body', () => {
  const err = validateNotificationInput({ subject: 'Hello', body: 'x'.repeat(2001) });
  assert.match(err, /2000 characters or fewer/);
});

test('validateNotificationInput rejects an invalid severity', () => {
  const err = validateNotificationInput({ subject: 'Hello', body: 'World', severity: 'critical' });
  assert.match(err, /severity must be one of/);
});

// ── buildNotificationAccessFilter ─────────────────────────────────────────────

test('super admin with no query params gets an unscoped filter (sees all tenants)', () => {
  const { filter, error } = buildNotificationAccessFilter({ isSuperAdmin: true }, {});
  assert.equal(error, undefined);
  assert.deepEqual(filter, {});
});

test('super admin can narrow by tenantId, direction, unreadOnly, broadcastId', () => {
  const { filter } = buildNotificationAccessFilter({ isSuperAdmin: true }, {
    tenantId: 'tenant123', direction: 'TO_ADMIN', unreadOnly: 'true', broadcastId: 'bcast1',
  });
  assert.deepEqual(filter, {
    direction: 'TO_ADMIN', read: false, tenantId: 'tenant123', broadcastId: 'bcast1',
  });
});

test('tenant admin is always scoped to their own tenantId', () => {
  const { filter } = buildNotificationAccessFilter({ isSuperAdmin: false, tenantId: 'myTenant' }, {});
  assert.deepEqual(filter, { tenantId: 'myTenant' });
});

test('SECURITY: a tenant admin cannot override tenantId via query string to read another tenant', () => {
  const { filter } = buildNotificationAccessFilter(
    { isSuperAdmin: false, tenantId: 'myTenant' },
    { tenantId: 'someoneElsesTenant' },
  );
  assert.equal(filter.tenantId, 'myTenant');
  assert.notEqual(filter.tenantId, 'someoneElsesTenant');
});

test('SECURITY: a tenant admin cannot filter by broadcastId to enumerate other tenants\' broadcasts', () => {
  const { filter } = buildNotificationAccessFilter(
    { isSuperAdmin: false, tenantId: 'myTenant' },
    { broadcastId: 'bcast1' },
  );
  assert.equal(filter.broadcastId, undefined);
});

test('a request with neither isSuperAdmin nor tenantId is rejected', () => {
  const { error, filter } = buildNotificationAccessFilter({ isSuperAdmin: false, tenantId: null }, {});
  assert.equal(error, 'Forbidden');
  assert.equal(filter, undefined);
});

test('unreadOnly and direction filters apply equally for tenant callers', () => {
  const { filter } = buildNotificationAccessFilter(
    { isSuperAdmin: false, tenantId: 'myTenant' },
    { unreadOnly: 'true', direction: 'TO_TENANT' },
  );
  assert.deepEqual(filter, { tenantId: 'myTenant', direction: 'TO_TENANT', read: false });
});

test('an unrecognised direction value is silently ignored, not passed through to the DB filter', () => {
  const { filter } = buildNotificationAccessFilter({ isSuperAdmin: true }, { direction: 'BOGUS' });
  assert.equal(filter.direction, undefined);
});
