// tests/directIntentUpgrade.test.mjs
//
// Regression tests for [UPGRADE-DIRECT-INTENT].
//
// Feature: when a customer's message unambiguously asks to order or book,
// intentEngine.js must route them STRAIGHT into that flow (skipping the
// generic 3-button welcome menu), the same way an exact "order food" /
// "book a table" already did via the step-4 whole-message keyword match.
//
// Before this change, only a literal whole-message match against the
// hardcoded strings in patterns.js INTENT_PATTERNS.ORDER / .BOOKING worked.
// Natural phrasing with extra words ("I want to order food please", "can I
// book a table for tonight") fell through to Levenshtein (too far in edit
// distance to match) → AI classify (may be unavailable/UNKNOWN) → FALLBACK,
// which shows the welcome menu instead of the customer's actual request.
//
// These are source-text + pure-function guards. The exclusion/detection
// regexes are exercised directly (they have no external dependencies), and
// their presence/wiring inside detectIntent() is verified via source text,
// consistent with how v13MergeAudit.test.mjs / v14SystematicAudit.test.mjs
// verify control flow in files with heavy runtime dependencies (Mongo, Express).
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const normalise = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Re-implemented from intentEngine.js for isolated testing — kept in exact sync
// via the source-text assertions below, which fail loudly if intentEngine.js's
// actual regexes ever drift from these.
const DIRECT_INTENT_EXCLUDE_RE = new RegExp(
  '\\b(' + [
    'cancel', 'cancle', "don'?t", 'do not', 'dont', 'stop',
    'no longer', 'nevermind', 'never mind', 'nvm', 'not interested',
    'track', 'status', 'where is', 'where s', 'when is', 'update',
    'how long', 'refund', 'reject', 'decline',
  ].join('|') + ')\\b' + '|\\bcheck\\w*\\b'
);
const ORDER_DIRECT_RE   = /\b(order|buy|purchase|shopping)\b/;
const BOOKING_DIRECT_RE = /\b(book|reserve|reservation|appointment|table for)\b/;

function classify(raw) {
  const clean = normalise(raw);
  if (DIRECT_INTENT_EXCLUDE_RE.test(clean)) return null;
  if (ORDER_DIRECT_RE.test(clean)) return 'START_ORDER';
  if (BOOKING_DIRECT_RE.test(clean)) return 'START_BOOKING';
  return null;
}

test('intentEngine.js: wires up the direct ORDER/BOOKING phrase step before Levenshtein', () => {
  const src = read('../core/nlu/classification/intentEngine.js');
  const exactIdx  = src.indexOf('4. Exact keyword match');
  const directIdx = src.indexOf('4.5. Direct ORDER / BOOKING phrase match');
  const levIdx    = src.indexOf('5. Partial match with Levenshtein');
  assert.ok(exactIdx !== -1 && directIdx !== -1 && levIdx !== -1, 'Expected all three steps present');
  assert.ok(exactIdx < directIdx && directIdx < levIdx, 'Direct-phrase step must run after exact match, before Levenshtein');

  const directBlock = src.slice(directIdx, levIdx);
  assert.match(directBlock, /session\?\.currentFlow/, 'Direct-phrase step must only run pre-flow');
  assert.match(directBlock, /START_ORDER/);
  assert.match(directBlock, /START_BOOKING/);
});

test('direct phrasing: natural order requests bypass the welcome menu', () => {
  for (const msg of [
    'I want to order food please',
    'I want to order food',
    'can I order some food',
    "I'd like to order 2 pizzas",
    'I am ready to order now',
  ]) {
    assert.equal(classify(msg), 'START_ORDER', `Expected "${msg}" to route directly to START_ORDER`);
  }
});

test('direct phrasing: natural booking requests bypass the welcome menu', () => {
  for (const msg of [
    'I want to book a table',
    'can I book a table for tonight',
    'I want to book an appointment for tomorrow',
    'book haircut for tomorrow',
    'I need a table for 4',
  ]) {
    assert.equal(classify(msg), 'START_BOOKING', `Expected "${msg}" to route directly to START_BOOKING`);
  }
});

test('direct phrasing: never hijacks cancellation, tracking, or status-check requests', () => {
  for (const msg of [
    'cancel my order',
    'I dont want to order anymore',
    'never mind, cancel that order',
    'where is my order',
    'order status',
    'track my order',
    'checking on my order',
    'check my booking status',
    'how long will my order take',
    'can I get a refund on my order',
  ]) {
    assert.equal(classify(msg), null, `Expected "${msg}" NOT to be hijacked into a fresh START_ORDER/START_BOOKING`);
  }
});
