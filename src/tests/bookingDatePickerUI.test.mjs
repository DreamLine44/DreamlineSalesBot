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
