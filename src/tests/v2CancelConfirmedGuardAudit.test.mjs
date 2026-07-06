// tests/v2CancelConfirmedGuardAudit.test.mjs
//
// Regression tests for the v2 systematic audit.
//
// Bugs found and fixed (moduleRouter.js):
//
// [AUDIT-FIX-CANCEL-CONFIRMED-GUARD] The CANCEL case's self-cancel query included
// status:'confirmed' orders in the cancellable set, relying on paymentStatus to
// exclude ones that shouldn't be touched (paymentStatus $nin ['cancelled','confirmed',
// 'paid']). That signal is unreliable for exactly the orders needing protection most:
//   - dashboardController.updateOrderStatus() sets status:'confirmed' without ever
//     touching paymentStatus (see dashboardController.js's [FIX-DASH-STATUS-MISSING]
//     section), leaving it at 'unpaid'.
//   - Cash orders accepted via AWAIT_ADMIN_CONFIRM never set paymentStatus:'confirmed'
//     either (documented in adminCommandService's markOrderReady
//     [FIX-MARK-READY-GUARD] comment).
// Both slipped through the old paymentStatus filter, so a customer could type
// "cancel my order" and silently cancel an order an admin had already accepted for
// prep — directly contradicting the honest "already confirmed and is being prepared,
// so it can't be self-cancelled" decline message this same case already shows when
// the order fails to match. status:'confirmed' is itself the authoritative "order
// accepted" signal in this codebase (same reasoning as activeOrderResolver's
// [AUDIT-AOR-CONFIRMED]), so only truly 'pending' orders are self-cancellable now.
//
// [AUDIT-FIX-CANCEL-ALL-CONFIRMED-GUARD] The CANCEL_ALL bulk-cancel case had the same
// gap, but worse: it matched status:'preparing' directly, and its paymentStatus
// exclusion list ($nin ['cancelled','refunded']) didn't even exclude 'confirmed' or
// 'paid' — so a customer could bulk-cancel an already-paid order that was already
// being prepared in the kitchen with a single "cancel all".
//
// Following this file's own established pattern (see v18FlowSystemAudit.test.mjs /
// v19FlowsAudit.test.mjs): moduleRouter.js's route() is not designed for isolated
// unit import without a live Mongo connection and full Express/session context, so
// these are source-text guards consistent with the rest of this file's test coverage.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('moduleRouter.js: CANCEL case only self-cancels status:pending orders, not confirmed ones', () => {
  const src = read('../core/conversations/moduleRouter.js');
  const orderQueryStart = src.indexOf('_CancelOrder.findOneAndUpdate');
  assert.ok(orderQueryStart !== -1, 'Order self-cancel query not found');
  const body = src.slice(orderQueryStart, orderQueryStart + 2500);

  assert.doesNotMatch(
    body,
    /status:\s*\{\s*\$in:\s*\[\s*'pending',\s*'confirmed'\s*\]\s*\}/,
    'CANCEL must not include confirmed orders in the self-cancellable status set'
  );
  assert.match(
    body,
    /status:\s*'pending'/,
    'expected the order-cancel query to be scoped to status: \'pending\' only'
  );
});

test('moduleRouter.js: CANCEL_ALL only bulk-cancels status:pending orders, and excludes paid/confirmed payment states', () => {
  const src = read('../core/conversations/moduleRouter.js');
  const start = src.indexOf("case 'CANCEL_ALL': {");
  assert.ok(start !== -1, "case 'CANCEL_ALL' not found");
  const end = src.indexOf("case 'SUPPORT': {");
  const body = src.slice(start, end);

  assert.doesNotMatch(
    body,
    /status:\s*\{\s*\$in:\s*\[\s*'pending',\s*'confirmed',\s*'preparing'\s*\]\s*\}/,
    'CANCEL_ALL must not include confirmed/preparing orders in the bulk-cancellable status set'
  );
  assert.match(
    body,
    /status:\s*'pending'/,
    'expected the bulk-cancel query to be scoped to status: \'pending\' only'
  );
  assert.match(
    body,
    /paymentStatus:\s*\{\s*\$nin:\s*\[[^\]]*'confirmed'[^\]]*'paid'[^\]]*\]\s*\}/,
    'expected paymentStatus exclusion list to also exclude confirmed/paid orders'
  );
});
