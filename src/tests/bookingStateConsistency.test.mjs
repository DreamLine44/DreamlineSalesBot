import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookingDateIsoFromParsed,
  coerceBookingParsedDate,
  enrichBookingSessionData,
  parsedFromBookingDateIso,
} from '../services/booking/bookingState.js';
import { normalizeCustomerPhone, customerPhoneQueryVariants } from '../utils/customerPhone.js';
import { buildActiveBookingFilter } from '../services/activity/activityLifecycleService.js';

const TZ = 'Africa/Banjul';

test('bookingDateIsoFromParsed: stable YYYY-MM-DD', () => {
  const d = new Date(Date.UTC(2026, 8, 1));
  assert.equal(bookingDateIsoFromParsed(d), '2026-09-01');
  assert.equal(parsedFromBookingDateIso('2026-09-01').getUTCDate(), 1);
});

test('coerceBookingParsedDate: prefers bookingDateIso over re-parse', () => {
  const data = {
    date: 'Tuesday, 1 September 2026',
    bookingDateIso: '2026-09-01',
  };
  const parsed = coerceBookingParsedDate(data, TZ);
  assert.equal(parsed.getUTCMonth(), 8);
  assert.equal(parsed.getUTCDate(), 1);
});

test('enrichBookingSessionData: sets iso + parsed together', () => {
  const parsed = new Date(Date.UTC(2026, 8, 1));
  const merged = enrichBookingSessionData({ partySize: 2 }, {
    parsed,
    label: 'Tuesday, 1 September 2026',
    raw: 'first of next month',
    tz: TZ,
  });
  assert.equal(merged.partySize, 2);
  assert.equal(merged.bookingDateIso, '2026-09-01');
  assert.equal(merged.date, 'Tuesday, 1 September 2026');
});

test('normalizeCustomerPhone: digits-only canonical form', () => {
  assert.equal(normalizeCustomerPhone('+2203532423'), '2203532423');
  assert.equal(normalizeCustomerPhone('2203532423'), '2203532423');
  assert.deepEqual(customerPhoneQueryVariants('+2203532423'), ['2203532423', '+2203532423']);
});

test('sessionKey: always uses normalized phone', async () => {
  const { sessionKey } = await import('../core/sessions/sessionService.js');
  assert.equal(sessionKey('+2203532423', 't1'), '2203532423_t1');
  assert.equal(sessionKey('2203532423', 't1'), '2203532423_t1');
});

test('buildActiveBookingFilter: phone variant lookup', () => {
  const filter = buildActiveBookingFilter('+2203532423', 'tenant1');
  assert.deepEqual(filter.customerPhone.$in, ['2203532423', '+2203532423']);
  assert.equal(filter.tenantId, 'tenant1');
});
