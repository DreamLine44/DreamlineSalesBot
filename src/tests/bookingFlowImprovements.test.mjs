import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBookingTimeSlotDefs,
  getHoursForBookingDate,
} from '../utils/businessHoursUtils.js';
import {
  parseDirectBookingRequest,
  resolveDirectBookingStep,
} from '../core/shared/moduleRegistry.js';

const RESTAURANT_HOURS = {
  enabled: true,
  timezone: 'Africa/Banjul',
  open: 11,
  close: 22,
  days: {
    sunday:    { closed: true },
    monday:    { open: 11, close: 22 },
    tuesday:   { open: 11, close: 22 },
    wednesday: { open: 11, close: 22 },
    thursday:  { open: 11, close: 22 },
    friday:    { open: 11, close: 22 },
    saturday:  { open: 11, close: 23 },
  },
};

const RESTAURANT = { businessMode: 'RESTAURANT', hours: RESTAURANT_HOURS };

test('buildBookingTimeSlotDefs respects business hours', () => {
  const monday = new Date(Date.UTC(2026, 7, 24)); // Monday
  const slots = buildBookingTimeSlotDefs({ parsedDate: monday, hours: RESTAURANT_HOURS, tz: 'Africa/Banjul' });
  assert.ok(slots.length >= 10);
  assert.equal(slots[0].id, 'TIME_M_660'); // 11:00 AM
  assert.match(slots[0].title, /11:00 AM/);
  assert.equal(slots.at(-1).minutes, 21 * 60); // last slot before 22:00 close
});

test('getHoursForBookingDate returns null on closed days', () => {
  const sunday = new Date(Date.UTC(2026, 7, 23));
  assert.equal(getHoursForBookingDate(sunday, RESTAURANT_HOURS, 'Africa/Banjul'), null);
});

test('parseDirectBookingRequest: full NL restaurant booking', async () => {
  const result = await parseDirectBookingRequest('table for 4 tomorrow at 7pm', RESTAURANT);
  assert.equal(result.partySize, 4);
  assert.ok(result.date);
  assert.match(result.time, /7.*pm/i);
});

test('parseDirectBookingRequest: partial party + date', async () => {
  const result = await parseDirectBookingRequest('table for 4 tomorrow', RESTAURANT);
  assert.equal(result.partySize, 4);
  assert.ok(result.date);
  assert.equal(result.time, null);
});

test('parseDirectBookingRequest: partial date + time', async () => {
  const result = await parseDirectBookingRequest('tomorrow at 7pm', RESTAURANT);
  assert.equal(result.partySize, null);
  assert.ok(result.date);
  assert.match(result.time, /7.*pm/i);
});

test('resolveDirectBookingStep routes partial restaurant requests', () => {
  assert.equal(
    resolveDirectBookingStep({ partySize: 4, date: '25 August', time: '7:00 PM', isRestaurant: true }),
    'BOOKING_CONFIRM',
  );
  assert.equal(
    resolveDirectBookingStep({ partySize: 4, date: '25 August', time: null, isRestaurant: true }),
    'DATE_CONFIRM',
  );
  assert.equal(
    resolveDirectBookingStep({ partySize: null, date: '25 August', time: '7:00 PM', isRestaurant: true }),
    'PARTY_SIZE',
  );
});

test('bookingFlow exposes resume entry for pre-set steps', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(dir, '../core/conversations/bookingFlow.js'), 'utf8');
  assert.match(src, /if \(step\) \{\s*return _renderBookingStepEntry/);
  assert.match(src, /PARTY_8/);
  assert.match(src, /\(isSalonMode \|\| isRestaurantMode\)/);
});
