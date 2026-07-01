// tests/modes.test.mjs
//
// Pure, additive regression tests for config/modes.js.
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import { getLabel, getModeConfig, getSupportedModes } from '../config/modes.js';

test('getModeConfig falls back to RESTAURANT_CONFIG for an unknown businessMode', () => {
  const cfg = getModeConfig({ businessMode: 'NOT_A_REAL_MODE' });
  assert.ok(cfg, 'expected a fallback config object, got nothing');
});

test('getModeConfig defaults to RETAIL when businessMode is missing', () => {
  // getModeConfig() defaults the *lookup key* to RETAIL when businessMode is
  // absent; MODE_MAP.RETAIL must resolve to something (not undefined),
  // otherwise every business missing this field would silently break.
  const cfg = getModeConfig({});
  assert.ok(cfg, 'expected RETAIL_CONFIG fallback, got nothing');
});

test('getLabel: business.customMessages override wins over module default', () => {
  // Regression test for [FIX-BUG15]: getLabel() must check
  // business.customMessages FIRST. Previously an owner's custom welcome
  // message was saved to the DB but never actually used.
  const business = {
    businessMode: 'RESTAURANT',
    customMessages: { welcomeMessage: 'Custom hello from the owner!' },
  };
  const label = getLabel(business, 'welcome');
  assert.equal(label, 'Custom hello from the owner!');
});

test('getLabel: falls back to module default when no customMessages override exists', () => {
  const business = { businessMode: 'RESTAURANT' };
  const label = getLabel(business, 'welcome');
  assert.notEqual(label, null);
  assert.notEqual(label, undefined);
});

test('getLabel: blank/whitespace-only customMessages override does not shadow the default', () => {
  // tmpl logic is `(customMsg && customMsg.trim()) || cfg.messages?.[key]`.
  // An owner accidentally saving an empty string should not silently
  // replace the real default message with blank text sent to customers.
  const business = { businessMode: 'RESTAURANT', customMessages: { welcomeMessage: '   ' } };
  const label = getLabel(business, 'welcome');
  assert.notEqual(label, '   ');
  assert.notEqual(label, '');
});

test('getLabel: {0}/{1} template substitution works', () => {
  const business = { businessMode: 'RESTAURANT', customMessages: { welcomeMessage: 'Hi {0}, table for {1}?' } };
  const label = getLabel(business, 'welcome', 'Sam', 4);
  assert.equal(label, 'Hi Sam, table for 4?');
});

test('getSupportedModes excludes FOOD/CAFE aliases', () => {
  const modes = getSupportedModes();
  assert.ok(!modes.includes('FOOD'));
  assert.ok(!modes.includes('CAFE'));
  assert.ok(modes.includes('RESTAURANT'));
});
