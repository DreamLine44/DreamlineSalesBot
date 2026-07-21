// tests/navSwitchButtonFix.test.mjs
//
// [FIX-NAV-SWITCH-BTN] Regression tests: a customer already mid-flow (e.g.
// currentFlow='ORDER', step='SELECT_ITEM') who taps a DIFFERENT top-level
// welcome-menu button still visible on an earlier message — "📅 Book a Table"
// (id BOOK), "🛍 Browse Catalog" (id BROWSE_CATALOG), or "🚶 Join Walk-In
// Queue" (id WALKIN) — got the generic
// "⚠️ That option is no longer available at this stage of your order" reject
// from the STEP_VALID_BUTTONS stale-button gate, instead of switching. WhatsApp
// never disables old buttons, so this was a routine customer action, not misuse.
//
// Root cause: ORDER/BOOK/BROWSE_CATALOG/WALKIN are top-level nav buttons, not
// flow-internal step buttons — never in STEP_VALID_BUTTONS for any step, and
// deliberately never in FLOW_PASSTHROUGH_IDS either (that would feed the raw
// id into advance() as free-text flow input, the bug class [FIX-P1] already
// fixed for CONFIRM/COLLECT/etc). The FSI mid-flow-switch system exists for
// exactly this "customer wants the other flow" case, but only ran on typed
// text, further down in the file — button taps were rejected by
// STEP_VALID_BUTTONS before ever reaching it.
//
// Fix: webhookController.js now recognises these ids inside the
// STEP_VALID_BUTTONS rejection branch and switches immediately — ORDER/BOOK/
// WALKIN via startFlow() (same call FSI_SWITCH_YES itself makes, gated on
// getModeConfig(business).flows support), BROWSE_CATALOG via a session reset
// + browseCatalogExplicit() — rather than falling through to the reject.
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

test('webhookController.js: nav-switch handling exists between STEP_VALID_BUTTONS rejection condition and the reject reply', () => {
  const rejectCondIdx = controllerSrc.indexOf("!validSet.has(upperMsg) && !isFlowPassthroughId(upperMsg)");
  assert.ok(rejectCondIdx !== -1, 'STEP_VALID_BUTTONS rejection condition not found');

  const rejectReplyIdx = controllerSrc.indexOf(
    "That option is no longer available at this stage of your order",
    rejectCondIdx
  );
  assert.ok(rejectReplyIdx !== -1, 'reject reply not found after rejection condition');

  const navSwitchIdx = controllerSrc.indexOf('FIX-NAV-SWITCH-BTN', rejectCondIdx);
  assert.ok(navSwitchIdx !== -1, 'FIX-NAV-SWITCH-BTN marker not found');
  assert.ok(
    navSwitchIdx > rejectCondIdx && navSwitchIdx < rejectReplyIdx,
    'nav-switch handling must run after the rejection condition is checked but before the reject reply is sent'
  );
});

test('webhookController.js: ORDER/BOOK/WALKIN switch via startFlow(), gated on vertical support', () => {
  const navSwitchIdx = controllerSrc.indexOf('FIX-NAV-SWITCH-BTN');
  const catalogIdx = controllerSrc.indexOf("upperMsg === 'BROWSE_CATALOG'", navSwitchIdx);
  assert.ok(catalogIdx !== -1, 'BROWSE_CATALOG branch not found after nav-switch fix');

  const flowTargetBlock = controllerSrc.slice(navSwitchIdx, catalogIdx);
  assert.match(flowTargetBlock, /ORDER:\s*'ORDER'/, 'ORDER must map to the ORDER flow');
  assert.match(flowTargetBlock, /BOOK:\s*'BOOKING'/, 'BOOK must map to the BOOKING flow');
  assert.match(flowTargetBlock, /WALKIN:\s*'WALKIN'/, 'WALKIN must map to the WALKIN flow');
  assert.match(flowTargetBlock, /getModeConfig\(business\)\?\.flows/, 'target flow must be gated on vertical support');
  assert.match(flowTargetBlock, /startFlow\(\{\s*flowName:\s*navTargetFlow/, 'must switch via startFlow()');
});

test('webhookController.js: switching away does not target the flow the customer is already in', () => {
  const navSwitchIdx = controllerSrc.indexOf('FIX-NAV-SWITCH-BTN');
  const catalogIdx = controllerSrc.indexOf("upperMsg === 'BROWSE_CATALOG'", navSwitchIdx);
  const flowTargetBlock = controllerSrc.slice(navSwitchIdx, catalogIdx);
  assert.match(
    flowTargetBlock,
    /navTargetFlow\s*!==\s*\(session\.currentFlow \|\| ''\)\.toUpperCase\(\)/,
    'must not re-switch into the flow already active'
  );
});

test('webhookController.js: BROWSE_CATALOG resets stale flow state before browsing', () => {
  const navSwitchIdx = controllerSrc.indexOf('FIX-NAV-SWITCH-BTN');
  const catalogIdx = controllerSrc.indexOf("upperMsg === 'BROWSE_CATALOG'", navSwitchIdx);
  assert.ok(catalogIdx !== -1, 'BROWSE_CATALOG branch not found');

  const rejectReplyIdx = controllerSrc.indexOf(
    "That option is no longer available at this stage of your order",
    catalogIdx
  );
  const catalogBlock = controllerSrc.slice(catalogIdx, rejectReplyIdx);

  assert.match(
    catalogBlock,
    /updateSession\(from, tenantId, \{ currentFlow: null, step: null, data: \{\} \}\)/,
    'BROWSE_CATALOG must clear stale flow state before dispatching the catalog'
  );
  assert.match(catalogBlock, /browseCatalogExplicit\(/, 'must call browseCatalogExplicit() to show the catalog');
  assert.match(catalogBlock, /return;/, 'BROWSE_CATALOG branch must return early, not fall through to the reject reply');
});
