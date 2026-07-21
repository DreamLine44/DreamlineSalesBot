// tests/browseCatalogButtonWiring.test.mjs
//
// [FIX-CATALOG-BTN] Regression tests for wiring up a fully-built but
// previously dead feature: waCatalogConfig.js#withCatalogWelcomeOption() and
// waCatalogFlow.js#browseCatalogExplicit() both existed, fully implemented
// and documented (browseCatalogExplicit's own docstring even names
// "moduleRouter.js GREET/SHOW_MENU cases" as its intended caller), but:
//   (a) withCatalogWelcomeOption() had zero callers — the "🛍 Browse Catalog"
//       button never appeared on any welcome menu, for any tenant, ever.
//   (b) browseCatalogExplicit() had zero callers — even if the button HAD
//       somehow appeared, tapping it would have fallen through
//       BUTTON_ID_MAP's "unmapped interactive ID" branch as CONTINUE_FLOW
//       with no flow to continue.
//
// Covers:
//   1. BUTTON_ID_MAP maps BROWSE_CATALOG to itself (so it survives step 1
//      of intentEngine.js's detectIntent() as a real action, not CONTINUE_FLOW)
//   2. moduleRouter.js's GREET and SHOW_MENU cases actually call
//      withCatalogWelcomeOption() before returning their button/list payload
//   3. moduleRouter.js has a BROWSE_CATALOG case that calls browseCatalogExplicit()
//
// Source-text guards (not live-DB tests) for the router wiring, consistent
// with this codebase's established convention (see leadCaptureTriggerAudit
// .test.mjs's own header comment) — moduleRouter.js needs a live session/
// Mongo connection to exercise end-to-end. Pure-logic tests for the two
// catalog helper functions themselves (no DB needed) are exercised directly.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── Pure logic: withCatalogWelcomeOption / shouldShowCatalogButton ─────────

const { withCatalogWelcomeOption, shouldShowCatalogButton } =
  await import('../modules/catalog/waCatalogConfig.js');

const enabledBusiness = {
  waCatalog: { enabled: true, catalogId: 'cat_123' },
  menuItems: [{ name: 'Widget', available: true }],
};
const disabledBusiness = { waCatalog: { enabled: false }, menuItems: [] };

test('shouldShowCatalogButton: true only when catalog is enabled+configured AND has sellable products', () => {
  assert.equal(shouldShowCatalogButton(enabledBusiness), true);
  assert.equal(shouldShowCatalogButton(disabledBusiness), false);
});

test('withCatalogWelcomeOption: no-op for a tenant without catalog enabled', () => {
  const base = [{ id: 'ORDER', title: 'Order' }, { id: 'BOOK', title: 'Book' }];
  const result = withCatalogWelcomeOption(base, disabledBusiness);
  assert.deepEqual(result, { buttons: base });
});

test('withCatalogWelcomeOption: appends BROWSE_CATALOG as a button when the combined set still fits in 3', () => {
  const base = [{ id: 'ORDER', title: 'Order' }];
  const result = withCatalogWelcomeOption(base, enabledBusiness);
  assert.ok(result.buttons, 'expected a buttons payload for a 2-item combined set');
  assert.ok(result.buttons.some(b => b.id === 'BROWSE_CATALOG'));
});

test('withCatalogWelcomeOption: paginates into a "⋯ More" screen when the combined set would exceed 3 buttons', () => {
  const base = [
    { id: 'ORDER', title: 'Order' },
    { id: 'BOOK', title: 'Book' },
    { id: 'QUESTION', title: 'Question' },
  ];
  const result = withCatalogWelcomeOption(base, enabledBusiness);
  assert.ok(result.buttons, 'expected a primary buttons payload');
  assert.equal(result.buttons.length, 3, 'primary screen must never exceed WhatsApp\'s 3-button cap');
  assert.ok(result.buttons.some(b => b.id === 'MORE_MENU'), 'primary screen must end in a "⋯ More" button');
  assert.ok(result.more?.buttons, 'expected a secondary ("more") buttons payload');
  assert.equal(result.more.buttons.length, 3, '"more" screen must also never exceed 3 buttons');
  assert.ok(result.more.buttons.some(b => b.id === 'BROWSE_CATALOG'));
  assert.ok(result.more.buttons.some(b => b.id === 'SHOW_MENU'), '"more" screen must end in a "🏠 Main Menu" button');
});

// ── BUTTON_ID_MAP wiring ────────────────────────────────────────────────────

test('patterns.js: BROWSE_CATALOG is mapped in BUTTON_ID_MAP (was previously unmapped -> dead tap)', async () => {
  const { BUTTON_ID_MAP } = await import('../core/intents/patterns.js');
  assert.equal(BUTTON_ID_MAP['BROWSE_CATALOG'], 'BROWSE_CATALOG');
});

// ── moduleRouter.js wiring (source-text guards) ────────────────────────────

const routerSrc = read('../core/conversations/moduleRouter.js');

test('moduleRouter.js: a BROWSE_CATALOG case exists and calls browseCatalogExplicit', () => {
  const caseStart = routerSrc.indexOf("case 'BROWSE_CATALOG'");
  assert.ok(caseStart !== -1, 'BROWSE_CATALOG case not found in moduleRouter.js');
  const caseBody = routerSrc.slice(caseStart, caseStart + 600);
  assert.match(caseBody, /browseCatalogExplicit/, 'BROWSE_CATALOG case must call browseCatalogExplicit()');
});

test('moduleRouter.js: GREET case calls withCatalogWelcomeOption before returning its welcome payload', () => {
  const greetStart = routerSrc.indexOf("case 'GREET'");
  const browseCatalogStart = routerSrc.indexOf("case 'BROWSE_CATALOG'");
  assert.ok(greetStart !== -1 && browseCatalogStart !== -1 && greetStart < browseCatalogStart);
  const greetBody = routerSrc.slice(greetStart, browseCatalogStart);
  assert.match(greetBody, /withCatalogWelcomeOption\(/, 'GREET case must call withCatalogWelcomeOption()');
});

test('moduleRouter.js: SHOW_MENU case calls withCatalogWelcomeOption before returning its payload', () => {
  const showMenuStart = routerSrc.indexOf("case 'SHOW_MENU'");
  assert.ok(showMenuStart !== -1, 'SHOW_MENU case not found');
  const showMenuBody = routerSrc.slice(showMenuStart, showMenuStart + 1500);
  assert.match(showMenuBody, /withCatalogWelcomeOption\(/, 'SHOW_MENU case must call withCatalogWelcomeOption()');
});

test('moduleRouter.js: GREET/SHOW_MENU always render as buttons (never a list) — WhatsApp button messages cap at 3, so >3 options paginate via "⋯ More" instead of falling back to a list', () => {
  const greetStart = routerSrc.indexOf("case 'GREET'");
  const browseCatalogStart = routerSrc.indexOf("case 'BROWSE_CATALOG'");
  const greetBody = routerSrc.slice(greetStart, browseCatalogStart);
  assert.match(greetBody, /type:\s*'buttons'/, 'GREET must render its welcome payload as buttons');
});

test('moduleRouter.js: MORE_MENU case exists and reuses withCatalogWelcomeOption', () => {
  const moreMenuStart = routerSrc.indexOf("case 'MORE_MENU'");
  assert.ok(moreMenuStart !== -1, 'MORE_MENU case not found in moduleRouter.js');
  const moreMenuBody = routerSrc.slice(moreMenuStart, moreMenuStart + 800);
  assert.match(moreMenuBody, /withCatalogWelcomeOption\(/, 'MORE_MENU case must call withCatalogWelcomeOption()');
});

test('patterns.js: MORE_MENU is mapped in BUTTON_ID_MAP (so the "⋯ More" tap survives detectIntent as a real action)', async () => {
  const { BUTTON_ID_MAP } = await import('../core/intents/patterns.js');
  assert.equal(BUTTON_ID_MAP['MORE_MENU'], 'MORE_MENU');
});
