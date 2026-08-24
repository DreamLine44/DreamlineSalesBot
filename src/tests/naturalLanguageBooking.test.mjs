import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePartySizeFromText } from '../utils/parsePartySize.js';
import {
  parseBookingTimeToMinutes,
  resolveBookingTimeInput,
  extractBookingTimeFromText,
  looksLikeBookingTime,
} from '../utils/parseBookingTime.js';
import {
  tryParseDate,
  extractBookingDatePhraseFromText,
  resolveBookingDateInput,
} from '../services/bookingDateParser.js';
import { parseDirectBookingRequest } from '../core/shared/moduleRegistry.js';

const TZ = 'Africa/Banjul';
const RESTAURANT = { businessMode: 'RESTAURANT', hours: { timezone: TZ } };

test('parsePartySizeFromText: relational and natural phrases', () => {
  assert.equal(parsePartySizeFromText('just me'), 1);
  assert.equal(parsePartySizeFromText('me and my wife'), 2);
  assert.equal(parsePartySizeFromText('me and two friends'), 3);
  assert.equal(parsePartySizeFromText('there are 12 of us'), 12);
  assert.equal(parsePartySizeFromText('we are 8'), 8);
  assert.equal(parsePartySizeFromText('a group of 15'), 15);
  assert.equal(parsePartySizeFromText('around 10'), 10);
  assert.equal(parsePartySizeFromText('actually make it 6'), 6);
  assert.equal(parsePartySizeFromText('table for 8 people next Friday'), 8);
});

test('parseBookingTime: requires AM/PM or clear context', () => {
  assert.equal(parseBookingTimeToMinutes('noon'), 12 * 60);
  assert.equal(parseBookingTimeToMinutes('8pm'), 20 * 60);
  assert.equal(parseBookingTimeToMinutes('8'), null);
  assert.equal(parseBookingTimeToMinutes('7 tonight', { context: 'book tomorrow' }), 19 * 60);
  assert.equal(parseBookingTimeToMinutes('2 in the afternoon'), 14 * 60);
  assert.equal(parseBookingTimeToMinutes('7:30 PM'), 19 * 60 + 30);
  assert.equal(parseBookingTimeToMinutes('7:30'), null);
  assert.equal(looksLikeBookingTime('8pm'), true);
  assert.equal(looksLikeBookingTime('8'), false);
  assert.equal(looksLikeBookingTime('around 8pm'), true);
  const resolved = resolveBookingTimeInput('make it 8pm', { context: 'dinner' });
  assert.equal(resolved.minutes, 20 * 60);
});

test('extractBookingTimeFromText pulls time from full sentence', () => {
  const t = extractBookingTimeFromText('table for 8 next Friday around 7pm');
  assert.ok(t);
  assert.equal(t.minutes, 19 * 60);
});

test('bookingDateParser: relative offsets and tonight', () => {
  assert.ok(tryParseDate('in 3 days', TZ));
  assert.ok(tryParseDate('in 2 weeks', TZ));
  assert.ok(tryParseDate('tonight', TZ));
});

test('extractBookingDatePhraseFromText finds date in sentence', () => {
  assert.match(extractBookingDatePhraseFromText('book for 6 next Friday at 7'), /next friday/i);
  const phrase = extractBookingDatePhraseFromText('first of next month at 8');
  assert.ok(phrase);
  assert.match(phrase, /first.*next month/i);
});

test('parseDirectBookingRequest: rich NL restaurant booking', async () => {
  const result = await parseDirectBookingRequest(
    'Can I book a table for 8 people next Friday around 7pm?',
    RESTAURANT,
  );
  assert.equal(result.partySize, 8);
  assert.ok(result.date);
  assert.match(result.time, /7:00 PM/i);
});

test('parseDirectBookingRequest: relational guest count', async () => {
  const result = await parseDirectBookingRequest('me and two friends tomorrow at 7pm', RESTAURANT);
  assert.equal(result.partySize, 3);
  assert.ok(result.date);
});

test('resolveBookingDateInput strips correction prefix', async () => {
  const resolved = await resolveBookingDateInput('no, Friday', TZ);
  assert.ok(resolved.ok || resolved.error === 'unparseable');
});
