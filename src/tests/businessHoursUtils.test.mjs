import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBookingDateClosed,
  getNextOpenBookingDate,
  formatClosedDayMessage,
  buildBookingTimeSlotDefs,
} from '../utils/businessHoursUtils.js';

const SALON_HOURS = {
  enabled: true,
  timezone: 'Africa/Banjul',
  open: 9,
  close: 19,
  days: {
    sunday:    { closed: true },
    monday:    { open: 9, close: 19 },
    tuesday:   { open: 9, close: 19 },
    wednesday: { open: 9, close: 19 },
    thursday:  { open: 9, close: 19 },
    friday:    { open: 9, close: 19 },
    saturday:  { open: 9, close: 18 },
  },
};

test('isBookingDateClosed: Sunday is closed for Gambian salon hours', () => {
  // 2026-07-19 is a Sunday
  const sunday = new Date(Date.UTC(2026, 6, 19));
  assert.equal(isBookingDateClosed(sunday, SALON_HOURS, 'Africa/Banjul'), true);
});

test('isBookingDateClosed: Monday is open', () => {
  const monday = new Date(Date.UTC(2026, 6, 20));
  assert.equal(isBookingDateClosed(monday, SALON_HOURS, 'Africa/Banjul'), false);
});

test('getNextOpenBookingDate: after Sunday returns Monday', () => {
  const sunday = new Date(Date.UTC(2026, 6, 19));
  const next = getNextOpenBookingDate(sunday, SALON_HOURS, 'Africa/Banjul');
  assert.ok(next);
  assert.match(next.label, /20/i);
});

test('formatClosedDayMessage mentions next open day', () => {
  const sunday = new Date(Date.UTC(2026, 6, 19));
  const msg = formatClosedDayMessage('19 July', SALON_HOURS, 'Africa/Banjul', sunday);
  assert.match(msg, /closed/i);
  assert.match(msg, /next available/i);
});

test('buildBookingTimeSlotDefs uses default 9–21 when hours disabled', () => {
  const monday = new Date(Date.UTC(2026, 6, 20));
  const slots = buildBookingTimeSlotDefs({ parsedDate: monday, hours: { enabled: false }, tz: 'UTC' });
  assert.equal(slots[0].minutes, 9 * 60);
  assert.equal(slots.at(-1).minutes, 20 * 60); // last hour before 21:00 close
  assert.equal(slots.length, 12);
});
