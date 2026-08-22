// tests/navMeta3.test.mjs
//
// [NAV-META3] Regression tests for the Meta-compliant main-navigation upgrade.
//
// CONTEXT: WhatsApp's Cloud API caps interactive "reply button" messages at
// 3 buttons. The restaurant welcome menu previously fit that cap already
// (Order Food / Book a Table / Ask a Question), but the greeting itself was
// a single combined interactive message and there was no room to add more
// top-level options without either exceeding the 3-button cap or dropping
// an existing one.
//
// CHANGES COVERED BY THIS FILE:
//   1. core/intents/patterns.js — BUTTON_ID_MAP gained three new entries:
//      MORE_MENU, MAIN_MENU, BROWSE_CATALOG. BROWSE_CATALOG in particular
//      fixes a pre-existing dead-wiring bug: modules/catalog/waCatalogFlow.js's
//      browseCatalogExplicit() and waCatalogConfig.js's withCatalogWelcomeOption()
//      already referenced a "🛍 Browse Catalog" button, but no BUTTON_ID_MAP
//      entry existed for it — a tap on that button ID fell back to
//      CONTINUE_FLOW (silently re-showing the welcome menu) instead of
//      reaching the catalog flow.
//   2. core/conversations/moduleRouter.js —
//        - buildWelcomeSequence(business, cfg): a new exported helper, single
//          source of truth for the two-step welcome (text message, then a
//          separate interactive buttons message). Reused by both the GREET
//          case (fresh conversation) and the new MAIN_MENU case (explicit
//          "🏠 Main Menu" tap) — not duplicated between them.
//        - case 'MORE_MENU': secondary screen reached from a welcome menu's
//          "⋯ More" button.
//        - case 'MAIN_MENU': replays the full two-step welcome. Distinct
//          from the pre-existing 'SHOW_MENU' action (short "Start Over"
//          reset prompt), which is intentionally left unchanged.
//        - case 'BROWSE_CATALOG': wires the existing browseCatalogExplicit()
//          implementation — no new catalog logic was written.
//   3. modules/restaurant/configs/index.js — welcomeButtons is now
//      Order Food / Book a Table / ⋯ More (still exactly 3, Meta-compliant);
//      a new moreMenuButtons config (Browse Catalog / Ask a Question /
//      Main Menu, also exactly 3) backs the secondary screen.
//
// moduleRouter.js's route() dynamically imports Mongoose models (Order,
// Booking) inside the GREET case to check for an active order/booking before
// deciding to show the welcome menu at all — calling route() directly in a
// unit test would require a live DB connection, which is why this codebase's
// existing convention (see viewMenuFeature.test.mjs, v19FlowsAudit.test.mjs)
// tests moduleRouter.js/webhookController.js via a mix of (a) direct calls to
// pure/DB-free exports like detectIntent() and buildWelcomeSequence(), and
// (b) source-text assertions against the real file for the DB-coupled
// switch-case wiring. This file follows the same convention.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectIntent } from '../core/intents/intentEngine.js';
import { BUTTON_ID_MAP } from '../core/intents/patterns.js';
import { buildWelcomeSequence } from '../core/conversations/moduleRouter.js';
import { RESTAURANT_CONFIG } from '../modules/restaurant/configs/index.js';
import { RETAIL_CONFIG } from '../modules/retail/flows/index.js';
import { getModeConfig } from '../config/modes.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── 1. patterns.js — new BUTTON_ID_MAP entries ──────────────────────────────

test('BUTTON_ID_MAP: MORE_MENU, MAIN_MENU, BROWSE_CATALOG are all mapped to themselves', () => {
  assert.equal(BUTTON_ID_MAP.MORE_MENU, 'MORE_MENU');
  assert.equal(BUTTON_ID_MAP.MAIN_MENU, 'MAIN_MENU');
  assert.equal(BUTTON_ID_MAP.BROWSE_CATALOG, 'BROWSE_CATALOG');
});

test('detectIntent: tapping the new welcome-navigation buttons resolves to the correct action (not CONTINUE_FLOW)', async () => {
  const cases = [
    ['MORE_MENU', 'MORE_MENU'],
    ['MAIN_MENU', 'MAIN_MENU'],
    ['BROWSE_CATALOG', 'BROWSE_CATALOG'],
  ];
  for (const [buttonId, expectedAction] of cases) {
    const result = await detectIntent({ message: buttonId, isInteractive: true, session: {}, business: {} });
    assert.equal(result.action, expectedAction, `button id "${buttonId}" should resolve to action "${expectedAction}"`);
    assert.equal(result.source, 'button');
  }
});

test('BUTTON_ID_MAP: no duplicate/overwritten keys were introduced by the NAV-META3 additions', () => {
  // Re-parse the source text (not the imported object, which can never show a
  // silently-overwritten duplicate key) — same technique patterns.test.mjs
  // already uses for this exact class of bug.
  const src = readSource('../core/intents/patterns.js');
  const mapBody = src.slice(src.indexOf('BUTTON_ID_MAP = {'), src.indexOf('\n};', src.indexOf('BUTTON_ID_MAP = {')));
  const keyMatches = [...mapBody.matchAll(/^\s*'([A-Z0-9_]+)':/gm)].map(m => m[1]);
  const seen = new Set();
  const dupes = [];
  for (const k of keyMatches) {
    if (seen.has(k)) dupes.push(k);
    seen.add(k);
  }
  assert.deepEqual(dupes, [], `Duplicate BUTTON_ID_MAP key(s): ${dupes.join(', ')}`);
  assert.ok(seen.has('MORE_MENU') && seen.has('MAIN_MENU') && seen.has('BROWSE_CATALOG'));
});

// ── 2. moduleRouter.js — buildWelcomeSequence() ─────────────────────────────

// [LIST-NAV-1] RESTAURANT_CONFIG now defines cfg.ui.welcomeList, which
// buildWelcomeSequence() checks FIRST and returns early for — a single
// { type: 'list', ... } object, not the [text, buttons] array these four
// tests originally exercised. RETAIL_CONFIG has no welcomeList, so it still
// takes the original two-message code path and remains a faithful test of
// that underlying contract (still used by every mode that hasn't opted into
// LIST-NAV-1). See auditFixButtonsMenuSystemic.test.mjs for RESTAURANT's own
// welcomeList-specific coverage.

test('buildWelcomeSequence: returns a two-element array — plain text greeting, then a separate buttons message', () => {
  const cfg = getModeConfig({ businessMode: 'RETAIL' });
  const seq = buildWelcomeSequence({}, cfg);

  assert.equal(seq.length, 2, 'welcome sequence must be exactly [text, buttons] — one interactive message, sent separately from the greeting');
  assert.equal(seq[0].type, 'text');
  assert.equal(seq[1].type, 'buttons');
});

test('buildWelcomeSequence: the text message carries the branded welcome copy; the buttons message does not repeat it', () => {
  const cfg = getModeConfig({ businessMode: 'RETAIL' });
  const seq = buildWelcomeSequence({}, cfg);

  assert.equal(seq[0].body, cfg.messages.welcome);
  assert.notEqual(seq[1].body, cfg.messages.welcome);
});

test('buildWelcomeSequence: honors a tenant\'s customMessages.welcomeMessage override, same as the old single-message GREET behavior', () => {
  const cfg = getModeConfig({ businessMode: 'RETAIL' });
  const business = { businessMode: 'RETAIL', customMessages: { welcomeMessage: 'Yo! Welcome to Dee\'s Kitchen 🍲' } };
  const seq = buildWelcomeSequence(business, cfg);

  assert.equal(seq[0].body, "Yo! Welcome to Dee's Kitchen 🍲");
});

test('buildWelcomeSequence: buttons message uses cfg.ui.welcomeButtons and never exceeds Meta\'s 3-reply-button limit', () => {
  const cfg = getModeConfig({ businessMode: 'RETAIL' });
  const seq = buildWelcomeSequence({}, cfg);

  assert.deepEqual(seq[1].buttons, RETAIL_CONFIG.ui.welcomeButtons);
  assert.ok(seq[1].buttons.length <= 3, `welcome buttons message has ${seq[1].buttons.length} buttons — Meta allows a maximum of 3`);
});

// ── 3. modules/restaurant/configs/index.js — new nav layout ────────────────

test('RESTAURANT_CONFIG.ui.welcomeButtons: Order Food / Book a Table / ⋯ More, still exactly 3 buttons', () => {
  const ids = RESTAURANT_CONFIG.ui.welcomeButtons.map(b => b.id);
  assert.deepEqual(ids, ['ORDER', 'BOOK', 'MORE_MENU']);
  assert.ok(RESTAURANT_CONFIG.ui.welcomeButtons.length <= 3);
});

test('RESTAURANT_CONFIG.ui.moreMenuButtons: Browse Catalog / Ask a Question / Main Menu, exactly 3 buttons', () => {
  const ids = RESTAURANT_CONFIG.ui.moreMenuButtons.map(b => b.id);
  assert.deepEqual(ids, ['BROWSE_CATALOG', 'QUESTION', 'MAIN_MENU']);
  assert.ok(RESTAURANT_CONFIG.ui.moreMenuButtons.length <= 3);
});

test('RESTAURANT_CONFIG: existing ORDER/BOOK button ids and titles are unchanged (no regression to the existing order/booking flows)', () => {
  const order = RESTAURANT_CONFIG.ui.welcomeButtons.find(b => b.id === 'ORDER');
  const book  = RESTAURANT_CONFIG.ui.welcomeButtons.find(b => b.id === 'BOOK');
  assert.equal(order.title, '🍔 Order Food');
  assert.equal(book.title, '📅 Book a Table');
});

test('RESTAURANT_CONFIG: fallbackButtons (misunderstood-message context) is untouched by the NAV-META3 change', () => {
  // The task scope was the welcome/main-navigation experience only — the
  // FALLBACK/CLARIFY screen is a different UX context and was intentionally
  // left as-is (still surfaces QUESTION directly, no More submenu).
  const ids = RESTAURANT_CONFIG.ui.fallbackButtons.map(b => b.id);
  assert.deepEqual(ids, ['ORDER', 'BOOK', 'QUESTION']);
});

// ── 4. Meta-compliance regression guard — every mode, every button set ─────

test('Meta compliance: no module config anywhere exposes more than 3 buttons in welcomeButtons or moreMenuButtons', async () => {
  const modules = [
    '../modules/restaurant/configs/index.js',
    '../modules/bakery/flows/index.js',
    '../modules/salon/flows/index.js',
    '../modules/fashion/flows/index.js',
    '../modules/cosmetics/flows/index.js',
    '../modules/electronics/configs/index.js',
    '../modules/services/flows/index.js',
    '../modules/general/flows/index.js',
    '../modules/retail/flows/index.js',
    '../modules/delivery/flows/index.js',
  ];
  for (const rel of modules) {
    const mod = await import(rel);
    const cfg = Object.values(mod).find(v => v && typeof v === 'object' && v.ui);
    if (!cfg) continue;
    for (const key of ['welcomeButtons', 'moreMenuButtons']) {
      const buttons = cfg.ui[key];
      if (!buttons) continue;
      assert.ok(buttons.length <= 3, `${rel} ui.${key} has ${buttons.length} buttons — Meta allows a maximum of 3`);
    }
  }
});

// ── 5. moduleRouter.js — source-text checks for the DB-coupled switch cases ─
// (route() dynamically imports Order/Booking models inside GREET; the switch
// cases below are exercised here via source assertion, consistent with this
// codebase's existing convention for DB-coupled routing code — see the file
// header comment above and viewMenuFeature.test.mjs for precedent.)

test('moduleRouter.js: GREET\'s normal-welcome branch sends the two-step sequence via buildWelcomeSequence(), not a single combined message', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const greetCaseStart = src.indexOf("case 'GREET':");
  const greetCaseEnd   = src.indexOf("case 'VIEW_MENU':");
  const greetBody = src.slice(greetCaseStart, greetCaseEnd);

  assert.ok(greetBody.includes('return buildWelcomeSequence(business, cfg);'),
    'GREET must return the shared buildWelcomeSequence() result, not an inline single-message object');
  assert.ok(!/return \{ type: 'buttons', body, buttons: cfg\.ui\?\.welcomeButtons/.test(greetBody),
    'the old single combined-message GREET return should no longer be present');
});

test('moduleRouter.js: case MORE_MENU renders cfg.ui.moreMenuButtons (falling back to a sane default when a mode has none configured)', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const start = src.indexOf("case 'MORE_MENU':");
  const end   = src.indexOf("case 'MAIN_MENU':");
  assert.ok(start !== -1, 'case MORE_MENU must exist');
  const body = src.slice(start, end);
  assert.ok(body.includes('cfg.ui?.moreMenuButtons'));
  assert.ok(body.includes("cfg.messages?.moreMenuPrompt"));
});

test('moduleRouter.js: case MAIN_MENU reuses buildWelcomeSequence() (not a duplicated welcome UI builder) and clears session flow state', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const start = src.indexOf("case 'MAIN_MENU':");
  const end   = src.indexOf("case 'BROWSE_CATALOG':");
  assert.ok(start !== -1, 'case MAIN_MENU must exist');
  const body = src.slice(start, end);
  assert.ok(body.includes('return buildWelcomeSequence(business, cfg);'));
  assert.ok(body.includes('currentFlow: null, step: null'), 'MAIN_MENU should reset any stale flow state, same as SHOW_MENU does');
});

test('moduleRouter.js: case MAIN_MENU is distinct from case SHOW_MENU (the short "Start Over" prompt is preserved, unchanged)', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const showMenuStart = src.indexOf("case 'SHOW_MENU':");
  const showMenuEnd   = src.indexOf("case 'MORE_MENU':");
  const showMenuBody  = src.slice(showMenuStart, showMenuEnd);

  // SHOW_MENU must still return its original short prompt, single message —
  // NAV-META3 must not have collapsed it into the new full-welcome behavior.
  assert.ok(showMenuBody.includes("cfg.messages?.showMenuPrompt || '👇 What would you like to do?'"));
  assert.ok(!showMenuBody.includes('buildWelcomeSequence'), 'SHOW_MENU must remain the short reset prompt, not the full two-step welcome');
});

test('moduleRouter.js: case BROWSE_CATALOG delegates to the existing browseCatalogExplicit() implementation — no new catalog logic', () => {
  const src = readSource('../core/conversations/moduleRouter.js');
  const start = src.indexOf("case 'BROWSE_CATALOG':");
  assert.ok(start !== -1, 'case BROWSE_CATALOG must exist');
  // [FIX-VIEWMENU-BUTTON-FIRST] added an early-return "View Items" button
  // gate ahead of the browseCatalogExplicit() call, so the import/call now
  // sits further into the case body than a short fixed-width slice
  // reaches. Bound the slice on the next top-level `case ` instead of a
  // fixed char count, so this guard still catches any *actual*
  // reimplementation of catalog logic without going stale every time a
  // legitimate comment or branch is added above the existing call.
  const nextCaseIdx = src.indexOf("\n    case '", start + 20);
  const body = src.slice(start, nextCaseIdx === -1 ? src.length : nextCaseIdx);
  assert.ok(body.includes("import('../../modules/catalog/waCatalogFlow.js')"));
  assert.ok(body.includes('browseCatalogExplicit({ session, business, tenant })'));
});

// ── 6. webhookController.js — array-reply dispatch already handles the ──────
// two-step GREET/MAIN_MENU sequence with no further changes needed.

test('webhookController.js: the top-level route() call site already dispatches array replies sequentially (reused, not reimplemented, for the two-step welcome)', () => {
  const src = readSource('../controllers/webhookController.js');
  assert.ok(
    src.includes('const payloads = Array.isArray(reply) ? reply : [reply];'),
    'webhookController must already handle array replies from route() — GREET/MAIN_MENU rely on this exact existing mechanism'
  );
});
