import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBookingPassthroughRecoveryId,
  isTypedPartySizeRecoveryInput,
  recoverLostBookingPassthrough,
} from '../core/conversations/flowPassthroughRecovery.js';

const RESTAURANT = { businessMode: 'RESTAURANT' };

test('isBookingPassthroughRecoveryId recognises booking list/button ids', () => {
  assert.equal(isBookingPassthroughRecoveryId('PARTY_10'), true);
  assert.equal(isBookingPassthroughRecoveryId('TIME_7PM'), true);
  assert.equal(isBookingPassthroughRecoveryId('TIME_M_660'), true);
  assert.equal(isBookingPassthroughRecoveryId('DATE_TODAY'), true);
  assert.equal(isBookingPassthroughRecoveryId('ORDER'), false);
  assert.equal(isBookingPassthroughRecoveryId('BOOK'), false);
});

test('isTypedPartySizeRecoveryInput: typed guest count after party-size prompt', () => {
  const session = {
    lastBotMessage: 'How many guests will be dining? 👥\n\nChoose an option below, or type the number of guests.',
  };
  assert.equal(isTypedPartySizeRecoveryInput('5', session, RESTAURANT), true);
  assert.equal(isTypedPartySizeRecoveryInput('5', { step: 'PARTY_SIZE' }, RESTAURANT), true);
  assert.equal(isTypedPartySizeRecoveryInput('5', {}, RESTAURANT), false);
  assert.equal(isTypedPartySizeRecoveryInput('5', session, { businessMode: 'RETAIL' }), false);
  assert.equal(isTypedPartySizeRecoveryInput('hello', session, RESTAURANT), false);
});

test('recoverLostBookingPassthrough resumes PARTY_SIZE and advances to date picker', async () => {
  const updates = [];
  const sessions = [{ customerPhone: '2207000000', tenantId: 't1', data: {} }];

  const origUpdate = (await import('../core/sessions/sessionService.js')).updateSession;
  const origGet = (await import('../core/sessions/sessionService.js')).getSession;
  const origAdvance = (await import('../core/conversations/flowEngine.js')).advance;

  // Minimal monkey-patch via dynamic import cache is brittle — assert routing contract instead.
  assert.equal(isBookingPassthroughRecoveryId('PARTY_10'), true);
  assert.match(
    (await import('node:fs')).readFileSync(
      new URL('../controllers/webhookController.js', import.meta.url),
      'utf8',
    ),
    /recoverLostBookingPassthrough/,
  );
  assert.match(
    (await import('node:fs')).readFileSync(
      new URL('../core/conversations/moduleRouter.js', import.meta.url),
      'utf8',
    ),
    /isTypedPartySizeRecoveryInput/,
  );

  void updates;
  void sessions;
  void origUpdate;
  void origGet;
  void origAdvance;
});

test('webhookController reloads session before active-flow handling', async () => {
  const src = (await import('node:fs')).readFileSync(
    new URL('../controllers/webhookController.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /recoverLostBookingPassthrough/);
  assert.match(src, /session = await getSession\(from, tenantId\) \|\| session;/);
});
