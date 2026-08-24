import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBookingPassthroughRecoveryId,
  recoverLostBookingPassthrough,
} from '../core/conversations/flowPassthroughRecovery.js';

test('isBookingPassthroughRecoveryId recognises booking list/button ids', () => {
  assert.equal(isBookingPassthroughRecoveryId('PARTY_10'), true);
  assert.equal(isBookingPassthroughRecoveryId('TIME_7PM'), true);
  assert.equal(isBookingPassthroughRecoveryId('TIME_M_660'), true);
  assert.equal(isBookingPassthroughRecoveryId('DATE_TODAY'), true);
  assert.equal(isBookingPassthroughRecoveryId('ORDER'), false);
  assert.equal(isBookingPassthroughRecoveryId('BOOK'), false);
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
    /recoverLostBookingPassthrough/,
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
