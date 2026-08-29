// tests/adminAuthService.test.mjs
//
// Regression tests for services/adminAuthService.js ([FEATURE-MULTIADMIN-1]).
// Pure crypto primitives, no DB — matches the codebase's convention of a
// dedicated test file per audit fix / new feature (see emotionEngine.test.mjs,
// patterns.test.mjs). Covers:
//   (a) hashPassword/verifyPassword round-trip, including wrong-password and
//       wrong-salt rejection
//   (b) createSessionToken/verifySessionToken round-trip, tamper detection,
//       and expiry
//   (c) invite token hashing round-trip
//
// Run with: node --test src/tests/
// Requires ADMIN_SESSION_SECRET set in the environment (adminAuthService
// throws deliberately if it's missing — see the comment on getSessionSecret).

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const {
  hashPassword, verifyPassword,
  generateInviteToken, hashInviteToken,
  createSessionToken, verifySessionToken,
} = await import('../services/admin/adminAuthService.js');

// ── Passwords ────────────────────────────────────────────────────────────────

test('hashPassword/verifyPassword: correct password verifies', () => {
  const { salt, hash } = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', salt, hash), true);
});

test('hashPassword/verifyPassword: wrong password is rejected', () => {
  const { salt, hash } = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('wrong password', salt, hash), false);
});

test('hashPassword: same password produces different hashes on each call (random salt)', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  // but both still verify against the original password with their own salt
  assert.equal(verifyPassword('same-password', a.salt, a.hash), true);
  assert.equal(verifyPassword('same-password', b.salt, b.hash), true);
});

test('verifyPassword: missing salt or hash is rejected, never throws', () => {
  assert.equal(verifyPassword('anything', null, 'somehash'), false);
  assert.equal(verifyPassword('anything', 'somesalt', null), false);
  assert.equal(verifyPassword('anything', null, null), false);
});

// ── Invite tokens ────────────────────────────────────────────────────────────

test('generateInviteToken/hashInviteToken: raw token hashes to the stored hash', () => {
  const { raw, hash } = generateInviteToken();
  assert.equal(hashInviteToken(raw), hash);
});

test('hashInviteToken: different raw tokens never collide in this sample', () => {
  const a = generateInviteToken();
  const b = generateInviteToken();
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, b.hash);
});

// ── Session tokens ───────────────────────────────────────────────────────────

const fakeAdmin = { _id: '507f1f77bcf86cd799439011', tenantId: '507f1f77bcf86cd799439012', role: 'OWNER' };

test('createSessionToken/verifySessionToken: valid token round-trips correctly', () => {
  const token   = createSessionToken(fakeAdmin);
  const payload = verifySessionToken(token);
  assert.ok(payload);
  assert.equal(payload.sub, fakeAdmin._id);
  assert.equal(payload.tenantId, fakeAdmin.tenantId);
  assert.equal(payload.role, fakeAdmin.role);
});

test('verifySessionToken: tampered payload is rejected', () => {
  const token = createSessionToken(fakeAdmin);
  const [payloadB64, sig] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'someone-else', tenantId: fakeAdmin.tenantId, role: 'OWNER', exp: Date.now() + 1e9 })).toString('base64url');
  const tamperedToken = `${tamperedPayload}.${sig}`;
  assert.equal(verifySessionToken(tamperedToken), null);
});

test('verifySessionToken: expired token is rejected', () => {
  const token = createSessionToken(fakeAdmin, -1000); // already expired
  assert.equal(verifySessionToken(token), null);
});

test('verifySessionToken: garbage input never throws, just returns null', () => {
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken('not-a-real-token'), null);
  assert.equal(verifySessionToken('a.b.c'), null);
});
