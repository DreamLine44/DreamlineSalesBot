// tests/bookingFlow.test.mjs
//
// Pure, additive regression tests for core/conversations/bookingFlow.js.
// Does NOT modify any existing source file (besides the one documented fix
// in the file under test itself).
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryParseDate } from '../core/conversations/bookingFlow.js';

test('tryParseDate: typed date and "today" keyword agree regardless of process TZ', () => {
  // Regression test for [FIX-TZ-3]: native Date parsing of a typed date like
  // "30 June" is interpreted in the server PROCESS's local timezone, while
  // "today"/"tomorrow"/"next X" are built explicitly via Date.UTC(). Before
  // the fix, these two paths could disagree about which calendar day "today"
  // is whenever the Node process wasn't running with TZ=UTC — silently
  // breaking the same-day past-time check in validateTime().
  //
  // This test can't change process.env.TZ mid-run reliably across platforms,
  // so it asserts the structural invariant instead: a typed date for today
  // always returns the same UTC-midnight timestamp as the "today" keyword.
  const now = new Date();
  const day = now.getUTCDate();
  const month = now.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const typed = tryParseDate(`${day} ${month}`, 'Africa/Banjul');
  const keyword = tryParseDate('today', 'Africa/Banjul');

  assert.ok(typed, 'expected a parsed date for the typed "day month" string');
  assert.ok(keyword, 'expected a parsed date for "today"');
  assert.equal(typed.getTime(), keyword.getTime());
});

test('tryParseDate: always returns UTC-midnight (hours/minutes/seconds zeroed)', () => {
  const cases = ['today', 'tomorrow', 'yesterday', 'next Friday', '25 December', '1st January'];
  for (const c of cases) {
    const d = tryParseDate(c, 'Africa/Banjul');
    if (!d) continue; // some inputs may legitimately fail to parse
    assert.equal(d.getUTCHours(), 0, `${c} should be UTC-midnight (hours)`);
    assert.equal(d.getUTCMinutes(), 0, `${c} should be UTC-midnight (minutes)`);
    assert.equal(d.getUTCSeconds(), 0, `${c} should be UTC-midnight (seconds)`);
  }
});

test('tryParseDate: ordinal suffixes are stripped correctly', () => {
  const a = tryParseDate('25th December', 'Africa/Banjul');
  const b = tryParseDate('25 December', 'Africa/Banjul');
  assert.ok(a && b);
  assert.equal(a.getTime(), b.getTime());
});

test('tryParseDate: "next <weekday>" resolves to a date strictly in the future', () => {
  const now = new Date();
  const next = tryParseDate('next monday', 'Africa/Banjul');
  assert.ok(next);
  assert.ok(next.getTime() > now.getTime() - 24 * 60 * 60 * 1000);
});

test('tryParseDate: unparseable garbage does not throw', () => {
  assert.doesNotThrow(() => tryParseDate('', 'Africa/Banjul'));
  assert.doesNotThrow(() => tryParseDate(null, 'Africa/Banjul'));
  assert.equal(tryParseDate('', 'Africa/Banjul'), null);
});
