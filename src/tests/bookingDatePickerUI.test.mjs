// tests/bookingDatePickerUI.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDatePickerHub,
  buildSimpleDayList,
  buildWeekDayList,
  buildMonthPickerList,
  buildMonthDayList,
  parseDayId,
  parseMonthId,
  toDayId,
} from '../services/booking/bookingDatePickerUI.js';

const TZ = 'Africa/Banjul';

test('buildSimpleDayList: professional date prompt with choose button', () => {
  const ui = buildSimpleDayList(TZ);
  assert.equal(ui.type, 'list');
  assert.equal(ui.button, 'Choose a date');
  assert.ok(ui.body.includes('Please select your preferred date'));
  assert.ok(!ui.body.includes('no typing'));
  assert.equal(ui.footer, undefined);
  assert.ok(ui.sections[0].rows.length >= 1);
  assert.match(ui.sections[0].rows[0].id, /^DATE_D_/);
});

test('buildDatePickerHub: offers week and month dropdown paths', () => {
  const ui = buildDatePickerHub();
  assert.equal(ui.type, 'buttons');
  assert.equal(ui.buttons.length, 3);
  assert.ok(ui.buttons.some(b => b.id === 'DATE_HUB_MONTH'));
});

test('buildWeekDayList: returns list with day rows', () => {
  const ui = buildWeekDayList(0, TZ);
  assert.equal(ui.type, 'list');
  assert.ok(ui.sections[0].rows.length >= 1);
  assert.match(ui.sections[0].rows[0].id, /^DATE_D_/);
});

test('buildMonthPickerList: returns month dropdown rows', () => {
  const ui = buildMonthPickerList(TZ);
  assert.equal(ui.type, 'list');
  assert.equal(ui.button, 'Choose month');
  assert.ok(ui.sections[0].rows.length >= 1);
  assert.match(ui.sections[0].rows[0].id, /^DATE_M_/);
});

test('buildMonthDayList: returns day rows for a month', () => {
  const now = new Date();
  const ui = buildMonthDayList({ year: now.getUTCFullYear(), month: now.getUTCMonth(), tz: TZ });
  assert.equal(ui.type, 'list');
  assert.ok(ui.sections[0].rows.some(r => r.id.startsWith('DATE_D_') || r.id === 'DATE_MONTH_BACK'));
});

test('parseDayId and parseMonthId round-trip', () => {
  const d = new Date(Date.UTC(2026, 7, 15));
  const id = toDayId(d);
  const parsed = parseDayId(id);
  assert.equal(parsed.getUTCDate(), 15);
  assert.equal(parsed.getUTCMonth(), 7);

  const month = parseMonthId('DATE_M_202608');
  assert.deepEqual(month, { year: 2026, month: 7 });
});

test('resolveDayPick: DATE_D list id returns exact day without re-parse drift', async () => {
  const { resolveDayPick } = await import('../services/booking/bookingDatePickerUI.js');
  const { tryParseDate } = await import('../services/booking/bookingDateParser.js');

  // Use a date relative to "now" (10 days out) instead of a hardcoded
  // calendar date, so this test doesn't go stale and start failing once
  // that fixed date is in the past.
  const now = new Date();
  const future = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 10));
  const id = toDayId(future);
  const day = future.getUTCDate();
  const monthName = future.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const weekdayName = future.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  const year = future.getUTCFullYear();

  const pick = await resolveDayPick(id, TZ);
  assert.equal(pick.ok, true);
  assert.match(pick.label, new RegExp(`${day} ${monthName} ${year}`));
  assert.match(pick.label, new RegExp(weekdayName, 'i'));
  assert.equal(tryParseDate(`${day} ${monthName} ${year}`, TZ).getUTCDate(), day);
});
