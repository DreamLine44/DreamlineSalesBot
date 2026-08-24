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
import { parseDirectBookingRequest, resolveDirectBookingStep } from '../core/shared/moduleRegistry.js';

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

test('parsePartySizeFromText: does not treat calendar day as guest count', () => {
  assert.equal(parsePartySizeFromText('book for 25 June at 7pm'), null);
  assert.equal(parsePartySizeFromText('table for 25 June'), null);
  assert.equal(parsePartySizeFromText('Can I book for 8 next Friday at 7pm?'), 8);
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

test('Test A: full NL booking — 2 guests, first of next month', async () => {
  const msg = 'Hello I want book a table for 2 people on the first of next month';
  const result = await parseDirectBookingRequest(msg, RESTAURANT);
  assert.equal(result.partySize, 2);
  assert.ok(result.date, 'date label should be set');
  assert.ok(result.parsedDate, 'parsedDate should be normalized');
  const iso = `${result.parsedDate.getUTCFullYear()}-${String(result.parsedDate.getUTCMonth() + 1).padStart(2, '0')}-${String(result.parsedDate.getUTCDate()).padStart(2, '0')}`;
  // Relative to run date — first of next month from Aug 2026 is Sep 1
  assert.ok(/^\d{4}-\d{2}-01$/.test(iso), `expected first-of-month ISO, got ${iso}`);
  assert.equal(result.time, null);
  assert.equal(
    resolveDirectBookingStep({ partySize: result.partySize, date: result.date, time: result.time, isRestaurant: true }),
    'DATE_CONFIRM',
  );
});

test('Test B: guests + next Friday + 7pm', async () => {
  const result = await parseDirectBookingRequest('Can I book for 8 next Friday at 7pm?', RESTAURANT);
  assert.equal(result.partySize, 8);
  assert.ok(result.date);
  assert.match(result.time, /7:00 PM/i);
  assert.equal(
    resolveDirectBookingStep({ partySize: result.partySize, date: result.date, time: result.time, isRestaurant: true }),
    'TIME_CONFIRM',
  );
});

test('Test C: 12 of us tomorrow', async () => {
  const result = await parseDirectBookingRequest('There are 12 of us. We\'d like to come tomorrow.', RESTAURANT);
  assert.equal(result.partySize, 12);
  assert.ok(result.date);
});

test('Test D: me and two friends next Saturday around 8', async () => {
  const result = await parseDirectBookingRequest('Me and two friends next Saturday around 8.', RESTAURANT);
  assert.equal(result.partySize, 3);
  assert.ok(result.date);
  assert.ok(result.time, 'time should be inferred from evening context');
});

test('Test E: first of next month phrase parses', async () => {
  const resolved = await resolveBookingDateInput('first of next month', TZ);
  assert.equal(resolved.ok, true, resolved.error || 'should parse');
  assert.match(resolved.label, /1/i);
});

test('Test F: CONFIRM is a system action not a date', async () => {
  const { isBookingSystemAction } = await import('../services/bookingInterpretation.js');
  assert.equal(isBookingSystemAction('CONFIRM'), true);
  const resolved = await resolveBookingDateInput('CONFIRM', TZ);
  assert.equal(resolved.ok, false);
});

test('parseDirectBookingRequest: book for DD Month is date-only not guest count', async () => {
  const result = await parseDirectBookingRequest('book for 25 June at 7pm', RESTAURANT);
  assert.equal(result.partySize, null);
  assert.ok(result.date);
  assert.match(result.time, /7.*pm/i);
});

test('interpretBookingMessage: rejects oversized party via NL merge', async () => {
  const { interpretBookingMessage } = await import('../services/bookingInterpretation.js');
  const result = await interpretBookingMessage('party of 2026 on 25 June', RESTAURANT, {});
  assert.equal(result.merged.partySize, undefined);
  assert.ok(result.merged.date || result.extracted?.date);
});

test('Test G: correction updates guest count', async () => {
  const { interpretBookingMessage } = await import('../services/bookingInterpretation.js');
  const first = await interpretBookingMessage('Book for 4 tomorrow.', RESTAURANT, {});
  assert.equal(first.merged.partySize, 4);
  const corrected = await interpretBookingMessage('Actually make it 10.', RESTAURANT, first.merged);
  assert.equal(corrected.merged.partySize, 10);
  assert.ok(corrected.merged.date, 'date should be preserved from prior turn');
});
