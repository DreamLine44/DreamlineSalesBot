import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────
// [AUDIT-FIX-RECOVERY-1/2] [AUDIT-FIX-CART-TTL]
//
// BUG CHAIN CONFIRMED FROM LIVE SCREENSHOTS (YM Store, 2026-08-29):
//   1. Customer taps "✅ Confirm Order" on an assembled cart → bot replies
//      "⚠️ No active session." (flowEngine.advance()'s session-lost fallback).
//   2. Customer taps the bot's OWN recovery button, "🔄 Start Over"
//      (SHOW_MENU) → bot replies "⚠️ That option is no longer available at
//      this stage of your order." — a second, unrelated rejection from
//      webhookController's stale-button gate (STEP_VALID_BUTTONS), because
//      that gate was still validating against the stale `step` (e.g.
//      'CONFIRM') left over from before the session/flow was lost, and
//      CONFIRM's allow-list never included SHOW_MENU. Permanent dead end —
//      no tap could ever succeed again in that chat.
//
// Root cause of step 1: the default 30-minute session TTL applied even to a
// customer sitting on a fully-built, ready-to-submit cart, silently deleting
// the session (and the cart) if they paused before tapping Confirm.
//
// These tests lock in source-level regression guards for the three fixes
// (consistent with this repo's established pattern of asserting on source
// shape for DB-touching modules that can't run without a live Mongo — see
// viewMenuFeature.test.mjs, bookingSessionRecovery.test.mjs).
// ─────────────────────────────────────────────────────────────────────────

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── 1. flowEngine.js — both fallback branches persist a session reset ─────

test('flowEngine.js: the "no active session" fallback persists a session reset before replying', () => {
  const src = readSource('../core/conversations/flowEngine.js');
  const block = src.match(/if \(!session\?\.currentFlow\) \{[\s\S]{0,900}?\}\n\n {2}const flow/);
  assert.ok(block, 'Could not find the "no active session" fallback branch in advance()');
  assert.ok(
    block[0].includes('_resetStaleSession()'),
    '[AUDIT-FIX-RECOVERY-2] The "no active session" branch must call _resetStaleSession() ' +
    'so the DB session no longer holds a stale step that would reject the very "Start Over" ' +
    'button this branch hands the customer.'
  );
});

test('flowEngine.js: the "no handler available" fallback also persists a session reset', () => {
  const src = readSource('../core/conversations/flowEngine.js');
  const block = src.match(/if \(!handler\) \{[\s\S]{0,500}?\}\n\n {2}try \{/);
  assert.ok(block, 'Could not find the "no handler" fallback branch in advance()');
  assert.ok(
    block[0].includes('_resetStaleSession()'),
    '[AUDIT-FIX-RECOVERY-2] The "no handler available" branch must also reset the stale ' +
    'session — same bug class as the "no active session" branch above, same fix.'
  );
});

test('flowEngine.js: _resetStaleSession writes currentFlow/step/data to null via updateSession', () => {
  const src = readSource('../core/conversations/flowEngine.js');
  const helper = src.match(/const _resetStaleSession = async \(\) => \{[\s\S]{0,400}?\};/);
  assert.ok(helper, 'Could not find the _resetStaleSession helper');
  assert.ok(
    helper[0].includes('updateSession(') &&
    /currentFlow:\s*null,\s*step:\s*null,\s*data:\s*\{\}/.test(helper[0]),
    '_resetStaleSession must reset currentFlow, step, and data — the same full reset shape ' +
    'every other SHOW_MENU/CANCEL handler in this codebase already uses.'
  );
  assert.ok(
    helper[0].includes('session?.customerPhone') && helper[0].includes('session?.tenantId'),
    '_resetStaleSession must guard on customerPhone/tenantId being present before writing — ' +
    'a completely absent session object (not just a flow-less one) must not throw.'
  );
});

// ── 2. webhookController.js — global escape IDs exempt from stale-button gate ──

test('webhookController.js: GLOBAL_ESCAPE_BUTTON_IDS exists and covers every reset/cancel/support ID', () => {
  const src = readSource('../controllers/webhookController.js');
  const m = src.match(/GLOBAL_ESCAPE_BUTTON_IDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'Could not find GLOBAL_ESCAPE_BUTTON_IDS in webhookController.js');
  for (const id of ['SHOW_MENU', 'CANCEL', 'CANCEL_ORDER', 'CANCEL_BOOKING', 'SUPPORT']) {
    assert.ok(
      m[1].includes(`'${id}'`),
      `[AUDIT-FIX-RECOVERY-1] GLOBAL_ESCAPE_BUTTON_IDS must include '${id}' — these are the ` +
      'recovery/reset affordances the bot itself hands the customer from system-level fallback ' +
      'messages and must never be rejected as "stale" at any step.'
    );
  }
});

test('webhookController.js: the stale-button gate actually checks GLOBAL_ESCAPE_BUTTON_IDS before rejecting', () => {
  const src = readSource('../controllers/webhookController.js');
  const block = src.match(
    /if \(validSet\.size > 0 && !validSet\.has\(upperMsg\)[\s\S]{0,300}?\{\n\s+await dispatchMessage\(from, \{[\s\S]{0,200}?no longer available/
  );
  assert.ok(block, 'Could not find the stale-button rejection block');
  assert.ok(
    block[0].includes('!GLOBAL_ESCAPE_BUTTON_IDS.has(upperMsg)'),
    '[AUDIT-FIX-RECOVERY-1] The stale-button rejection condition must exempt ' +
    'GLOBAL_ESCAPE_BUTTON_IDS — otherwise defining the set alone does nothing.'
  );
});

test('webhookController.js: SHOW_MENU tapped mid-CONFIRM-step no longer falls into the stale-button trap (regression guard)', () => {
  // CONFIRM's own STEP_VALID_BUTTONS entry deliberately does NOT list SHOW_MENU —
  // this is the exact real-world case from the screenshots (customer stuck at the
  // CONFIRM step taps the bot's "Start Over" button). The fix must work WITHOUT
  // requiring every step's allow-list to be edited individually.
  const src = readSource('../controllers/webhookController.js');
  const confirmSet = src.match(/\n\s+CONFIRM:\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(confirmSet, 'Could not find the CONFIRM entry in STEP_VALID_BUTTONS');
  assert.doesNotMatch(
    confirmSet[1], /'SHOW_MENU'/,
    'This test documents that CONFIRM intentionally omits SHOW_MENU from its own allow-list — ' +
    'the fix must come from the global exemption, not from editing this list.'
  );
  assert.match(
    src, /GLOBAL_ESCAPE_BUTTON_IDS = new Set/,
    'The global exemption set must exist so SHOW_MENU still works at the CONFIRM step despite ' +
    "not being in CONFIRM's own STEP_VALID_BUTTONS entry."
  );
});

// ── 3. sessionService.js — extended TTL for an assembled, at-risk cart ────

test('sessionService.js: CART_STEPS covers every final-review / cart-editing step across modules', () => {
  const src = readSource('../core/sessions/sessionService.js');
  const m = src.match(/CART_STEPS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'Could not find CART_STEPS in sessionService.js');
  for (const step of ['CONFIRM', 'CART_REVIEW', 'ITEM_ADDED', 'EDIT_CART_MENU', 'EDIT_CART_PICK', 'BOOKING_CONFIRM']) {
    assert.ok(
      m[1].includes(`'${step}'`),
      `[AUDIT-FIX-CART-TTL] CART_STEPS must include '${step}' — a customer here has a real, ` +
      'assembled cart/booking on the line and must not lose it to the default 30-minute TTL.'
    );
  }
});

test('sessionService.js: resolveTTL checks CART_STEPS and returns the extended CART_TTL_MS', () => {
  const src = readSource('../core/sessions/sessionService.js');
  const fn = src.match(/function resolveTTL\(step, humanMode\) \{[\s\S]{0,400}?\}/);
  assert.ok(fn, 'Could not find resolveTTL()');
  assert.ok(
    fn[0].includes('CART_STEPS.has(step)') && fn[0].includes('CART_TTL_MS'),
    '[AUDIT-FIX-CART-TTL] resolveTTL must check CART_STEPS and return CART_TTL_MS for them, ' +
    'the same pattern already established for PAYMENT_STEPS/PAYMENT_TTL_MS.'
  );
  // Priority: humanMode > PAYMENT_STEPS > CART_STEPS > default — PAYMENT_STEPS check
  // must still come first (payment-proof waiting is a longer, more time-sensitive
  // window than a pre-submission cart review) and CART_STEPS check must precede
  // the plain SESSION_TTL_MS fallback.
  const paymentIdx = fn[0].indexOf('PAYMENT_STEPS.has(step)');
  const cartIdx = fn[0].indexOf('CART_STEPS.has(step)');
  const returnDefaultIdx = fn[0].lastIndexOf('return SESSION_TTL_MS');
  assert.ok(paymentIdx !== -1 && cartIdx !== -1 && returnDefaultIdx !== -1);
  assert.ok(
    paymentIdx < cartIdx && cartIdx < returnDefaultIdx,
    'resolveTTL must check PAYMENT_STEPS before CART_STEPS, and CART_STEPS before falling ' +
    'back to the plain default TTL.'
  );
});

test('sessionService.js: CART_TTL_MS defaults to a multi-hour window and is env-configurable', () => {
  const src = readSource('../core/sessions/sessionService.js');
  assert.match(
    src,
    /CART_TTL_MS = \(parseInt\(process\.env\.CART_SESSION_TTL_HOURS, 10\) \|\| 2\) \* 60 \* 60 \* 1000/,
    'CART_TTL_MS should default to 2 hours and be overridable via CART_SESSION_TTL_HOURS, ' +
    'mirroring the existing PAYMENT_SESSION_TTL_HOURS convention.'
  );
});
