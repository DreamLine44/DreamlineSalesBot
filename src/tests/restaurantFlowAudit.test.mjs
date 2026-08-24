import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTypedBookingDateRecoveryInput,
  isTypedBookingTimeRecoveryInput,
  isTypedPartySizeRecoveryInput,
  shouldRecoverLostBookingPassthrough,
} from '../core/conversations/flowPassthroughRecovery.js';
import { continueFromMergedBookingData } from '../services/bookingInterpretation.js';

const RESTAURANT = { businessMode: 'RESTAURANT', hours: { timezone: 'Africa/Banjul' } };
const TZ = 'Africa/Banjul';

test('isTypedBookingDateRecoveryInput: first-time booker after date prompt', () => {
  const session = {
    lastBotMessage: 'Perfect — *2 guests* 👥\n\nWhat date would you like? 📅',
    data: { partySize: 2 },
  };
  assert.equal(isTypedBookingDateRecoveryInput('first of next month', session, RESTAURANT), true);
  assert.equal(isTypedBookingDateRecoveryInput('hello', session, RESTAURANT), false);
});

test('isTypedBookingDateRecoveryInput: orphaned DATE step', () => {
  assert.equal(
    isTypedBookingDateRecoveryInput('tomorrow', { step: 'DATE' }, RESTAURANT),
    true,
  );
});

test('isTypedBookingTimeRecoveryInput: after time prompt', () => {
  const session = {
    lastBotMessage: '*2 guests* on *Tuesday, 1 September 2026* 👥\n\nWhat time works for you? ⏰',
    data: { partySize: 2, date: 'Tuesday, 1 September 2026' },
  };
  assert.equal(isTypedBookingTimeRecoveryInput('9pm', session, RESTAURANT), true);
  assert.equal(isTypedBookingTimeRecoveryInput('hello', session, RESTAURANT), false);
});

test('shouldRecoverLostBookingPassthrough: typed date without existing booking', () => {
  const session = {
    lastBotMessage: 'What date would you like? 📅',
    data: { partySize: 2 },
  };
  assert.equal(shouldRecoverLostBookingPassthrough({
    messageText: 'next Friday',
    session,
    business: RESTAURANT,
    isInteractive: false,
  }), true);
});

test('continueFromMergedBookingData: persists guest correction at BOOKING_CONFIRM', async () => {
  const session = { customerPhone: '2207000000', tenantId: 't1' };
  const data = {
    partySize: 10,
    date: 'Tuesday, 26 August 2026',
    parsedDate: new Date(Date.UTC(2026, 7, 26)),
    bookingDateIso: '2026-08-26',
    time: '7:00 PM',
  };

  const reply = await continueFromMergedBookingData({
    session,
    data,
    step: 'BOOKING_CONFIRM',
    business: RESTAURANT,
    tenant: {},
    tz: TZ,
    changed: true,
    confirmBookingDateFn: async () => ({ type: 'buttons', body: 'date confirm' }),
    buildBookingSummaryFn: (d) => ({
      type: 'buttons',
      body: `Summary ${d.partySize} guests`,
    }),
    buildTimePickerFn: async () => ({ type: 'list', body: 'time' }),
    validateTimeFn: () => null,
  });

  assert.match(reply.body, /10 guests/);
});

test('continueFromMergedBookingData: date correction rewinds to DATE_CONFIRM', async () => {
  const session = { customerPhone: '2207000000', tenantId: 't1' };
  const data = {
    partySize: 2,
    date: 'Friday, 29 August 2026',
    parsedDate: new Date(Date.UTC(2026, 7, 29)),
    bookingDateIso: '2026-08-29',
    dateRaw: 'next Friday',
  };

  let confirmCalled = false;
  const reply = await continueFromMergedBookingData({
    session,
    data,
    step: 'TIME_CONFIRM',
    business: RESTAURANT,
    tenant: {},
    tz: TZ,
    changed: true,
    changedFields: { partySize: false, date: true, time: false },
    confirmBookingDateFn: async () => {
      confirmCalled = true;
      return { type: 'buttons', body: 'Just to confirm — did you mean Friday?' };
    },
    buildBookingSummaryFn: () => ({ type: 'buttons', body: 'summary' }),
    buildTimePickerFn: async () => ({ type: 'list', body: 'time' }),
    validateTimeFn: () => null,
  });

  assert.equal(confirmCalled, true);
  assert.match(reply.body, /confirm/i);
});

test('isTypedPartySizeRecoveryInput: relational guest phrase after prompt', () => {
  const session = {
    lastBotMessage: 'How many guests will be dining? 👥\n\nChoose an option below, or type the number of guests.',
  };
  assert.equal(isTypedPartySizeRecoveryInput('me and two friends', session, RESTAURANT), true);
  assert.equal(isTypedPartySizeRecoveryInput('5', session, RESTAURANT), true);
});

test('isTypedBookingTimeRecoveryInput: noon and around 8pm', () => {
  const session = {
    lastBotMessage: '*2 guests* on *Tuesday, 1 September 2026* 👥\n\nWhat time works for you? ⏰',
  };
  assert.equal(isTypedBookingTimeRecoveryInput('noon', session, RESTAURANT), true);
  assert.equal(isTypedBookingTimeRecoveryInput('around 8pm', session, RESTAURANT), true);
});

test('mergeActiveBookingFields hydrates date for time recovery', async () => {
  const { recoverLostBookingPassthrough } = await import('../core/conversations/flowPassthroughRecovery.js');
  assert.match(
    recoverLostBookingPassthrough.toString(),
    /mergeActiveBookingFields|activeBooking\.date/,
  );
});

test('continueFromMergedBookingData: typing time at DATE_CONFIRM stays on date confirm', async () => {
  const session = { customerPhone: '2207000000', tenantId: 't1' };
  const data = {
    partySize: 2,
    date: 'Tuesday, 1 September 2026',
    parsedDate: new Date(Date.UTC(2026, 8, 1)),
    bookingDateIso: '2026-09-01',
    time: '9:00 PM',
  };

  let confirmCalled = false;
  const reply = await continueFromMergedBookingData({
    session,
    data,
    step: 'DATE_CONFIRM',
    business: RESTAURANT,
    tenant: {},
    tz: TZ,
    changed: true,
    changedFields: { partySize: false, date: false, time: true },
    confirmBookingDateFn: async () => {
      confirmCalled = true;
      return { type: 'buttons', body: 'Just to confirm — Tuesday, 1 September 2026?' };
    },
    buildBookingSummaryFn: () => ({ type: 'buttons', body: 'summary' }),
    buildTimePickerFn: async () => ({ type: 'list', body: 'time' }),
    validateTimeFn: () => null,
  });

  assert.equal(confirmCalled, true);
  assert.match(reply.body, /confirm/i);
});

test('continueFromMergedBookingData: date correction clears time and rewinds', async () => {
  const session = { customerPhone: '2207000000', tenantId: 't1' };
  const data = {
    partySize: 2,
    date: 'Friday, 29 August 2026',
    parsedDate: new Date(Date.UTC(2026, 7, 29)),
    bookingDateIso: '2026-08-29',
    dateRaw: 'next Friday',
  };

  let confirmCalled = false;
  await continueFromMergedBookingData({
    session,
    data,
    step: 'TIME_CONFIRM',
    business: RESTAURANT,
    tenant: {},
    tz: TZ,
    changed: true,
    changedFields: { partySize: false, date: true, time: false },
    confirmBookingDateFn: async () => {
      confirmCalled = true;
      return { type: 'buttons', body: 'Confirm new date' };
    },
    buildBookingSummaryFn: () => ({ type: 'buttons', body: 'summary' }),
    buildTimePickerFn: async () => ({ type: 'list', body: 'time' }),
    validateTimeFn: () => null,
  });

  assert.equal(confirmCalled, true);
  assert.equal(data.time, undefined);
});

test('webhook skips direct-order shortcut during active BOOKING', async () => {
  const src = (await import('node:fs')).readFileSync(
    new URL('../controllers/webhookController.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /activeFlow !== 'BOOKING'/);
});

test('webhook MFQ excludes CONFIRM and PARTY_SIZE steps', async () => {
  const src = (await import('node:fs')).readFileSync(
    new URL('../controllers/webhookController.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /MFQ_ORDER_INPUT_STEPS[\s\S]*'CONFIRM'/);
  assert.match(src, /step === 'PARTY_SIZE'/);
});

test('orderFlow CONFIRM accepts done / that\'s all as checkout', async () => {
  const src = (await import('node:fs')).readFileSync(
    new URL('../modules/restaurant/flows/orderFlow.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /wantsCheckout[\s\S]*that'?s all/i);
});
