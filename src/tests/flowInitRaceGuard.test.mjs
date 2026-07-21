// tests/flowInitRaceGuard.test.mjs
//
// [FIX-FLOW-INIT-RACE] Regression tests: tapping a welcome button (e.g. "🍔 Order
// Food") could, under a race with a second webhook event for the same customer,
// produce "I couldn't find 'Order Food' on our menu" instead of the real menu.
//
// Root cause: flowEngine.js's startFlow() persists the session in two separate
// writes — (1) `currentFlow: 'ORDER', step: null`, then (2) the flow handler's
// own INIT branch writes the real first step (e.g. 'SELECT_ITEM'). A second
// webhook event landing between those two writes reads back currentFlow truthy
// + step null. webhookController.js's STEP_VALID_BUTTONS guard only runs
// `if (currentStep && ...)`, so a null step silently skips it and the tap falls
// through to advance(), which defaults the step internally and treats the raw
// button id/title as free-text menu-item input.
//
// Fix: webhookController.js now short-circuits on
// `isInteractive && freshSession.currentFlow && !freshSession.step` immediately
// after fetching freshSession — before the MFQ/FSI intercepts, the flow-
// passthrough branch, and the final advance() fallback — so no downstream path
// can misroute a tap landing in that window.
//
// Source-text guard (not a live-DB test), consistent with this codebase's
// established convention for controller wiring checks that need a live
// session/Mongo connection to exercise end-to-end (see
// orderButtonCatalogBypass.test.mjs's own header comment).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const controllerSrc = read('../controllers/webhookController.js');

test('webhookController.js: freshSession is fetched before any MFQ/FSI/passthrough/advance handling', () => {
  const freshIdx = controllerSrc.indexOf('const freshSession = await getSession(from, tenantId) || session;');
  assert.ok(freshIdx !== -1, 'freshSession fetch not found');

  const mfqIdx = controllerSrc.indexOf("upperMsg === 'MFQ_SWITCH_YES'", freshIdx);
  const passthroughIdx = controllerSrc.indexOf('isFlowPassthroughId(upperMsg)) {', freshIdx);
  const finalAdvanceIdx = controllerSrc.lastIndexOf('const reply = await advance({');

  assert.ok(mfqIdx > freshIdx, 'MFQ intercept must run after freshSession is fetched');
  assert.ok(passthroughIdx > freshIdx, 'flow-passthrough branch must run after freshSession is fetched');
  assert.ok(finalAdvanceIdx > freshIdx, 'final advance() fallback must run after freshSession is fetched');
});

test('webhookController.js: guards against currentFlow truthy + step null before any routing decision', () => {
  const freshIdx = controllerSrc.indexOf('const freshSession = await getSession(from, tenantId) || session;');
  assert.ok(freshIdx !== -1, 'freshSession fetch not found');

  const guardIdx = controllerSrc.indexOf('freshSession.currentFlow && !freshSession.step', freshIdx);
  assert.ok(guardIdx !== -1, 'FIX-FLOW-INIT-RACE guard not found after freshSession fetch');

  const mfqIdx = controllerSrc.indexOf("upperMsg === 'MFQ_SWITCH_YES'", freshIdx);
  const passthroughIdx = controllerSrc.indexOf('isFlowPassthroughId(upperMsg)) {', freshIdx);
  const finalAdvanceIdx = controllerSrc.lastIndexOf('const reply = await advance({');

  assert.ok(guardIdx < mfqIdx, 'race guard must run before the MFQ intercept');
  assert.ok(guardIdx < passthroughIdx, 'race guard must run before the flow-passthrough branch');
  assert.ok(guardIdx < finalAdvanceIdx, 'race guard must run before the final advance() fallback');
});

test('webhookController.js: race guard only fires for interactive taps, never typed text', () => {
  const guardIdx = controllerSrc.indexOf('freshSession.currentFlow && !freshSession.step');
  const lineStart = controllerSrc.lastIndexOf('if (', guardIdx);
  const lineEnd = controllerSrc.indexOf(')', guardIdx);
  const condition = controllerSrc.slice(lineStart, lineEnd);
  assert.match(condition, /isInteractive\s*&&/, 'guard must be scoped to isInteractive taps only');
});

test('webhookController.js: race guard returns without falling through to advance()', () => {
  const guardIdx = controllerSrc.indexOf('freshSession.currentFlow && !freshSession.step');
  const blockEnd = controllerSrc.indexOf('// [FIX-MFQ-BTN]', guardIdx);
  const block = controllerSrc.slice(guardIdx, blockEnd);
  assert.match(block, /return;/, 'guard block must return early, not fall through to advance()');
  assert.match(block, /dispatchMessage\(/, 'guard block must reply to the customer rather than going silent');
});
