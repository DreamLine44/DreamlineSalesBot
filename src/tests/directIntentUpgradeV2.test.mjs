// tests/directIntentUpgradeV2.test.mjs
//
// Regression tests for [UPGRADE-DIRECT-INTENT-2], the follow-up to
// [UPGRADE-DIRECT-INTENT]. Three changes, each verified below:
//
//   1. ORDER_DIRECT_RE / BOOKING_DIRECT_RE widened to catch requests that
//      don't contain the literal word "order"/"book" (e.g. "give me 2 burgers",
//      "table for tonight"), still without hijacking cancel/track/status phrasing.
//   2. The AI-classify short-message skip threshold dropped from <8 chars to
//      <4 chars (pre-flow only), so short-but-real requests ("buy 2", "book pls")
//      get a chance at Groq classification instead of going straight to
//      CLARIFY/FALLBACK. In-flow short replies are unaffected (still CONTINUE_FLOW).
//   3. Every path that ends in CLARIFY or FALLBACK now logs the raw message text,
//      so missed phrasings are visible for the next audit-and-fix pass instead of
//      silently disappearing.
//
// Same isolation approach as directIntentUpgrade.test.mjs: pure-function/regex
// tests re-implemented from the source, plus source-text assertions that fail
// loudly if intentEngine.js's actual code drifts from what's tested here.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const SRC = read('../core/nlu/classification/intentEngine.js');

const normalise = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

const DIRECT_INTENT_EXCLUDE_RE = new RegExp(
  '\\b(' + [
    'cancel', 'cancle', "don'?t", 'don t', 'do not', 'dont', 'stop',
    'no longer', 'nevermind', 'never mind', 'nvm', 'not interested',
    'track', 'status', 'where is', 'where s', 'when is', 'update',
    'how long', 'refund', 'reject', 'decline',
  ].join('|') + ')\\b' + '|\\bcheck\\w*\\b'
);

// Widened v2 vocabulary — kept in exact sync with intentEngine.js via the
// source-text assertion in the first test below.
const ORDER_DIRECT_RE   = /\b(order|buy|purchase|shopping|can i get|can i have|i ll have|i ll take|give me|get me|i want|i d like|craving)\b/;
const BOOKING_DIRECT_RE = /\b(book|reserve|reservation|appointment|table for|party of|table at|table tonight|come in|slot for|availability for)\b/;

function classify(raw) {
  const clean = normalise(raw);
  if (DIRECT_INTENT_EXCLUDE_RE.test(clean)) return null;
  if (BOOKING_DIRECT_RE.test(clean)) return 'START_BOOKING';
  if (ORDER_DIRECT_RE.test(clean)) return 'START_ORDER';
  return null;
}

test('intentEngine.js: widened regex constants match what is under test here', () => {
  assert.match(SRC, /can i get\|can i have\|i ll have\|i ll take\|give me\|get me\|i want\|i d like\|craving/,
    'ORDER_DIRECT_RE in source must match the widened list tested here');
  assert.match(SRC, /party of\|table at\|table tonight\|come in\|slot for\|availability for/,
    'BOOKING_DIRECT_RE in source must match the widened list tested here');
});

test('widened phrasing: requests without the literal word order/book still route correctly', () => {
  const orderCases = [
    'give me 2 burgers',
    'get me a large pizza',
    'can i get a coke',
    "i'll have the chicken meal",
    'i want 2 pizzas',
    "i'd like the family bucket",
    'craving some suya tonight',
  ];
  const bookingCases = [
    'table for tonight please',
    'party of 4 tonight',
    'do you have a slot for tomorrow',
    'can i come in at 6pm',
    'any availability for saturday',
  ];
  for (const msg of orderCases) {
    assert.equal(classify(msg), 'START_ORDER', `Expected "${msg}" to route to START_ORDER`);
  }
  for (const msg of bookingCases) {
    assert.equal(classify(msg), 'START_BOOKING', `Expected "${msg}" to route to START_BOOKING`);
  }
});

test('widened phrasing: still never hijacks cancel/track/status/refund requests', () => {
  for (const msg of [
    'cancel my order',
    'where is my order',
    'order status',
    'track my order',
    'checking on my order',
    'can i get a refund on my order',
    'how long will my order take',
  ]) {
    assert.equal(classify(msg), null, `Expected "${msg}" NOT to be hijacked`);
  }
});

test('AUDIT-FIX: "don\'t" negation with an apostrophe is correctly excluded (was previously not)', () => {
  // Regression guard for [AUDIT-FIX-DIRECT-INTENT-3]: normalise() turns apostrophes
  // into spaces, so "don't" becomes "don t" — the bare "don'?t" pattern never matched
  // it, and since the literal word "order"/"book" was still present, these messages
  // used to incorrectly fire START_ORDER/START_BOOKING despite being a clear decline.
  for (const msg of [
    "I don't want to order anymore",
    "Don't order anything for me",
    "I don't want to book a table",
    "Don't book that for me",
  ]) {
    assert.equal(classify(msg), null, `Expected "${msg}" to be excluded (negation), not routed to a fresh flow`);
  }
  // Sanity: genuine requests must still pass through untouched by this fix.
  assert.equal(classify("I want to order food"), 'START_ORDER');
  assert.equal(classify("I want to book a table"), 'START_BOOKING');
});

test('intentEngine.js: source contains the fixed exclude pattern (don t, space-separated)', () => {
  assert.match(SRC, /'don t'/, 'Exclude list must include the space-separated post-normalisation form of "don\'t"');
});

test('intentEngine.js: AI-classify short-message threshold lowered from 8 to 4 chars, pre-flow only', () => {
  assert.match(SRC, /raw\.length < 4/, 'Short-circuit threshold must now be 4, not 8');
  assert.match(SRC, /raw\.length < 8 && session\?\.currentFlow/,
    'In-flow short replies (4-7 chars) must still short-circuit to CONTINUE_FLOW without reaching AI classify');

  // The AI-classify block (step 7) must not be gated by raw.length at all —
  // only by session.currentFlow — so a pre-flow message as short as 4 chars
  // gets a chance at classification.
  const step7Idx = SRC.indexOf('7. AI classify');
  const step8Idx = SRC.indexOf('8. Final fallback');
  const step7Block = SRC.slice(step7Idx, step8Idx);
  assert.doesNotMatch(step7Block, /raw\.length/, 'Step 7 (AI classify) must not re-check raw.length');
  assert.match(step7Block, /session\?\.currentFlow/, 'Step 7 must still be pre-flow only');
});

test('intentEngine.js: every CLARIFY/FALLBACK exit point logs the raw message for audit visibility', () => {
  const missLogCalls = SRC.match(/logger\.info\('\[IntentEngine\] miss'/g) || [];
  assert.ok(missLogCalls.length >= 3,
    `Expected at least 3 miss-logging call sites (short-fallback, clarify, final-fallback), found ${missLogCalls.length}`);
  assert.match(SRC, /path: 'short-fallback'/);
  assert.match(SRC, /path: 'clarify'/);
  assert.match(SRC, /path: 'final-fallback'/);
});
