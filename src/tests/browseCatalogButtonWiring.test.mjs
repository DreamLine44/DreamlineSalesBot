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

test('withCatalogWelcomeOption: appends BROWSE_CATALOG as a button when there is room under 3', () => {
  const base = [{ id: 'ORDER', title: 'Order' }];
  const result = withCatalogWelcomeOption(base, enabledBusiness);
  assert.ok(result.buttons, 'expected a buttons payload for a 2-item combined set');
  assert.equal(result.buttons.length, 2);
  assert.ok(result.buttons.some(b => b.id === 'BROWSE_CATALOG'));
  assert.ok(result.buttons.some(b => b.id === 'ORDER'), 'existing button must be preserved, not dropped');
});

// [FIX-CATALOG-3BTN] Regression test: this used to fall back to a `rows`/list
// payload (the "Choose an option" tap-to-expand bug) once the combined set
// exceeded 3 buttons. It must now replace the QUESTION slot instead and stay
// a 3-button payload, never rows.
test('withCatalogWelcomeOption: REPLACES the QUESTION slot (not a rows/list fallback) once the combined set would exceed 3 buttons', () => {
  const base = [
    { id: 'ORDER', title: 'Order' },
    { id: 'BOOK', title: 'Book' },
    { id: 'QUESTION', title: 'Question' },
  ];
  const result = withCatalogWelcomeOption(base, enabledBusiness);
  assert.ok(!result.rows, 'must never fall back to a rows/list payload');
  assert.ok(result.buttons, 'expected a buttons payload');
  assert.equal(result.buttons.length, 3, 'must stay within the 3-button cap');
  assert.ok(result.buttons.some(b => b.id === 'BROWSE_CATALOG'));
  assert.ok(result.buttons.some(b => b.id === 'ORDER'), 'ORDER must survive');
  assert.ok(result.buttons.some(b => b.id === 'BOOK'), 'BOOK must survive');
  assert.ok(!result.buttons.some(b => b.id === 'QUESTION'), 'QUESTION is replaced, not kept alongside a 4th slot');
});

test('withCatalogWelcomeOption: falls back to replacing the final slot when there is no QUESTION button at all', () => {
  const base = [
    { id: 'ORDER', title: 'Order' },
    { id: 'TRACK_ORDER', title: 'Track' },
    { id: 'VIEW_MENU', title: 'Menu' },
  ];
  const result = withCatalogWelcomeOption(base, enabledBusiness);
  assert.equal(result.buttons.length, 3);
  assert.ok(result.buttons.some(b => b.id === 'BROWSE_CATALOG'));
  assert.equal(result.buttons[result.buttons.length - 1].id, 'BROWSE_CATALOG');
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

// [FIX-CATALOG-3BTN] Regression test: GREET/SHOW_MENU used to render a
// WhatsApp list message ("Choose an option" tap-to-expand button) whenever
// Browse Catalog pushed the welcome menu past 3 options. withCatalogWelcomeOption()
// now always returns a buttons payload, so neither case should ever build a
// 'list' type UI for the welcome menu anymore.
test('moduleRouter.js: GREET/SHOW_MENU never fall back to a list ("Choose an option") payload', () => {
  const greetStart = routerSrc.indexOf("case 'GREET'");
  const browseCatalogStart = routerSrc.indexOf("case 'BROWSE_CATALOG'");
  const greetBody = routerSrc.slice(greetStart, browseCatalogStart);
  assert.doesNotMatch(greetBody, /type:\s*'list'/, 'GREET must not render a list/"Choose an option" payload');
  assert.match(greetBody, /type:\s*'buttons'/, 'GREET must render native reply buttons');

  const showMenuStart = routerSrc.indexOf("case 'SHOW_MENU'");
  const cancelStart = routerSrc.indexOf("case 'CANCEL'");
  const showMenuBody = routerSrc.slice(showMenuStart, cancelStart);
  assert.doesNotMatch(showMenuBody, /type:\s*'list'/, 'SHOW_MENU must not render a list/"Choose an option" payload');
  assert.match(showMenuBody, /type:\s*'buttons'/, 'SHOW_MENU must render native reply buttons');
});

// [FIX-CATALOG-TEXT] Typed "browse catalog" must reach the same place the
// button tap does, now that Browse Catalog is a primary welcome-menu action.
test('patterns.js: BROWSE_CATALOG has typed-text keywords and maps to the BROWSE_CATALOG action', async () => {
  const { INTENT_PATTERNS } = await import('../core/intents/patterns.js');
  assert.ok(Array.isArray(INTENT_PATTERNS.BROWSE_CATALOG) && INTENT_PATTERNS.BROWSE_CATALOG.length > 0);
  assert.ok(INTENT_PATTERNS.BROWSE_CATALOG.includes('browse catalog'));
});

// [FIX-CATALOG-3BTN] Removing the QUESTION button from the welcome menu must
// not remove the feature — typed questions still route to QUESTION with no
// button required, independent of what's currently shown on screen.
test('patterns.js: QUESTION keyword detection does not depend on any button being present', () => {
  const patternsSrc = read('../core/intents/patterns.js');
  const qIdx = patternsSrc.indexOf('QUESTION: [');
  assert.ok(qIdx !== -1, 'QUESTION keyword array must still exist');
  const qBlock = patternsSrc.slice(qIdx, qIdx + 400);
  assert.match(qBlock, /'question'/, 'typed "question" must still be a recognised keyword');
});
