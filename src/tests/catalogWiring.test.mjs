// tests/catalogWiring.test.mjs
//
// Regression tests for wiring the previously-orphaned WA Catalog conversational
// flow (src/modules/catalog/waCatalogFlow.js) into the live message pipeline:
//
//   [CATALOG-WIRE-1/2/3] webhookController.js now extracts type='order' messages
//     instead of silently dropping them, and routes them to handleCatalogOrderMessage().
//   [CATALOG-REG-1/2] moduleRegistry.js's START_ORDER action now offers WA Catalog
//     first (falling back to the normal ORDER flow), and BROWSE_CATALOG is registered.
//   [CATALOG-REG-3] moduleRouter.js's GREET/SHOW_MENU cases now merge in the
//     "🛍 Browse Catalog" button via withCatalogWelcomeOption().
//
// webhookController.js/moduleRouter.js need a live Mongo/Express context to run
// for real, so their wiring is verified via source-text guards, consistent with
// tests/multiIntentSecondaryInfo.test.mjs and tests/v13MergeAudit.test.mjs.
// waCatalogConfig.js's pure functions (already covered by waCatalogUxImprovements.test.mjs)
// are exercised directly here only insofar as needed to sanity-check the new call sites.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── webhookController.js: type='order' extraction ────────────────────────────

test('webhookController.js: extractMessage() handles type=order and surfaces catalogOrder', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(/type === 'order'/.test(src), 'must branch on type === \'order\'');
  assert.ok(src.includes('catalogOrder: msgObj.order'), 'must surface msgObj.order as catalogOrder');
});

test('webhookController.js: main handler destructures catalogOrder from extractMessage()', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    /const\s*{\s*text:\s*messageText,\s*imageUrl,\s*isInteractive,\s*isListReply,\s*catalogOrder\s*}\s*=\s*extractMessage/.test(src),
    'catalogOrder must be destructured alongside the existing extractMessage() fields'
  );
});

test('webhookController.js: empty-content guard no longer drops catalog order messages', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    src.includes('if (!messageText && !imageUrl && !catalogOrder)'),
    'the section 2 empty guard must let catalogOrder-only messages through'
  );
});

test('webhookController.js: section 7.5 routes catalogOrder to handleCatalogOrderMessage()', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(src.includes('if (catalogOrder)'), 'must check for catalogOrder after the humanMode gate');
  assert.ok(
    src.includes("await import('../modules/catalog/waCatalogFlow.js')") &&
    src.includes('handleCatalogOrderMessage({ session, business, tenant: tenantDoc, catalogOrder })'),
    'must call handleCatalogOrderMessage() with the extracted catalogOrder'
  );
});

test('webhookController.js: catalog handling runs after humanMode gate, before loop prevention', () => {
  const src = read('../controllers/webhookController.js');
  const humanModeIdx = src.indexOf("// ── 7. Human mode");
  const catalogIdx   = src.indexOf('// ── 7.5. [CATALOG-WIRE-3]');
  const loopIdx      = src.indexOf('// ── 8. [FIX-BUG4] Loop prevention');
  assert.ok(humanModeIdx > -1 && catalogIdx > -1 && loopIdx > -1, 'all three sections must be present');
  assert.ok(humanModeIdx < catalogIdx && catalogIdx < loopIdx, 'catalog handling must sit between humanMode and loop prevention');
});

// ── moduleRegistry.js: START_ORDER / BROWSE_CATALOG ──────────────────────────

test('moduleRegistry.js: START_ORDER tries offerCatalogOnStartOrder before falling back to startFlow', () => {
  const src = read('../core/shared/moduleRegistry.js');
  const startOrderBlock = src.slice(src.indexOf("registerAction('START_ORDER'"), src.indexOf("registerAction('BROWSE_CATALOG'"));
  assert.ok(startOrderBlock.includes('offerCatalogOnStartOrder'), 'must call offerCatalogOnStartOrder');
  assert.ok(startOrderBlock.includes("if (offered) return null"), 'must skip the fallback when the catalog was offered');
  assert.ok(startOrderBlock.includes("startFlow({ flowName: 'ORDER'"), 'must still fall back to the normal ORDER flow');
});

test('moduleRegistry.js: BROWSE_CATALOG action is registered and delegates to browseCatalogExplicit', () => {
  const src = read('../core/shared/moduleRegistry.js');
  assert.ok(src.includes("registerAction('BROWSE_CATALOG'"), 'BROWSE_CATALOG must be registered');
  assert.ok(src.includes('browseCatalogExplicit'), 'must delegate to browseCatalogExplicit');
});

// ── moduleRouter.js: welcome-button merge ────────────────────────────────────

test('moduleRouter.js: GREET and SHOW_MENU both merge in withCatalogWelcomeOption()', () => {
  const src = read('../core/conversations/moduleRouter.js');
  const occurrences = (src.match(/withCatalogWelcomeOption/g) || []).length;
  // 2 import call sites (GREET + SHOW_MENU) x 2 references each (import + usage) = 4
  assert.ok(occurrences >= 4, `expected withCatalogWelcomeOption to be wired into both GREET and SHOW_MENU (found ${occurrences} references)`);
});

test('moduleRouter.js: GREET/SHOW_MENU render a list when the merged button set overflows 3 buttons', () => {
  const src = read('../core/conversations/moduleRouter.js');
  assert.ok(
    /if \(greetOpts\.rows\)[\s\S]{0,120}type: 'list'/.test(src),
    'GREET must fall back to a list UI when withCatalogWelcomeOption() returns rows'
  );
  assert.ok(
    /if \(menuOpts\.rows\)[\s\S]{0,120}type: 'list'/.test(src),
    'SHOW_MENU must fall back to a list UI when withCatalogWelcomeOption() returns rows'
  );
});

// ── waCatalogConfig.js: sanity-check the actual values these call sites rely on ──

test('withCatalogWelcomeOption(): sanity-check against the shape moduleRouter.js now consumes', async () => {
  const { withCatalogWelcomeOption } = await import('../modules/catalog/waCatalogConfig.js');

  const disabledBiz = { waCatalog: { enabled: false }, menuItems: [{ available: true }] };
  const disabledResult = withCatalogWelcomeOption([{ id: 'ORDER', title: 'Order' }], disabledBiz);
  assert.deepEqual(disabledResult, { buttons: [{ id: 'ORDER', title: 'Order' }] }, 'disabled tenant must be a no-op');

  const enabledBiz = {
    waCatalog: { enabled: true, catalogId: 'CAT_1', mode: 'MANUAL_ONLY' },
    menuItems: [{ available: true }],
  };
  const overflow = withCatalogWelcomeOption(
    [{ id: 'A', title: '1' }, { id: 'B', title: '2' }, { id: 'C', title: '3' }],
    enabledBiz
  );
  assert.ok(Array.isArray(overflow.rows), 'a 4th option must switch to rows, never silently drop a button');
  assert.equal(overflow.rows.length, 4);
});

// ── [AUDIT-FIX-CATALOG-QUEUE] drainCatalogQueue() call sites ─────────────────
//
// drainCatalogQueue() (waCatalogFlow.js) was fully built, unit-tested (see
// waCatalogQueueDrain.test.mjs for the pure-function coverage it's built on)
// and documented with two claimed call sites — but neither existed anywhere
// in the codebase, so every WA Catalog cart order past the first line was
// silently stranded in session.pendingCatalogQueue forever. Fixed by wiring
// it into both places an order actually gets confirmed. Both call sites need
// a live Mongo/Express context to exercise end-to-end, so — consistent with
// the rest of this file — they're verified via source-text guards.

test('adminCommandService.js: confirmPayment() drains the catalog queue after setting postFlowAck=ORDER_CONFIRMED', () => {
  const src = read('../services/adminCommandService.js');
  const ackIdx   = src.indexOf("postFlowAck:  'ORDER_CONFIRMED'");
  const drainIdx = src.indexOf('drainCatalogQueue', ackIdx);
  assert.ok(ackIdx !== -1, 'confirmPayment() must still set postFlowAck=ORDER_CONFIRMED');
  assert.ok(drainIdx !== -1 && drainIdx > ackIdx, 'drainCatalogQueue must be called after postFlowAck is set to ORDER_CONFIRMED');
  const block = src.slice(ackIdx, drainIdx + 900);
  assert.ok(block.includes("await import('../modules/catalog/waCatalogFlow.js')"), 'must import drainCatalogQueue from waCatalogFlow.js');
  assert.ok(block.includes('getSession'), 'must fetch a fresh session before draining');
});

test('dashboardController.js: dashboard order-confirm branch also drains the catalog queue', () => {
  const src = read('../controllers/dashboardController.js');
  const ackIdx   = src.indexOf("postFlowAck:  'ORDER_CONFIRMED'");
  const drainIdx = src.indexOf('drainCatalogQueue', ackIdx);
  assert.ok(ackIdx !== -1, "updateOrderStatus() must still set postFlowAck=ORDER_CONFIRMED on the 'confirmed' branch");
  assert.ok(drainIdx !== -1 && drainIdx > ackIdx, 'drainCatalogQueue must be called after postFlowAck is set to ORDER_CONFIRMED');
  const block = src.slice(ackIdx, drainIdx + 900);
  assert.ok(block.includes("await import('../modules/catalog/waCatalogFlow.js')"), 'must import drainCatalogQueue from waCatalogFlow.js');
  assert.ok(block.includes('BusinessConfig.findOne'), 'must fetch a full BusinessConfig (menuItems, waCatalog config) before draining, not the slim loadTenant() doc');
});

test('drainCatalogQueue() itself is a no-op (never throws) when the session has no pending queue', async () => {
  const { drainCatalogQueue } = await import('../modules/catalog/waCatalogFlow.js');
  const result = await drainCatalogQueue({
    session:  { customerPhone: '+2205551234', tenantId: 't1', pendingCatalogQueue: [] },
    business: { tenantId: 't1', menuItems: [] },
    tenant:   { _id: 't1' },
  });
  assert.deepEqual(result, { drained: false });
});
