// tests/bookingNaturalLanguagePrefill.test.mjs
//
// Regression tests for the [FEAT-NLU-BOOKING-PREFILL] gap: a customer stating
// party size, date, AND time all in one natural-language sentence — e.g.
// "hello I want to book a table for three people on the first of next month
// at 3 pm" — used to have every one of those facts silently discarded. The
// bot would ask "How many guests?" / "What date?" / "What time?" one at a
// time, from scratch, even though the customer had already answered all
// three. Root causes, both fixed here:
//
//   1. parseDirectBookingRequest() (core/shared/moduleRegistry.js) required
//      party size to be a bare DIGIT ("table for 3"), not a word number
//      ("table for three people") — even though the flow's own PARTY_SIZE
//      step already accepts word numbers via parseQuantity(). It also
//      required party size, date, AND time to ALL resolve, discarding
//      everything (including a perfectly good time match) if even one
//      field missed — e.g. a date phrasing it didn't recognise.
//
//   2. Even when extraction succeeded, bookingFlow.js's INIT branch never
//      looked at what was already known — it always asked every question
//      from scratch.
//
// This file covers both: live execution of the (now-exported, pure,
// no-DB-dependency) parseDirectBookingRequest() with real sentences, and
// source-text assertions for the DB-dependent flow-control wiring in
// bookingFlow.js and moduleRegistry.js (consistent with this codebase's
// established testing convention — see other tests/*.test.mjs files).
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDirectBookingRequest } from '../core/shared/moduleRegistry.js';

function readSource(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const RESTAURANT = { hours: { timezone: 'UTC' } };

// ── Live execution: the extraction logic itself ────────────────────────────

test('parseDirectBookingRequest: extracts party size, date, and time from a single natural-language sentence', async () => {
  const result = await parseDirectBookingRequest(
    'hello I want to book a table for three people on the first of next month at 3 pm',
    RESTAURANT,
  );
  assert.ok(result, 'expected a non-null result — every field is stated in the sentence');
  assert.equal(result.partySize, 3, 'word number "three" must resolve to 3, same as the digit "3" would');
  assert.ok(result.parsedDate instanceof Date, 'expected a resolved Date for "the first of next month"');
  assert.equal(result.parsedDate.getUTCDate(), 1, 'the first of next month should resolve to day 1');
  assert.equal(result.time, '3 pm');
});

test('parseDirectBookingRequest: word numbers ("two", "four", "a dozen") resolve party size, not just digits', async () => {
  const two = await parseDirectBookingRequest('table for two tonight at 7pm', RESTAURANT);
  assert.equal(two.partySize, 2);

  const four = await parseDirectBookingRequest('book a table for four people tomorrow at 6pm', RESTAURANT);
  assert.equal(four.partySize, 4);

  const digit = await parseDirectBookingRequest('table for 5 tomorrow at 6pm', RESTAURANT);
  assert.equal(digit.partySize, 5, 'digit form must still work exactly as before — purely additive change');
});

test('parseDirectBookingRequest: returns a PARTIAL result instead of discarding everything when one field is missing', async () => {
  // No date anywhere in this message — old behavior discarded party size AND
  // the perfectly-good time match too, because it required all three fields
  // or returned null outright.
  const partial = await parseDirectBookingRequest('book a table for three people at 3pm', RESTAURANT);
  assert.ok(partial, 'a message missing only the date must still return whatever WAS found');
  assert.equal(partial.partySize, 3);
  assert.equal(partial.time, '3pm');
  assert.equal(partial.parsedDate, undefined, 'no date was stated, so none should be fabricated');
});

test('parseDirectBookingRequest: a single extracted field (party size only) still returns a partial result', async () => {
  const result = await parseDirectBookingRequest('book a table for two', RESTAURANT);
  assert.ok(result, 'even a single resolved field must be returned, not discarded');
  assert.equal(result.partySize, 2);
  assert.equal(result.parsedDate, undefined);
  assert.equal(result.time, undefined);
});

test('parseDirectBookingRequest: a message with none of the three fields returns null (unchanged behavior)', async () => {
  const result = await parseDirectBookingRequest('I want to book a table', RESTAURANT);
  assert.equal(result, null, 'nothing concrete was stated — the flow should ask normally, not guess');
});

test('parseDirectBookingRequest: an implausible party size (e.g. mis-extracted 90) is dropped rather than pre-filled', async () => {
  // Sanity cap mirrors bookingFlow.js's own PARTY_SIZE step limit (max 50).
  const result = await parseDirectBookingRequest('table for 90 tomorrow at 6pm', RESTAURANT);
  assert.equal(result.partySize, undefined, 'an out-of-range party size must not be silently pre-filled');
  assert.equal(result.time, '6pm', 'other, valid fields in the same message should still come through');
});

test('parseDirectBookingRequest: relative-month date phrasing beyond just "first" resolves too', async () => {
  const result = await parseDirectBookingRequest('table for 2 on the 15th of next month at 8pm', RESTAURANT);
  assert.ok(result.parsedDate instanceof Date);
  assert.equal(result.parsedDate.getUTCDate(), 15);
});

// ── bookingDateParser.js: underlying date-parsing broadening ───────────────

test('tryParseDate: "the first of next month" resolves without requiring the word "day"', async () => {
  const { tryParseDate } = await import('../core/nlu/resolution/bookingDateParser.js');
  const resolved = tryParseDate('the first of next month', 'UTC');
  assert.ok(resolved, 'expected this to resolve — "first day of next month" already worked, ' +
    '"first of next month" is at least as natural and was previously unmatched');
  assert.equal(resolved.getUTCDate(), 1);
});

test('tryParseDate: digit ordinal + "of next month" resolves (e.g. "the 22nd of next month")', async () => {
  const { tryParseDate } = await import('../core/nlu/resolution/bookingDateParser.js');
  const resolved = tryParseDate('the 22nd of next month', 'UTC');
  assert.ok(resolved, 'digit ordinals beyond "first"/"1st" must also resolve for an explicit "next month"');
  assert.equal(resolved.getUTCDate(), 22);
});

// ── bookingFlow.js: pre-fill resume wiring (source-text — DB-dependent) ────

test('bookingFlow.js: INIT branch checks for pre-filled data and resumes via _resumeFromPrefill', () => {
  const src = readSource('../core/conversations/bookingFlow.js');
  const initIdx = src.indexOf('if (message === null) {');
  assert.ok(initIdx !== -1, 'INIT branch not found');
  const initBlock = src.slice(initIdx, initIdx + 1200);
  assert.match(initBlock, /data\.partySize \|\| data\.parsedDate \|\| data\.time/,
    'INIT must check for any pre-filled field before falling into the normal fresh-start prompts');
  assert.match(initBlock, /_resumeFromPrefill/);
});

test('bookingFlow.js: _resumeFromPrefill skips party size, date, and time independently based on what is already known', () => {
  const src = readSource('../core/conversations/bookingFlow.js');
  const fnIdx = src.indexOf('async function _resumeFromPrefill(');
  assert.ok(fnIdx !== -1, '_resumeFromPrefill function not found');
  const nextFn = src.indexOf('\nasync function ', fnIdx + 1);
  const fnBody = nextFn === -1 ? src.slice(fnIdx) : src.slice(fnIdx, nextFn);

  assert.match(fnBody, /if \(isRestaurant && !data\.partySize\)/,
    'must still ask party size if it was not extracted');
  assert.match(fnBody, /if \(!data\.parsedDate\)/,
    'must still ask for a date if it was not extracted');
  assert.match(fnBody, /if \(!data\.time\)/,
    'must still confirm/ask for a time if it was not extracted');
  assert.match(fnBody, /validateTime\(data\.time/,
    'a pre-filled time must still be validated (e.g. not already passed today) before being trusted');
});

test('bookingFlow.js: PARTY_SIZE success path checks for an already-known date before showing the date picker again', () => {
  const src = readSource('../core/conversations/bookingFlow.js');
  const caseIdx = src.indexOf("case 'PARTY_SIZE': {");
  assert.ok(caseIdx !== -1, 'PARTY_SIZE case not found');
  const caseBody = src.slice(caseIdx, caseIdx + 3000);
  assert.match(caseBody, /if \(data\.parsedDate\)/,
    'after party size is answered, an already-known date (from the original ' +
    'sentence) must be confirmed directly instead of re-asking for it');
  assert.match(caseBody, /_confirmBookingDate/);
});

test('bookingFlow.js: DATE_CONFIRM "yes" path checks for an already-known time before showing the time picker again', () => {
  const src = readSource('../core/conversations/bookingFlow.js');
  const caseIdx = src.indexOf("case 'DATE_CONFIRM': {");
  assert.ok(caseIdx !== -1, 'DATE_CONFIRM case not found');
  const caseBody = src.slice(caseIdx, caseIdx + 3000);
  assert.match(caseBody, /if \(data\.time\)/,
    'after the date is confirmed, an already-known time (from the original ' +
    'sentence) must be confirmed directly instead of re-asking for it');
  assert.match(caseBody, /validateTime\(data\.time, bookingParsedDate, tz\)/,
    'the pre-filled time must be validated before being trusted — e.g. it ' +
    'could be a same-day time that has since passed');
});

// ── moduleRegistry.js: START_BOOKING hand-off (source-text — DB-dependent) ─

test('moduleRegistry.js: START_BOOKING merges partial extraction into data and defers step selection to the flow', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_BOOKING'");
  const end = src.indexOf("registerAction('WALKIN'", start);
  const block = src.slice(start, end);

  assert.match(block, /parseDirectBookingRequest/);
  assert.match(block, /step:\s*null/,
    'must not hardcode a specific step — a partial extraction could be missing ' +
    'any of party size, date, or time, so only the flow itself (via ' +
    '_resumeFromPrefill) knows which step to actually land on');
  assert.match(block, /mergedData/);
});
