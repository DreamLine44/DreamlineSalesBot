// tests/bookingPrefillServicesAudit.test.mjs
//
// Regression tests for two [AUDIT-FIX-BOOKING-*] bugs found auditing the
// [FEAT-NLU-BOOKING-PREFILL] feature:
//
//   1. [AUDIT-FIX-BOOKING-ARTICLE-1] parseDirectBookingRequest()'s party-size
//      regex treated the bare articles "a"/"an" as a valid quantity whenever
//      they happened to sit between an anchor word ("table"/"reservation"/
//      etc.) and "for" — with no requirement that a real quantity phrase
//      follow. Ordinary sentences like "a table for a friend's birthday
//      party" or "a reservation for an anniversary dinner" silently produced
//      partySize: 1, and "book a table for a party of six" matched "a"
//      instead of continuing on to find "six".
//
//   2. [AUDIT-FIX-BOOKING-SERVICES-PREFILL] Both moduleRegistry.js's
//      START_BOOKING action and bookingFlow.js's SELECT_SERVICE case gated
//      the entire prefill feature behind "this business has NO services
//      configured". Any SALON/BARBERSHOP/SERVICES/GENERAL tenant with a
//      services list (the common case for those modes) never got any
//      benefit from parseDirectBookingRequest() at all — a message like
//      "book a haircut on the 15th at 3pm" reached startFlow() with data
//      reset to {}, discarding the extracted date/time entirely.
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

// ── [AUDIT-FIX-BOOKING-ARTICLE-1]: bare "a"/"an" no longer a false quantity ─

test('parseDirectBookingRequest: "a"/"an" used as plain articles do not produce a false party size', async () => {
  const cases = [
    "book a table for a friend's birthday party",
    'I need a table for an anniversary dinner',
    'can I get a reservation for a colleague',
  ];
  for (const msg of cases) {
    const result = await parseDirectBookingRequest(msg, RESTAURANT);
    assert.ok(
      !result || result.partySize === undefined,
      `expected no false party size for ${JSON.stringify(msg)}, got ${JSON.stringify(result)}`,
    );
  }
});

test('parseDirectBookingRequest: a real number later in the sentence is still found, not shadowed by an earlier "a"', async () => {
  const result = await parseDirectBookingRequest('book a table for a party of six tomorrow at 7pm', RESTAURANT);
  assert.ok(result, 'expected a non-null result');
  assert.equal(result.partySize, 6, 'the actual stated number (six) must win, not the earlier article "a"');
});

test('parseDirectBookingRequest: "a"/"an" still resolve to 1 when explicitly qualified ("a guest"/"a person")', async () => {
  const result = await parseDirectBookingRequest('table for a guest tomorrow at 7pm', RESTAURANT);
  assert.ok(result);
  assert.equal(result.partySize, 1);
});

test('parseDirectBookingRequest: word numbers and digits still resolve as before (no regression)', async () => {
  const three = await parseDirectBookingRequest('table for three people tomorrow at 7pm', RESTAURANT);
  assert.equal(three.partySize, 3);
  const five = await parseDirectBookingRequest('table for 5 tomorrow at 6pm', RESTAURANT);
  assert.equal(five.partySize, 5);
});

// ── [AUDIT-FIX-BOOKING-SERVICES-PREFILL]: services-list businesses ─────────

test('moduleRegistry.js: START_BOOKING no longer gates the prefill merge behind an empty services list', () => {
  const src = readSource('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('START_BOOKING'");
  const end = src.indexOf("registerAction('WALKIN'", start);
  const block = src.slice(start, end);

  assert.match(block, /const directBooking = await parseDirectBookingRequest/);
  // The old gate — `if (directBooking && !(business?.services || []).length)` —
  // must be gone; the merge now happens for every business regardless of
  // whether it has a services list, since bookingFlow.js's SELECT_SERVICE
  // case handles the "services still need picking first" ordering itself.
  assert.ok(
    !/if \(directBooking && !\(business\?\.services/.test(block),
    'the services-list gate on merging directBooking must be removed',
  );
  assert.match(block, /if \(directBooking\)\s*\{/);
});

test('bookingFlow.js: SELECT_SERVICE delegates to _resumeFromPrefill instead of hardcoding the next prompt', () => {
  const src = readSource('../core/conversations/bookingFlow.js');
  const caseIdx = src.indexOf("case 'SELECT_SERVICE': {");
  assert.ok(caseIdx !== -1, 'SELECT_SERVICE case not found');
  const nextCaseIdx = src.indexOf("\n    case '", caseIdx + 1);
  const caseBody = src.slice(caseIdx, nextCaseIdx);

  assert.match(caseBody, /_resumeFromPrefill\(session, updatedData/,
    'must hand off to _resumeFromPrefill so an already-known date/time is not silently re-asked after service selection');
  assert.match(caseBody, /heading:\s*`Great — \*\$\{service\.name\}\* selected! ✅`/,
    'the "Great — X selected!" confirmation must still be shown via the heading param');
});


test('bookingFlow.js: _resumeFromPrefill accepts an optional heading and prepends it to every prompt it returns', () => {
  const src = readSource('../core/conversations/bookingFlow.js');
  const fnIdx = src.indexOf('async function _resumeFromPrefill(');
  assert.ok(fnIdx !== -1);
  const nextFn = src.indexOf('\nasync function ', fnIdx + 1);
  const fnBody = nextFn === -1 ? src.slice(fnIdx) : src.slice(fnIdx, nextFn);

  assert.match(fnBody, /heading = null/, 'heading must be optional so the no-services call site is unaffected');
  assert.match(fnBody, /withHeading/);
  assert.match(fnBody, /_confirmBookingDate\(session, data, \{[\s\S]*?\}, \{ business, tenant, tz, heading \}\)/,
    'the date-known-but-time-missing branch must forward heading into _confirmBookingDate');
});

// ── [AUDIT-FIX-BOOKING-CONFIRM-WIDEN]: DATE_CONFIRM/TIME_CONFIRM widened ────

test('bookingFlow.js: DATE_CONFIRM uses the shared confirmationMatcher, not just a narrow literal regex', () => {
  const src = readSource('../core/conversations/bookingFlow.js');
  const caseIdx = src.indexOf("case 'DATE_CONFIRM': {");
  assert.ok(caseIdx !== -1, 'DATE_CONFIRM case not found');
  const nextCaseIdx = src.indexOf("\n    case '", caseIdx + 1);
  const caseBody = src.slice(caseIdx, nextCaseIdx);

  assert.match(caseBody, /confirmationMatcher\.js/,
    'DATE_CONFIRM must use the same shared yes/no resolver BOOKING_CONFIRM already uses, ' +
    'so "sure"/"sounds good"/"nah change it" are recognised here too');
  assert.match(caseBody, /_isAffirmativeDate\(raw\)/);
  assert.match(caseBody, /_isNegativeDate\(raw\)/);
});

test('bookingFlow.js: TIME_CONFIRM uses the shared confirmationMatcher, not just a narrow literal regex', () => {
  const src = readSource('../core/conversations/bookingFlow.js');
  const caseIdx = src.indexOf("case 'TIME_CONFIRM': {");
  assert.ok(caseIdx !== -1, 'TIME_CONFIRM case not found');
  const nextCaseIdx = src.indexOf("\n    case '", caseIdx + 1);
  const caseBody = src.slice(caseIdx, nextCaseIdx);

  assert.match(caseBody, /confirmationMatcher\.js/);
  assert.match(caseBody, /_isAffirmativeTime\(raw\)/);
  assert.match(caseBody, /_isNegativeTime\(raw\)/);
});

test('confirmationMatcher.js: isAffirmative/isNegative never fire on a plain time string (no collision with TIME_CONFIRM\'s own re-entry path)', async () => {
  const { isAffirmative, isNegative } = await import('../core/nlu/resolution/confirmationMatcher.js');
  for (const t of ['2pm', '14:30', '9:00 AM', '11am']) {
    assert.equal(isAffirmative(t), false, `${t} must not be misread as "yes"`);
    assert.equal(isNegative(t), false, `${t} must not be misread as "no"`);
  }
});

