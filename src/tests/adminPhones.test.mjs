// tests/adminPhones.test.mjs
//
// Regression tests for utils/adminPhones.js ([FEAT-MULTI-ADMIN]).
// Pure functions, no DB — matches the codebase's convention of a dedicated
// test file per audit fix / new feature (see adminAuthService.test.mjs,
// patterns.test.mjs). Covers:
//   (a) parseAdminPhonesInput — separator handling, dedupe, cap at 2, junk
//       rejection
//   (b) applyAdminPhonesUpdate — the {adminPhone, adminPhones} pair written
//       by every controller that accepts the raw dashboard field
//   (c) getAdminPhones / getPrimaryAdminPhone — business-overrides-tenant
//       precedence, and fallback to the legacy scalar field
//   (d) isAdminPhoneMatch — the gate adminCommandService.isAdminPhone() now
//       delegates to, so EITHER configured number can approve/reject/confirm
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseAdminPhonesInput,
  applyAdminPhonesUpdate,
  getAdminPhones,
  getPrimaryAdminPhone,
  isAdminPhoneMatch,
} = await import('../utils/adminPhones.js');

// ── parseAdminPhonesInput ───────────────────────────────────────────────────

test('parseAdminPhonesInput: single number, no separator', () => {
  assert.deepEqual(parseAdminPhonesInput('2203532423'), ['2203532423']);
});

test('parseAdminPhonesInput: comma-separated (recommended UI separator)', () => {
  assert.deepEqual(
    parseAdminPhonesInput('2203532423, 2201112222'),
    ['2203532423', '2201112222'],
  );
});

test('parseAdminPhonesInput: slash-separated', () => {
  assert.deepEqual(
    parseAdminPhonesInput('2203532423 / 2201112222'),
    ['2203532423', '2201112222'],
  );
});

test('parseAdminPhonesInput: semicolon-separated', () => {
  assert.deepEqual(
    parseAdminPhonesInput('2203532423; 2201112222'),
    ['2203532423', '2201112222'],
  );
});

test('parseAdminPhonesInput: a number with internal spaces is NOT split (whitespace is not a separator)', () => {
  assert.deepEqual(parseAdminPhonesInput('220 353 2423'), ['220 353 2423']);
});

test('parseAdminPhonesInput: caps at 2 numbers even if 3+ are supplied', () => {
  assert.deepEqual(
    parseAdminPhonesInput('2201111111, 2202222222, 2203333333'),
    ['2201111111', '2202222222'],
  );
});

test('parseAdminPhonesInput: dedupes the same number in different formats', () => {
  assert.deepEqual(
    parseAdminPhonesInput('+2203532423, 220 353 2423'),
    ['+2203532423'],
  );
});

test('parseAdminPhonesInput: drops junk fragments under 6 digits instead of failing the whole input', () => {
  assert.deepEqual(parseAdminPhonesInput('2203532423, , abc'), ['2203532423']);
});

test('parseAdminPhonesInput: empty/blank input returns []', () => {
  assert.deepEqual(parseAdminPhonesInput(''), []);
  assert.deepEqual(parseAdminPhonesInput('   '), []);
  assert.deepEqual(parseAdminPhonesInput(undefined), []);
  assert.deepEqual(parseAdminPhonesInput(null), []);
});

test('parseAdminPhonesInput: accepts an array input directly', () => {
  assert.deepEqual(parseAdminPhonesInput(['2203532423', '2201112222']), ['2203532423', '2201112222']);
});

// ── applyAdminPhonesUpdate ───────────────────────────────────────────────────

test('applyAdminPhonesUpdate: returns null when field is undefined (not being updated)', () => {
  assert.equal(applyAdminPhonesUpdate(undefined), null);
});

test('applyAdminPhonesUpdate: single number mirrors into adminPhone + adminPhones', () => {
  assert.deepEqual(applyAdminPhonesUpdate('2203532423'), {
    adminPhones: ['2203532423'],
    adminPhone: '2203532423',
  });
});

test('applyAdminPhonesUpdate: two numbers — adminPhone is the first (primary)', () => {
  assert.deepEqual(applyAdminPhonesUpdate('2203532423, 2201112222'), {
    adminPhones: ['2203532423', '2201112222'],
    adminPhone: '2203532423',
  });
});

test('applyAdminPhonesUpdate: clearing the field (empty string) clears both', () => {
  assert.deepEqual(applyAdminPhonesUpdate(''), { adminPhones: [], adminPhone: null });
});

// ── getAdminPhones / getPrimaryAdminPhone ───────────────────────────────────

test('getAdminPhones: business-level adminPhones wins over tenant-level', () => {
  const business = { adminPhones: ['2201111111', '2202222222'] };
  const tenant   = { adminPhones: ['2209999999'] };
  assert.deepEqual(getAdminPhones(business, tenant), ['2201111111', '2202222222']);
});

test('getAdminPhones: falls back to tenant-level when business has none', () => {
  const business = { adminPhones: [] };
  const tenant   = { adminPhones: ['2209999999'] };
  assert.deepEqual(getAdminPhones(business, tenant), ['2209999999']);
});

test('getAdminPhones: falls back to legacy scalar adminPhone when adminPhones is unset (pre-feature documents)', () => {
  const business = { adminPhone: '2201111111' };
  const tenant   = { adminPhone: '2209999999' };
  assert.deepEqual(getAdminPhones(business, tenant), ['2201111111']);
});

test('getAdminPhones: mixed — business has legacy scalar only, tenant has the array', () => {
  const business = { adminPhone: '2201111111' };
  const tenant   = { adminPhones: ['2209999999', '2208888888'] };
  assert.deepEqual(getAdminPhones(business, tenant), ['2201111111']);
});

test('getAdminPhones: nothing configured on either side returns []', () => {
  assert.deepEqual(getAdminPhones({}, {}), []);
  assert.deepEqual(getAdminPhones(null, null), []);
});

test('getPrimaryAdminPhone: first entry of the resolved list', () => {
  const business = { adminPhones: ['2201111111', '2202222222'] };
  assert.equal(getPrimaryAdminPhone(business, null), '2201111111');
});

test('getPrimaryAdminPhone: null when nothing configured', () => {
  assert.equal(getPrimaryAdminPhone({}, {}), null);
});

// ── isAdminPhoneMatch ────────────────────────────────────────────────────────

test('isAdminPhoneMatch: matches the FIRST configured admin number', () => {
  const business = { adminPhones: ['2201111111', '2202222222'] };
  assert.equal(isAdminPhoneMatch('2201111111', business, null), true);
});

test('isAdminPhoneMatch: matches the SECOND configured admin number (both can approve/reject/confirm)', () => {
  const business = { adminPhones: ['2201111111', '2202222222'] };
  assert.equal(isAdminPhoneMatch('2202222222', business, null), true);
});

test('isAdminPhoneMatch: a leading "+" on the sender does not break the match', () => {
  const business = { adminPhones: ['2201111111'] };
  assert.equal(isAdminPhoneMatch('+2201111111', business, null), true);
});

test('isAdminPhoneMatch: an unrelated number is rejected', () => {
  const business = { adminPhones: ['2201111111', '2202222222'] };
  assert.equal(isAdminPhoneMatch('2203333333', business, null), false);
});

test('isAdminPhoneMatch: falls back to tenant-level numbers when business has none configured', () => {
  const tenant = { adminPhones: ['2209999999'] };
  assert.equal(isAdminPhoneMatch('2209999999', null, tenant), true);
});
