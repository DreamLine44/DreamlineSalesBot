// tests/activityLifecycle.test.mjs
//
// Activity expiry, CANCEL_ALL, and cancel-by-reference regressions.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildActiveOrderFilter,
  buildCustomerCancellableOrderFilter,
  ACTIVITY_ACTIVE_WINDOW_MS,
} from '../services/activityLifecycleService.js';
import { extractShortId } from '../services/activityLookupService.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('buildActiveOrderFilter bounds in-progress orders to 24 hours', () => {
  const filter = buildActiveOrderFilter('2207000000', 'tenant1');
  assert.ok(filter.$or, 'uses $or');
  const inProgress = filter.$or.find(clause =>
    clause.status?.$in?.includes('confirmed') && clause.createdAt?.$gte
  );
  assert.ok(inProgress, 'confirmed/preparing/ready orders must age out after 24h');
});

test('buildActiveOrderFilter keeps admin-rejected orders unbounded', () => {
  const filter = buildActiveOrderFilter('2207000000', 'tenant1');
  const rejected = filter.$or.find(clause =>
    clause.status === 'pending' &&
    clause.paymentStatus === 'unpaid' &&
    clause.paymentReviewedAt?.$ne === null &&
    !clause.createdAt
  );
  assert.ok(rejected, 'admin-rejected orders must stay active until customer acts');
});

test('buildCustomerCancellableOrderFilter excludes admin-confirmed orders [RESTORE-CANCEL-CONFIRMED-GUARD]', () => {
  // Once an admin has accepted an order (confirmed/preparing/ready/out_for_delivery),
  // the customer can no longer self-cancel it via CANCEL/CANCEL_ALL — moduleRouter.js
  // intentionally routes that case to a "contact support" message instead. This filter
  // must therefore exclude those statuses outright rather than merely bounding them
  // to a 24h window, or a customer could cancel an order the kitchen is already
  // preparing.
  const filter = buildCustomerCancellableOrderFilter('2207000000', 'tenant1');
  assert.ok(filter.status?.$nin, 'top-level filter must exclude admin-accepted statuses');
  for (const status of ['confirmed', 'preparing', 'ready', 'out_for_delivery']) {
    assert.ok(
      filter.status.$nin.includes(status),
      `admin-accepted status "${status}" must be excluded from customer self-cancel`
    );
  }
  const leaksConfirmed = filter.$or.some(clause => clause.status?.$in?.includes('confirmed'));
  assert.equal(leaksConfirmed, false, 'no $or clause should reintroduce confirmed orders as cancellable');
});

test('buildCustomerCancellableOrderFilter still allows a pending, unreviewed order to be cancelled within 24h', () => {
  const filter = buildCustomerCancellableOrderFilter('2207000000', 'tenant1');
  const cancellable = filter.$or.find(clause =>
    clause.status === 'pending' && clause.createdAt?.$gte
  );
  assert.ok(cancellable, 'a still-pending order within the active window must remain self-cancellable');
});

test('extractShortId parses cancel #F93217', () => {
  assert.equal(extractShortId('cancel #F93217'), 'F93217');
  assert.equal(extractShortId('Cancel order #F93217'), 'F93217');
  assert.equal(extractShortId('cancel DSB-0823-4C7DB7'), '4C7DB7');
});

test('extractShortId does not treat bare "cancel" as a reference', () => {
  assert.equal(extractShortId('cancel'), null);
  assert.equal(extractShortId('Cancel my order'), null);
  assert.equal(extractShortId('cancel all'), null);
});

test('tryCustomerCancelRequest falls through during an active flow when nothing is saved yet', () => {
  const src = readSource('../services/activityLifecycleService.js');
  const block = src.slice(src.indexOf('async function _cancelMostRecentActivity'), src.indexOf('async function _cancelActivityByReference'));
  assert.match(block, /session\?\.currentFlow/);
  assert.match(block, /return null/);
});

test('tryCustomerCancelRequest defers to cancelFlow when mid-flow and no DB activity', () => {
  const src = readSource('../services/activityLifecycleService.js');
  const block = src.slice(
    src.indexOf('async function _cancelMostRecentActivity'),
    src.indexOf('async function _cancelActivityByReference'),
  );
  assert.match(block, /session\?\.currentFlow/);
  assert.match(block, /return null/);
});

test('webhookController uses tryCustomerCancelRequest for customer cancel', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.match(src, /tryCustomerCancelRequest/);
});

test('moduleRouter CANCEL_ALL delegates to cancelAllActiveForCustomer', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const block = src.slice(src.indexOf("case 'CANCEL_ALL':"), src.indexOf("case 'SUPPORT':"));
  assert.match(block, /cancelAllActiveForCustomer/);
  assert.doesNotMatch(block, /status:\s*'pending'/);
});

test('activeOrderResolver expires stale activities on every lookup', () => {
  const src = readSource('../services/activeOrderResolver.js');
  assert.match(src, /expireStaleActivities/);
  assert.match(src, /buildActiveOrderFilter/);
});

test('ACTIVITY_ACTIVE_WINDOW_MS is 24 hours', () => {
  assert.equal(ACTIVITY_ACTIVE_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test('buildPendingOrderLockFilter bounds normal pending orders to 24 hours', async () => {
  const { buildPendingOrderLockFilter } = await import('../services/activityLifecycleService.js');
  const filter = buildPendingOrderLockFilter('2207000000', 'tenant1');
  assert.ok(filter.$or.some(clause => clause.createdAt?.$gte));
  assert.ok(filter.$or.some(clause => clause.paymentReviewedAt?.$ne === null));
});

test('expireStaleActivities cancels abandoned pending carts older than 24h', () => {
  const src = readSource('../services/activityLifecycleService.js');
  const block = src.slice(src.indexOf('export async function expireStaleActivities'), src.indexOf('export async function cancelAllActiveForCustomer'));
  assert.match(block, /status: 'pending'/);
  assert.match(block, /paymentReviewedAt: null/);
});

test('webhookController expires stale activities on every inbound message', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.match(src, /expireStaleActivities\(from, tenantId\)/);
});

test('webhookController pending order lock uses buildPendingOrderLockFilter', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.match(src, /buildPendingOrderLockFilter/);
});
