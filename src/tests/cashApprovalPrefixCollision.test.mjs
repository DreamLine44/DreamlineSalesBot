// tests/cashApprovalPrefixCollision.test.mjs
//
// [FIX-CASH-PREFIX-COLLISION] Regression test.
//
// handleAdminButtonReply() in adminCommandService.js dispatches on button-ID
// prefix using a chain of `if (upper.startsWith(...)) return ...`. The button
// actually sent to admins for a cash-payment request is `APPROVE_CASH_<shortId>`
// (see paymentService.js requestCashPayment()). Because
// "APPROVE_CASH_122900".startsWith("APPROVE_") is also true, an earlier ordering
// that checked the generic 'APPROVE_' prefix before the specific
// 'APPROVE_CASH_' prefix silently swallowed every real cash-approval tap into
// confirmPayment('CASH_122900', ...) — a shortId that can never exist in the
// Order collection — instead of approveCashRequest('122900', ...). The admin
// saw "No order found: CASH_122900" on a perfectly valid, pending order, the
// customer was never notified, and cashRequestStatus never advanced past
// 'pending'. Same collision existed for REJECT_CASH_ vs REJECT_.
//
// This project's adminCommandService.js tests are DB-free source-level checks
// (no mongoose/mongodb-memory-server harness is wired up for this suite), so
// this test proves the fix the same way: by asserting the specific `_CASH_`
// prefix checks appear (and therefore match) strictly before the generic
// prefix checks in source order, AND by independently re-deriving the actual
// dispatch decision for representative button IDs to make sure the bug class
// can't silently creep back in even if the surrounding lines are reshuffled.

import test    from 'node:test';
import assert  from 'node:assert/strict';
import fs      from 'node:fs';
import path    from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminCmdSrc = fs.readFileSync(
  path.join(__dirname, '../services/admin/adminCommandService.js'),
  'utf8',
);

// Pull out just the handleAdminButtonReply() function body so we're only
// reasoning about that dispatch chain, not any other similarly-named prefixes
// elsewhere in the file.
function extractFunctionBody(src, fnSignatureRe) {
  const startMatch = src.match(fnSignatureRe);
  assert.ok(startMatch, 'expected to find handleAdminButtonReply() in adminCommandService.js');
  const start = startMatch.index;
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, 'expected to find the end of handleAdminButtonReply()');
  return src.slice(start, end);
}

const fnBody = extractFunctionBody(
  adminCmdSrc,
  /export async function handleAdminButtonReply\(/,
);

// NOTE: these two tests search only for actual `if (upper.startsWith('...'))
// return ...(` statements — not a raw substring search over fnBody — because
// fnBody still contains the explanatory comments above the fix, and those
// comments themselves contain the literal text "startsWith('APPROVE_')" when
// describing the bug. A plain fnBody.search() for that substring matches the
// comment prose, not the code, and would report the branches as correctly
// ordered even if someone reintroduced the collision in real code.
const CODE_PREFIX_RE = /if \(upper\.startsWith\('([A-Z_]+)'\)\)\s*return \w+\(/g;

function codeIndexOfPrefix(prefix) {
  CODE_PREFIX_RE.lastIndex = 0;
  let m;
  while ((m = CODE_PREFIX_RE.exec(fnBody))) {
    if (m[1] === prefix) return m.index;
  }
  return -1;
}

test('APPROVE_CASH_ prefix check is ordered before the generic APPROVE_ prefix check', () => {
  const approveCashIdx = codeIndexOfPrefix('APPROVE_CASH_');
  const approveGenericIdx = codeIndexOfPrefix('APPROVE_');
  assert.notEqual(approveCashIdx, -1, 'APPROVE_CASH_ branch must exist');
  assert.notEqual(approveGenericIdx, -1, 'generic APPROVE_ branch must exist');
  assert.ok(
    approveCashIdx < approveGenericIdx,
    'APPROVE_CASH_ must be checked before the generic APPROVE_ prefix, or every ' +
    'real cash-approval button tap gets swallowed by confirmPayment() instead of ' +
    'approveCashRequest()',
  );
});

test('REJECT_CASH_ prefix check is ordered before the generic REJECT_ prefix check', () => {
  const rejectCashIdx = codeIndexOfPrefix('REJECT_CASH_');
  const rejectGenericIdx = codeIndexOfPrefix('REJECT_');
  assert.notEqual(rejectCashIdx, -1, 'REJECT_CASH_ branch must exist');
  assert.notEqual(rejectGenericIdx, -1, 'generic REJECT_ branch must exist');
  assert.ok(
    rejectCashIdx < rejectGenericIdx,
    'REJECT_CASH_ must be checked before the generic REJECT_ prefix, or every ' +
    'real cash-rejection button tap gets swallowed by rejectPayment() instead of ' +
    'rejectCashRequest()',
  );
});

// Re-derive the actual routing decision independent of statement order, by
// simulating the same "first matching startsWith wins" chain the function
// documents, driven off the prefixes as written in the current source. This
// catches the bug even if someone rewrites the chain as a lookup table, a
// switch, or reorders unrelated branches around it.
test('representative button IDs route to the correct handler, not a same-order collision', () => {
  const chain = [];
  const prefixRe = /if \(upper\.startsWith\('([A-Z_]+)'\)\)\s*return (\w+)\(/g;
  let m;
  while ((m = prefixRe.exec(fnBody))) {
    chain.push({ prefix: m[1], handler: m[2] });
  }
  assert.ok(chain.length >= 5, 'expected to parse the prefix dispatch chain');

  function route(buttonId) {
    const upper = buttonId.toUpperCase();
    const hit = chain.find(({ prefix }) => upper.startsWith(prefix));
    return hit && hit.handler;
  }

  assert.equal(route('APPROVE_CASH_122900'), 'approveCashRequest');
  assert.equal(route('REJECT_CASH_122900'), 'rejectCashRequest');
  assert.equal(route('APPROVE_A1B2C3'), 'confirmPayment');
  assert.equal(route('REJECT_A1B2C3'), 'rejectPayment');
  assert.equal(route('CASH_122900'), 'approveCashRequest'); // legacy alias
  // [FIX-CASH-FLOW-CONTINUATION] The "Confirm Order" / "Cancel Order" follow-up
  // buttons sent after a cash approval. Confirm reuses the generic APPROVE_
  // handler (confirmPayment already special-cases cash orders via
  // isNoPaymentOrder), Cancel needs its own CANCEL_ORDER_ branch.
  assert.equal(route('APPROVE_DA3288'), 'confirmPayment');
  assert.equal(route('CANCEL_ORDER_DA3288'), 'cancelOrderByShortId');
});

// [FIX-CASH-FLOW-CONTINUATION] approveCashRequest() used to return a plain-text
// receipt with no next action, leaving a cash order stuck at
// cashRequestStatus='approved' until someone remembered a separate typed
// command. It now returns a buttons payload continuing the flow straight into
// confirm/cancel. Assert the shape is actually a buttons object wired to the
// right ids, not just that the button text exists somewhere in the file.
test('approveCashRequest returns Confirm/Cancel follow-up buttons wired to the right handlers', () => {
  const start = adminCmdSrc.indexOf('async function approveCashRequest(');
  assert.notEqual(start, -1, 'expected to find approveCashRequest()');
  const end = adminCmdSrc.indexOf('\n}', start);
  const body = adminCmdSrc.slice(start, end);

  assert.match(body, /type:\s*'buttons'/, 'admin reply must be a buttons payload, not plain text');
  assert.match(body, /id:\s*`APPROVE_\$\{order\.shortId \|\| shortId\}`,\s*(?:\/\/.*\n\s*)?title:\s*'✅ Confirm Order'/,
    'Confirm Order button must use the APPROVE_ prefix so it lands on confirmPayment()');
  assert.match(body, /id:\s*`CANCEL_ORDER_\$\{order\.shortId \|\| shortId\}`,\s*title:\s*'❌ Cancel Order'/,
    'Cancel Order button must use the CANCEL_ORDER_ prefix so it lands on cancelOrderByShortId()');
});

// [FIX-CASH-FLOW-CONTINUATION] Mirrors the existing FIX-READY-BTN-GATE /
// FIX-RESUME-BTN-GATE pattern: handleAdminButtonReply() recognising a prefix is
// necessary but not sufficient — webhookController's admin-button gate must
// also list it, or the tap falls through to the non-admin "Sorry, that action
// isn't available" branch before ever reaching handleAdminButtonReply().
test('webhookController admin-button gate recognises CANCEL_ORDER_', () => {
  const webhookSrc = fs.readFileSync(
    path.join(__dirname, '../controllers/webhookController.js'),
    'utf8',
  );
  assert.match(webhookSrc, /upper\.startsWith\('CANCEL_ORDER_'\)/);
});
