import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinBusinessHours } from '../controllers/webhookController.js';

// [FIX-TZ-4] regression: the weekday used to look up day-specific hours must be
// resolved in the BUSINESS timezone, the same timezone used for the hour check —
// not the server process's local timezone (`now.getDay()`).
//
// We can't control "now" from outside the function, so instead of mocking the
// clock we pick a business timezone far enough from the actual server clock
// (UTC, since these tests run under default Node TZ) that the two would
// disagree on the day name during part of the day — then assert the function's
// day-lookup actually uses the *business* day, by checking which day-specific
// override fires.

test('business hours: day-specific override resolves to business timezone weekday, not server weekday', () => {
  const now = new Date();
  // Determine what "today" and "tomorrow" are in two opposite-side timezones.
  const businessTz = 'Pacific/Kiritimati'; // UTC+14, almost always a day ahead of UTC
  const businessDay = new Intl.DateTimeFormat('en', { timeZone: businessTz, weekday: 'long' })
    .format(now).toLowerCase();
  const serverUtcDay = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][now.getUTCDay()];

  // Build hours where the BUSINESS's actual day is closed, and every other day
  // (including whatever the server/UTC day resolves to) is wide open 0-24.
  const allDays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const days = {};
  for (const d of allDays) {
    days[d] = (d === businessDay) ? { closed: true } : { open: 0, close: 24 };
  }

  const hours = { enabled: true, timezone: businessTz, days };

  // If the function correctly resolves the weekday in the business timezone,
  // it must find businessDay -> closed -> return false, REGARDLESS of what day
  // it is on the server/UTC clock right now.
  const result = isWithinBusinessHours(hours);
  assert.equal(
    result,
    false,
    `expected closed (business day "${businessDay}" is marked closed); ` +
    `server/UTC day is "${serverUtcDay}" — if this fails, the day lookup is using ` +
    `server time instead of business timezone`
  );
});

test('business hours: UTC business with no day-specific override still respects open/close hours', () => {
  const now = new Date();
  const decimalHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const hours = { enabled: true, timezone: 'UTC', open: 0, close: 24 };
  assert.equal(isWithinBusinessHours(hours), true, 'business open 0-24 UTC should always be open');

  // Now make it closed all day (close === open edge case approximated via closed day)
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const todayUtc = dayNames[now.getUTCDay()];
  const closedHours = { enabled: true, timezone: 'UTC', days: { [todayUtc]: { closed: true } } };
  assert.equal(isWithinBusinessHours(closedHours), false, 'explicitly closed today (UTC) should be closed');
  void decimalHour;
});

test('business hours: disabled hours always returns open', () => {
  assert.equal(isWithinBusinessHours({ enabled: false }), true);
  assert.equal(isWithinBusinessHours(null), true);
});
