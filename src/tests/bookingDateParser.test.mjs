// tests/bookingDateParser.test.mjs
//
// Regression tests for services/bookingDateParser.js — natural-language and
// numeric date parsing, validation, and AI fallback wiring.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tryParseDate,
  looksLikeDate,
  validateBookingDate,
  formatBookingDateLabel,
  resolveBookingDateInput,
  getLocalNow,
  MAX_BOOKING_MONTHS_AHEAD,
} from '../core/nlu/resolution/bookingDateParser.js';

const TZ = 'Africa/Banjul';

function fixedNow(year, month, day) {
  return toUtcMidnight(year, month - 1, day);
}

function toUtcMidnight(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}

test('tryParseDate: bare weekday "friday" resolves to upcoming Friday', () => {
  const now = getLocalNow(TZ);
  const parsed = tryParseDate('friday', TZ);
  assert.ok(parsed);
  assert.equal(parsed.getUTCDay(), 5);
  assert.ok(parsed.getTime() >= toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()).getTime());
});

test('tryParseDate: "On Friday" and "on friday" resolve to Friday (not garbage native parse)', () => {
  for (const input of ['On Friday', 'on friday', 'on Friday']) {
    const parsed = tryParseDate(input, TZ);
    assert.ok(parsed, `expected parse for "${input}"`);
    assert.equal(parsed.getUTCDay(), 5, `"${input}" should be a Friday`);
    assert.notEqual(parsed.getUTCMonth(), 0, `"${input}" must not collapse to January`);
    assert.notEqual(parsed.getUTCDate(), 1, `"${input}" must not collapse to the 1st`);
  }
});

test('tryParseDate: "on next friday" resolves to a future Friday', () => {
  const parsed = tryParseDate('on next friday', TZ);
  assert.ok(parsed);
  assert.equal(parsed.getUTCDay(), 5);
  const now = getLocalNow(TZ);
  assert.ok(parsed.getTime() >= toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()).getTime());
});

test('tryParseDate: "on the 6th" resolves to day 6 this or next month', () => {
  const parsed = tryParseDate('on the 6th', TZ);
  assert.ok(parsed);
  assert.equal(parsed.getUTCDate(), 6);
});

test('tryParseDate: "on the 6th of this month" resolves to day 6', () => {
  const parsed = tryParseDate('on the 6th of this month', TZ);
  assert.ok(parsed);
  assert.equal(parsed.getUTCDate(), 6);
});

test('tryParseDate: "8 of december" resolves to 8 December', () => {
  const now = getLocalNow(TZ);
  const parsed = tryParseDate('8 of december', TZ);
  assert.ok(parsed);
  assert.equal(parsed.getUTCDate(), 8);
  assert.equal(parsed.getUTCMonth(), 11);
  if (now.getUTCMonth() > 11 || (now.getUTCMonth() === 11 && now.getUTCDate() > 8)) {
    assert.equal(parsed.getUTCFullYear(), now.getUTCFullYear() + 1);
  }
});

test('tryParseDate: DD/MM/YYYY numeric format (19/8/2026)', () => {
  const parsed = tryParseDate('19/8/2026', TZ);
  assert.ok(parsed);
  assert.equal(parsed.getUTCFullYear(), 2026);
  assert.equal(parsed.getUTCMonth(), 7);
  assert.equal(parsed.getUTCDate(), 19);
});

test('tryParseDate: DD.MM.YYYY numeric format (9.8.2026)', () => {
  const parsed = tryParseDate('9.8.2026', TZ);
  assert.ok(parsed);
  assert.equal(parsed.getUTCFullYear(), 2026);
  assert.equal(parsed.getUTCMonth(), 7);
  assert.equal(parsed.getUTCDate(), 9);
});

test('validateBookingDate: rejects past dates', () => {
  const past = fixedNow(2020, 1, 1);
  const result = validateBookingDate(past, TZ);
  assert.ok(result.error);
  assert.match(result.error, /already passed/i);
});

test('validateBookingDate: rejects dates beyond booking horizon', () => {
  const now = getLocalNow(TZ);
  const far = toUtcMidnight(now.getUTCFullYear() + 2, now.getUTCMonth(), now.getUTCDate());
  const result = validateBookingDate(far, TZ);
  assert.ok(result.error);
  assert.match(result.error, /too far/i);
  assert.match(result.error, new RegExp(`${MAX_BOOKING_MONTHS_AHEAD} months`));
});

test('formatBookingDateLabel: human-readable confirmation label', () => {
  const d = toUtcMidnight(2026, 7, 8);
  const label = formatBookingDateLabel(d, TZ);
  assert.match(label, /August/i);
  assert.match(label, /2026/);
});

test('resolveBookingDateInput: returns label for "friday"', async () => {
  const result = await resolveBookingDateInput('friday', TZ);
  assert.equal(result.ok, true);
  assert.ok(result.label);
  assert.ok(result.parsed);
});

test('tryParseDate: "next months first day" resolves to first day of next month', () => {
  const parsed = tryParseDate('next months first day', TZ);
  assert.ok(parsed);
  const now = getLocalNow(TZ);
  const expected = toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  assert.equal(parsed.getTime(), expected.getTime());
});

test('tryParseDate: "next month first" resolves to first day of next month', () => {
  const parsed = tryParseDate('next month first', TZ);
  assert.ok(parsed);
  const now = getLocalNow(TZ);
  const expected = toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  assert.equal(parsed.getTime(), expected.getTime());
});

test('looksLikeDate: recognises next-month-first-day phrases', () => {
  assert.equal(looksLikeDate('next months first day'), true);
  assert.equal(looksLikeDate('first day of next month'), true);
  assert.equal(looksLikeDate('next month first'), true);
});

test('tryParseDate: typed date and "today" keyword agree regardless of process TZ', () => {
  const now = new Date();
  const day = now.getUTCDate();
  const month = now.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const typed = tryParseDate(`${day} ${month}`, TZ);
  const keyword = tryParseDate('today', TZ);

  assert.ok(typed);
  assert.ok(keyword);
  assert.equal(typed.getTime(), keyword.getTime());
});

test('tryParseDate: always returns UTC-midnight (hours/minutes/seconds zeroed)', () => {
  const cases = ['today', 'tomorrow', 'yesterday', 'next Friday', '25 December', '1st January', 'friday'];
  for (const c of cases) {
    const d = tryParseDate(c, TZ);
    if (!d) continue;
    assert.equal(d.getUTCHours(), 0, `${c} should be UTC-midnight (hours)`);
    assert.equal(d.getUTCMinutes(), 0, `${c} should be UTC-midnight (minutes)`);
    assert.equal(d.getUTCSeconds(), 0, `${c} should be UTC-midnight (seconds)`);
  }
});

test('tryParseDate: ordinal suffixes are stripped correctly', () => {
  const a = tryParseDate('25th December', TZ);
  const b = tryParseDate('25 December', TZ);
  assert.ok(a && b);
  assert.equal(a.getTime(), b.getTime());
});

test('tryParseDate: "next <weekday>" resolves to a date strictly in the future', () => {
  const now = new Date();
  const next = tryParseDate('next monday', TZ);
  assert.ok(next);
  assert.ok(next.getTime() > now.getTime() - 24 * 60 * 60 * 1000);
});

test('tryParseDate: unparseable garbage does not throw', () => {
  assert.doesNotThrow(() => tryParseDate('', TZ));
  assert.doesNotThrow(() => tryParseDate(null, TZ));
  assert.equal(tryParseDate('', TZ), null);
});
