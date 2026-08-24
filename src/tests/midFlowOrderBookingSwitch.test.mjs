// tests/midFlowOrderBookingSwitch.test.mjs
//
// Pure, additive regression tests for the [FSI] Mid-Flow Order/Booking-Switch
// intercept — the fix for: a customer already inside an active BOOKING flow
// (or ORDER flow) who deliberately types a request for the OTHER flow (e.g.
// "I want to order food" while mid-booking) previously had that message
// silently swallowed by the current step's handler (which just re-showed its
// existing prompt), with no acknowledgement and no way forward except finding
// CANCEL on their own.
//
// This mirrors the existing MFQ (Mid-Flow Question) intercept pattern:
//   - core/intents/intentEngine.js: ORDER_DIRECT_RE, BOOKING_DIRECT_RE, and
//     DIRECT_INTENT_EXCLUDE_RE are now exported so both the no-flow path and
//     the new mid-flow intercept share one single source of truth.
//   - controllers/webhookController.js: _detectMidFlowSwitchRequest(text, session)
//     detects the OTHER flow being requested and, if so, pauses with
//     FSI_SWITCH_YES / FSI_SWITCH_NO buttons instead of silently re-prompting.
//
// These are a mix of:
//   (a) live tests against the real, exported intentEngine.js regexes, and
//   (b) source-extraction tests for the webhookController.js private helper,
//       consistent with how v13MergeAudit.test.mjs / statusTracing.test.mjs
//       already test webhookController.js's mid-flow escape helpers, since
//       that module is not designed for isolated import without a live Mongo
//       connection and Express app context.
//
// Does NOT modify any existing source file's behavior for existing callers —
// intentEngine.js changes are export-only (the regexes/const already existed
// and matched exactly the same way; they just weren't reachable from outside
// the module before).
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORDER_DIRECT_RE, BOOKING_DIRECT_RE, DIRECT_INTENT_EXCLUDE_RE, QUESTION_LEADIN_RE, normalise } from '../core/intents/intentEngine.js';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── intentEngine.js exports used by the mid-flow intercept ──────────────────

test('intentEngine.js: ORDER_DIRECT_RE / BOOKING_DIRECT_RE / DIRECT_INTENT_EXCLUDE_RE are exported', () => {
  assert.ok(ORDER_DIRECT_RE instanceof RegExp, 'ORDER_DIRECT_RE must be exported as a RegExp');
  assert.ok(BOOKING_DIRECT_RE instanceof RegExp, 'BOOKING_DIRECT_RE must be exported as a RegExp');
  assert.ok(DIRECT_INTENT_EXCLUDE_RE instanceof RegExp, 'DIRECT_INTENT_EXCLUDE_RE must be exported as a RegExp');
});

// ── Build a live, executable copy of _detectMidFlowSwitchRequest ────────────
//
// webhookController.js can't be imported directly in this sandbox (it pulls in
// mongoose-backed models at module scope). Instead — same technique used by
// statusTracing.test.mjs for STATUS_CMD_RE — extract the actual function
// source text and the two Set literals it depends on, then evaluate them
// together so the test runs against the REAL logic, not a re-implementation
// that could silently drift from it.
// [FIX-FSI-1]/[FIX-FSI-2] The real function now also calls findBestMatch()
// (utils/matchEngine.js) and getModeConfig() (config/modes.js). Both are
// injected as factory params, same pattern as ORDER_DIRECT_RE etc, rather than
// imported directly: matchEngine.js pulls in the 'fast-levenshtein' package
// which isn't installed in this sandbox, and config/modes.js transitively
// pulls in every module's flows/index.js (orderService, bookingService, ...).
// The stub below reimplements only the exact/substring HIGH-confidence path
// of findBestMatch (sufficient for these tests — all collision cases here are
// exact-name matches) and a getModeConfig stub mirroring the real per-vertical
// `flows` capability lists declared in each module's config (config/modes.js).
function stubFindBestMatch(items = [], query = '') {
  const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!items.length || !query.trim()) return { item: null, confidenceLevel: 'NONE', score: 0 };
  const q = norm(query);
  for (const item of items) {
    const n = norm(item.name);
    if (n === q) return { item, confidenceLevel: 'HIGH', score: 1 };
    if (n.includes(q) || q.includes(n)) return { item, confidenceLevel: 'HIGH', score: 0.9 };
  }
  return { item: null, confidenceLevel: 'NONE', score: 0 };
}

// Mirrors the real `flows` arrays declared in each module's config (see
// src/modules/*/configs/index.js and src/modules/*/flows/index.js).
const STUB_MODE_FLOWS = {
  RESTAURANT:  ['ORDER', 'BOOKING'],
  BAKERY:      ['ORDER', 'BOOKING'],
  COSMETICS:   ['ORDER', 'BOOKING'],
  SALON:       ['BOOKING', 'WALKIN', 'ORDER', 'QUESTION'],
  BARBERSHOP:  ['BOOKING', 'WALKIN', 'ORDER', 'QUESTION'],
  ELECTRONICS: ['ORDER', 'SPEC_REQUEST', 'COMPARE', 'WARRANTY'],
  RETAIL:      ['ORDER'],
  FASHION:     ['ORDER'],
  DELIVERY:    ['ORDER'],
  GENERAL:     ['ENQUIRY', 'BOOKING'],
  SERVICES:    ['ENQUIRY', 'BOOKING'],
};
function stubGetModeConfig(business) {
  const mode = (business?.businessMode || 'RESTAURANT').toUpperCase();
  return { flows: STUB_MODE_FLOWS[mode] || STUB_MODE_FLOWS.RESTAURANT };
}

function loadRealDetectMidFlowSwitchRequest() {
  const src = read('../controllers/webhookController.js');

  const freeTextMatch = src.match(/const MFQ_FREE_TEXT_STEPS = new Set\(\[[\s\S]*?\]\);/);
  const dateTimeMatch = src.match(/const MFQ_DATE_TIME_STEPS = new Set\(\[[\s\S]*?\]\);/);
  const fnMatch       = src.match(/function _detectMidFlowSwitchRequest\(text, session, business(?:, isInteractive = false)?\) \{[\s\S]*?\n\}/);

  assert.ok(freeTextMatch, 'MFQ_FREE_TEXT_STEPS definition not found');
  assert.ok(dateTimeMatch, 'MFQ_DATE_TIME_STEPS definition not found');
  assert.ok(fnMatch, '_detectMidFlowSwitchRequest function body not found');

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'ORDER_DIRECT_RE', 'BOOKING_DIRECT_RE', 'DIRECT_INTENT_EXCLUDE_RE', 'QUESTION_LEADIN_RE', 'normaliseFsi',
    'findBestMatch', 'getModeConfig',
    `
    ${freeTextMatch[0]}
    ${dateTimeMatch[0]}
    ${fnMatch[0]}
    return _detectMidFlowSwitchRequest;
    `
  );
  return factory(
    ORDER_DIRECT_RE, BOOKING_DIRECT_RE, DIRECT_INTENT_EXCLUDE_RE, QUESTION_LEADIN_RE, normalise,
    stubFindBestMatch, stubGetModeConfig
  );
}

const detectMidFlowSwitchRequest = loadRealDetectMidFlowSwitchRequest();

// Default test business: RESTAURANT mode supports both ORDER and BOOKING, and
// has no menu/service catalog overlap with the test phrases below — this keeps
// all the pre-existing (pre-FIX-FSI-1/2) test cases behaving exactly as before.
const RESTAURANT_BIZ = { businessMode: 'RESTAURANT', menuItems: [], services: [] };

test('_detectMidFlowSwitchRequest: mid-BOOKING customer asking to order food is detected as a switch to ORDER', () => {
  const session = { currentFlow: 'BOOKING', step: 'PARTY_SIZE', data: {} };
  const phrases = ['I want to order food', 'order food', "I'd like to order", 'can I get some food'];
  for (const message of phrases) {
    assert.equal(
      detectMidFlowSwitchRequest(message, session, RESTAURANT_BIZ), 'ORDER',
      `"${message}" mid-booking should be detected as a switch request to ORDER`
    );
  }
});

test('_detectMidFlowSwitchRequest: mid-ORDER customer asking to book a table is detected as a switch to BOOKING', () => {
  const session = { currentFlow: 'ORDER', step: 'QUANTITY', data: {} };
  const phrases = ['I want to book a table', 'book a table', 'actually let me reserve a table', 'can I book instead'];
  for (const message of phrases) {
    assert.equal(
      detectMidFlowSwitchRequest(message, session, RESTAURANT_BIZ), 'BOOKING',
      `"${message}" mid-order should be detected as a switch request to BOOKING`
    );
  }
});

test('_detectMidFlowSwitchRequest: does NOT fire when the requested flow matches the flow already active', () => {
  // A restaurant customer mid-BOOKING answering "party of 4" contains "party of",
  // which matches BOOKING_DIRECT_RE — but they're already booking, so this must
  // be left alone as a normal flow answer, not trigger a pointless switch prompt.
  const bookingSession = { currentFlow: 'BOOKING', step: 'PARTY_SIZE', data: {} };
  assert.equal(detectMidFlowSwitchRequest('party of 4', bookingSession, RESTAURANT_BIZ), null);
  assert.equal(detectMidFlowSwitchRequest('book a table for tonight', bookingSession, RESTAURANT_BIZ), null);

  // An order customer typing "I want jollof rice" contains "i want", which
  // matches ORDER_DIRECT_RE — but they're already ordering, so this must fall
  // through as a normal item-name answer, not trigger a switch prompt.
  const orderSession = { currentFlow: 'ORDER', step: 'SELECT_ITEM', data: {} };
  assert.equal(detectMidFlowSwitchRequest('I want jollof rice', orderSession, RESTAURANT_BIZ), null);
});

test('_detectMidFlowSwitchRequest: negated/cancelling phrases never trigger a switch prompt', () => {
  const session = { currentFlow: 'BOOKING', step: 'PARTY_SIZE', data: {} };
  const phrases = [
    "I don't want to order anymore", "never mind, forget the order",
    "I don't want a table", 'not interested in ordering',
  ];
  for (const message of phrases) {
    assert.equal(
      detectMidFlowSwitchRequest(message, session, RESTAURANT_BIZ), null,
      `"${message}" must not trigger a switch prompt (negation/cancellation)`
    );
  }
});

test('_detectMidFlowSwitchRequest: never intercepts free-text or date/time flow steps', () => {
  // Same free-text/date-time exclusion sets the MFQ question intercept already
  // relies on — an address, note, or typed date must never be hijacked just
  // because it happens to contain a word like "order" or "book".
  const addressSession = { currentFlow: 'ORDER', step: 'ADDRESS', data: {} };
  assert.equal(detectMidFlowSwitchRequest('order a taxi to deliver to this address please', addressSession, RESTAURANT_BIZ), null);

  const dateSession = { currentFlow: 'BOOKING', step: 'SELECT_DATE', data: {} };
  assert.equal(detectMidFlowSwitchRequest('book it for next Tuesday', dateSession, RESTAURANT_BIZ), null);

  const notesSession = { currentFlow: 'ORDER', step: 'NOTES', data: {} };
  assert.equal(detectMidFlowSwitchRequest('please book this in for the office, not home', notesSession, RESTAURANT_BIZ), null);
});

test('_detectMidFlowSwitchRequest: never intercepts flows other than ORDER/BOOKING/question flows', () => {
  // A false-positive switch prompt on a niche flow (CAKE_CUSTOMIZATION, WALKIN,
  // LEAD_CAPTURE) is a worse outcome than doing nothing, so these are
  // deliberately left untouched. (ENQUIRY/QUESTION/SPEC_REQUEST — the question
  // flows — DO want switch detection; see the dedicated tests below.)
  const cakeSession = { currentFlow: 'CAKE_CUSTOMIZATION', step: 'SELECT_FLAVOUR', data: {} };
  assert.equal(detectMidFlowSwitchRequest('I want to order food', cakeSession, RESTAURANT_BIZ), null);
});

// ── [AUDIT-FIX-QMODE-1] Switch detection must survive past the first turn ───
//
// PROBLEM: persistQuestionSession() (services/questionAnswerService.js) always
// writes currentFlow: 'QUESTION' (or 'SPEC_REQUEST' for electronics), never
// 'ENQUIRY' — so only the customer's FIRST question runs with currentFlow
// still 'ENQUIRY' (handled by webhookController's own bespoke switch check at
// its ENQUIRY branch). Every question after that has currentFlow flipped to
// 'QUESTION'/'SPEC_REQUEST' with step stuck on AWAITING_QUESTION/SPEC_QUESTION
// — and this function was the only thing standing between the customer and a
// switch. Because AWAITING_QUESTION/SPEC_QUESTION are (correctly) listed in
// MFQ_FREE_TEXT_STEPS for the unrelated MFQ *question* intercept, reusing that
// same set here silently killed switch detection for every question after the
// first one. Typing "I want to order food" while in ongoing Q&A got no
// response at all beyond another AI answer attempt.
test('_detectMidFlowSwitchRequest: DOES detect a switch from AWAITING_QUESTION (ongoing Question Mode, not just the first turn)', () => {
  const questionSession = { currentFlow: 'QUESTION', step: 'AWAITING_QUESTION', data: {} };
  assert.equal(detectMidFlowSwitchRequest('book a table', questionSession, RESTAURANT_BIZ), 'BOOKING');
  assert.equal(detectMidFlowSwitchRequest('I want to order food', questionSession, RESTAURANT_BIZ), 'ORDER');

  const enquirySession = { currentFlow: 'ENQUIRY', step: 'AWAITING_QUESTION', data: {} };
  assert.equal(detectMidFlowSwitchRequest('book a table', enquirySession, RESTAURANT_BIZ), 'BOOKING');
});

test('_detectMidFlowSwitchRequest: DOES detect a switch from SPEC_QUESTION (ongoing electronics Question Mode)', () => {
  const specSession = { currentFlow: 'SPEC_REQUEST', step: 'SPEC_QUESTION', data: {} };
  const electronicsBiz = { businessMode: 'ELECTRONICS', menuItems: [], services: [] };
  assert.equal(detectMidFlowSwitchRequest('I want to order this laptop', specSession, electronicsBiz), 'ORDER');
});

test('_detectMidFlowSwitchRequest: ignores bare numbers and very short input (quantity/date noise)', () => {
  const session = { currentFlow: 'BOOKING', step: 'PARTY_SIZE', data: {} };
  assert.equal(detectMidFlowSwitchRequest('4', session, RESTAURANT_BIZ), null);
  assert.equal(detectMidFlowSwitchRequest('ok', session, RESTAURANT_BIZ), null);
});

// ── [FIX-FSI-1] Item-name collision guard ────────────────────────────────────

test('_detectMidFlowSwitchRequest: an exact menu-item name never triggers a switch prompt mid-ORDER', () => {
  // A restaurant sells a dish literally called "Reserve Cabernet" (a wine
  // pairing special). A customer mid-ORDER typing that name is naming an
  // item, not asking to book a table — even though it matches BOOKING_DIRECT_RE.
  const business = { businessMode: 'RESTAURANT', menuItems: [{ name: 'Reserve Cabernet' }], services: [] };
  const orderSession = { currentFlow: 'ORDER', step: 'SELECT_ITEM', data: {} };
  assert.equal(detectMidFlowSwitchRequest('Reserve Cabernet', orderSession, business), null);
});

test('_detectMidFlowSwitchRequest: an exact service name never triggers a switch prompt mid-BOOKING', () => {
  // A salon offers a service literally called "Coloring Book" (a themed kids'
  // colour treatment). A customer mid-BOOKING typing that name is selecting a
  // service, not asking to order food — even though it matches ORDER_DIRECT_RE.
  const business = { businessMode: 'SALON', menuItems: [], services: [{ name: 'Coloring Book' }] };
  const bookingSession = { currentFlow: 'BOOKING', step: 'SELECT_SERVICE', data: {} };
  assert.equal(detectMidFlowSwitchRequest('Coloring Book', bookingSession, business), null);
});

test('_detectMidFlowSwitchRequest: a LOW-confidence catalog match still allows the switch prompt', () => {
  // Only a HIGH-confidence catalog match should suppress the switch — a vague,
  // low-similarity typo shouldn't be treated as "the customer definitely meant
  // an existing item", so the ordinary switch-detection logic still applies.
  const business = { businessMode: 'RESTAURANT', menuItems: [{ name: 'Grilled Chicken Wrap' }], services: [] };
  const orderSession = { currentFlow: 'ORDER', step: 'SELECT_ITEM', data: {} };
  assert.equal(detectMidFlowSwitchRequest('I want to book a table', orderSession, business), 'BOOKING');
});

test('_detectMidFlowSwitchRequest: catalog collision check only looks at the CURRENT flow\'s own catalog', () => {
  // Mid-ORDER, a HIGH match against the ORDER catalog (menuItems) should
  // suppress the switch. A coincidental HIGH match against the OTHER flow's
  // catalog (services) must not — that's not what the customer is currently
  // selecting from.
  const business = {
    businessMode: 'SALON',
    menuItems: [],
    services: [{ name: 'I want to order food' }], // contrived: matches services, not menu
  };
  const orderSession = { currentFlow: 'ORDER', step: 'SELECT_ITEM', data: {} };
  assert.equal(detectMidFlowSwitchRequest('I want to order food', orderSession, business), null);
  // (returns null here anyway because targetFlow === flow — 'ORDER' === 'ORDER' —
  // but the case above with a genuine BOOKING request confirms the catalog checked is menuItems)
  const bookingSession = { currentFlow: 'BOOKING', step: 'SELECT_SERVICE', data: {} };
  assert.equal(detectMidFlowSwitchRequest('I want to order food', bookingSession, business), null);
});

// ── [FIX-FSI-2] Capability gate ───────────────────────────────────────────────

test('_detectMidFlowSwitchRequest: never offers a switch into a flow the business vertical does not support', () => {
  // Retail/Fashion/Electronics/Delivery verticals only support ['ORDER'] — no
  // BOOKING flow exists for them, so a mid-ORDER customer typing "book a table"
  // must never be offered a switch into a flow that doesn't exist for this business.
  const retailBiz = { businessMode: 'RETAIL', menuItems: [], services: [] };
  const orderSession = { currentFlow: 'ORDER', step: 'SELECT_ITEM', data: {} };
  assert.equal(detectMidFlowSwitchRequest('I want to book a table', orderSession, retailBiz), null);

  const fashionBiz = { businessMode: 'FASHION', menuItems: [], services: [] };
  assert.equal(detectMidFlowSwitchRequest('can I book instead', orderSession, fashionBiz), null);
});

test('_detectMidFlowSwitchRequest: still offers the switch when the target flow IS supported', () => {
  // Sanity check: the capability gate shouldn't suppress genuinely supported
  // switches. RESTAURANT, BAKERY, COSMETICS all support both ORDER and BOOKING.
  const bakeryBiz = { businessMode: 'BAKERY', menuItems: [], services: [] };
  const orderSession = { currentFlow: 'ORDER', step: 'SELECT_ITEM', data: {} };
  assert.equal(detectMidFlowSwitchRequest('I want to book a table', orderSession, bakeryBiz), 'BOOKING');
});

// ── Wiring checks (source guards, same style as v13MergeAudit.test.mjs) ─────

test('webhookController.js: FSI switch buttons are registered so they bypass intent detection', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(src.includes("'FSI_SWITCH_YES'"), 'FSI_SWITCH_YES must be registered in FLOW_PASSTHROUGH_IDS');
  assert.ok(src.includes("'FSI_SWITCH_NO'"), 'FSI_SWITCH_NO must be registered in FLOW_PASSTHROUGH_IDS');
  // Must also be explicitly exempted from the isFlowPassthroughId() advance() shortcut,
  // the same way MFQ_SWITCH_YES/NO already are — otherwise the buttons get swallowed
  // by advance() before the FSI handler block ever sees them.
  assert.ok(
    src.includes("upperMsg === 'FSI_SWITCH_YES' || upperMsg === 'FSI_SWITCH_NO'"),
    'FSI_SWITCH_YES/NO must be exempted from the passthrough advance() shortcut'
  );
});

test('webhookController.js: mid-flow switch intercept is wired in after the MFQ question intercept, before the final advance() call', () => {
  const src = read('../controllers/webhookController.js');
  const fsiCallIdx = src.indexOf('const _fsiTargetFlow = _detectMidFlowSwitchRequest(');
  const mfqBlockIdx = src.indexOf('15.1c: Detect question intent in typed free-text mid-flow');
  const finalAdvanceIdx = src.indexOf('ensure imageUrl cannot be truthy here with messageText empty');
  assert.ok(fsiCallIdx > -1, 'Mid-flow switch intercept is defined but never called');
  assert.ok(
    mfqBlockIdx > -1 && fsiCallIdx > mfqBlockIdx,
    'FSI switch intercept should run after the MFQ question intercept (questions take priority)'
  );
  assert.ok(
    finalAdvanceIdx > -1 && fsiCallIdx < finalAdvanceIdx,
    'FSI switch intercept must run before the flow falls through to the final advance() call'
  );
});

test('webhookController.js: FSI_SWITCH_YES starts the target flow fresh via startFlow()', () => {
  const src = read('../controllers/webhookController.js');
  // Target the actual handler block (`if (upperMsg === 'FSI_SWITCH_YES') {`), not
  // the earlier bypass-condition list mention or the button-definition mention.
  const idx = src.indexOf("if (upperMsg === 'FSI_SWITCH_YES') {");
  assert.ok(idx > -1, 'FSI_SWITCH_YES handler not found');
  const slice = src.slice(idx, idx + 1200);
  assert.ok(slice.includes('startFlow({'), 'FSI_SWITCH_YES should hand off to startFlow(), the same entry point START_ORDER/START_BOOKING use');
  assert.ok(slice.includes('_fsiTargetFlow'), 'FSI_SWITCH_YES should read the target flow captured at intercept time');
});

test('webhookController.js: FSI_SWITCH_NO restores the original flow and re-sends the current step', () => {
  const src = read('../controllers/webhookController.js');
  const idx = src.indexOf("if (upperMsg === 'FSI_SWITCH_NO') {");
  assert.ok(idx > -1, 'FSI_SWITCH_NO handler not found');
  const slice = src.slice(idx, idx + 1200);
  assert.ok(slice.includes('_fsiResumeFlow'), 'FSI_SWITCH_NO should restore from the saved resume context');
  assert.ok(slice.includes('advance('), 'FSI_SWITCH_NO should re-run advance() to re-send the current step prompt');
});

test('webhookController.js: startFlow is imported for the FSI_SWITCH_YES handler', () => {
  const src = read('../controllers/webhookController.js');
  assert.ok(
    /import\s*\{\s*advance\s*,\s*startFlow\s*\}\s*from\s*'\.\.\/core\/conversations\/flowEngine\.js'/.test(src),
    'startFlow must be imported from flowEngine.js alongside advance()'
  );
});

test('webhookController.js [AUDIT-FIX-9]: FSI switch prompt is mode-aware, not hardcoded to restaurant wording', () => {
  const src = read('../controllers/webhookController.js');
  const idx = src.indexOf('const targetBtnId   = _fsiTargetFlow');
  assert.ok(idx > -1, 'expected the mode-aware targetBtnId lookup introduced by AUDIT-FIX-9');
  const slice = src.slice(idx - 200, idx + 800);
  // The old hardcoded strings must be gone from this block.
  assert.doesNotMatch(
    slice,
    /'order food'|'book a table'/i,
    'FSI switch prompt must not hardcode restaurant-only wording — non-restaurant verticals (salon, bakery, cosmetics, etc.) can reach this branch via the [FIX-FSI-2] capability gate'
  );
  assert.ok(slice.includes('welcomeButtons'), 'expected the label to be sourced from the business\'s own mode config welcomeButtons');
});

// ── [FIX-QUESTION-VS-ORDER] "I want to know the price ..." is a question, ──
// ── not an order, even though it contains "i want" ──────────────────────────
//
// PROBLEM (screenshot-reported bug): a customer sitting in Question Mode
// typed "what are the prices of your food items" (answered with a generic
// clarifying prompt — see the questionAnswerService.js PRICE_RE fix in
// questionAnswerService.test.mjs) and then rephrased as "i want to know the
// prices of your food items". ORDER_DIRECT_RE matches the bare "i want" in
// that sentence, so this function reported a switch request to ORDER. The
// order flow then tried to parse "know the prices of your food items" as a
// product name, found nothing, and replied "I couldn't find ... in our
// current products" — a nonsense answer to a question the business's own
// menu data could answer directly. QUESTION_LEADIN_RE fixes this by
// recognising the "asking" framing before ORDER_DIRECT_RE/BOOKING_DIRECT_RE
// are even checked.
test('intentEngine.js: QUESTION_LEADIN_RE is exported', () => {
  assert.ok(QUESTION_LEADIN_RE instanceof RegExp, 'QUESTION_LEADIN_RE must be exported as a RegExp');
});

test('_detectMidFlowSwitchRequest: "I want to know the price/hours/menu ..." switches to QUESTION, not ORDER, even mid-ORDER', () => {
  const orderSession = { currentFlow: 'ORDER', step: 'SELECT_ITEM', data: {} };
  const phrases = [
    'i want to know the prices of your food items',
    "i'd like to know your opening hours",
    'i want to ask about allergens',
    'i have a question about the menu',
    'just wondering what the price is',
  ];
  for (const message of phrases) {
    assert.equal(
      detectMidFlowSwitchRequest(message, orderSession, RESTAURANT_BIZ), 'QUESTION',
      `"${message}" mid-order should be detected as a switch request to QUESTION, not ORDER`
    );
  }
});

test('_detectMidFlowSwitchRequest: "I want to know ..." while already in Question Mode does not (pointlessly) re-trigger a switch prompt', () => {
  const questionSession = { currentFlow: 'QUESTION', step: 'AWAITING_QUESTION', data: {} };
  assert.equal(
    detectMidFlowSwitchRequest('i want to know the prices of your food items', questionSession, RESTAURANT_BIZ),
    null,
    'already in QUESTION mode — target flow equals current flow, so no switch prompt should fire; the message should just be answered as a question'
  );
});

test('_detectMidFlowSwitchRequest: genuine order/booking phrases containing "i want" are unaffected by the QUESTION_LEADIN_RE guard', () => {
  const questionSession = { currentFlow: 'QUESTION', step: 'AWAITING_QUESTION', data: {} };
  assert.equal(detectMidFlowSwitchRequest('i want to order two burgers', questionSession, RESTAURANT_BIZ), 'ORDER');
  assert.equal(detectMidFlowSwitchRequest('i want to book a table for tonight', questionSession, RESTAURANT_BIZ), 'BOOKING');
});
