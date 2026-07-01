// tests/patterns.test.mjs
//
// Pure, additive regression tests for core/intents/patterns.js.
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUTTON_ID_MAP, EMOJI_MAP, INTENT_PATTERNS } from '../core/intents/patterns.js';

test('BUTTON_ID_MAP numeric keys are limited to the known top-level quick-reply shortcuts', () => {
  // Regression guard for the bug class noted in project history: retail
  // product list rows using plain numeric string IDs colliding with
  // BUTTON_ID_MAP. Investigation found this codebase already avoids that
  // collision by prefixing list-row IDs elsewhere (e.g. 'SVC_HAIRCUT',
  // 'SIZE_M' in modules/services and modules/fashion). The bare '0'-'3'
  // keys here are an intentional, pre-existing design: numeric quick-reply
  // shortcuts for the top-level menu (1=order, 2=book, 3=question, 0=menu).
  //
  // This test does NOT ban numeric keys outright (that would be a false
  // positive against intentional behaviour). Instead it pins the allowlist,
  // so if a NEW numeric key is added later, a human has to consciously
  // update this test — at which point they should double check no flow
  // generates bare-digit list-row IDs that would now collide with it.
  const ALLOWED_NUMERIC_KEYS = new Set(['0', '1', '2', '3']);
  const numericKeys = Object.keys(BUTTON_ID_MAP).filter(k => /^\d+$/.test(k));
  const unexpected = numericKeys.filter(k => !ALLOWED_NUMERIC_KEYS.has(k));
  assert.deepEqual(
    unexpected,
    [],
    `New numeric BUTTON_ID_MAP key(s) found: ${unexpected.join(', ')}. ` +
    `Verify no list/row ID generator elsewhere produces a bare digit that would now collide.`
  );
});

test('BUTTON_ID_MAP has no duplicate / overwritten keys', () => {
  // JS object literals silently let a later duplicate key win. This re-parses
  // the source text (not the imported object, which can never show the
  // collision) to catch accidental duplicate entries before they ship.
  const url = new URL('../core/intents/patterns.js', import.meta.url);
  const src = fs.readFileSync(url, 'utf8');
  const mapBlock = src.slice(src.indexOf('BUTTON_ID_MAP = {'), src.indexOf('\n};', src.indexOf('BUTTON_ID_MAP = {')));
  const keyMatches = [...mapBlock.matchAll(/^\s*'([^']+)':/gm)].map(m => m[1]);
  const seen = new Set();
  const dupes = [];
  for (const k of keyMatches) {
    if (seen.has(k)) dupes.push(k);
    seen.add(k);
  }
  assert.deepEqual(dupes, [], `Duplicate BUTTON_ID_MAP keys found: ${dupes.join(', ')}`);
});

test('every BUTTON_ID_MAP value is a non-empty string', () => {
  for (const [key, value] of Object.entries(BUTTON_ID_MAP)) {
    assert.equal(typeof value, 'string', `BUTTON_ID_MAP['${key}'] should map to a string`);
    assert.ok(value.length > 0, `BUTTON_ID_MAP['${key}'] is empty`);
  }
});

test('EMOJI_MAP values are raw intents, not action strings', () => {
  // Regression guard for the documented [FIX] where EMOJI_MAP used to leak
  // action-style strings (e.g. START_ORDER) instead of intent strings
  // (e.g. ORDER), which made emoji taps fall through to FALLBACK.
  //
  // This test originally CAUGHT a live instance of exactly this bug:
  // '💈' (barber pole) was mapped to 'START_BOOKING' instead of 'BOOKING'.
  // Since intentToAction() has no 'START_BOOKING' key, every customer who
  // texted just 💈 was silently routed to FALLBACK. Fixed in patterns.js
  // alongside this test (see [FIX-EMOJI-BARBER] comment there).
  for (const [emoji, intent] of Object.entries(EMOJI_MAP)) {
    assert.ok(
      !intent.startsWith('START_'),
      `EMOJI_MAP['${emoji}'] = '${intent}' looks like an action, not an intent`
    );
  }
});

test('INTENT_PATTERNS has no empty keyword lists', () => {
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    assert.ok(Array.isArray(keywords) && keywords.length > 0, `INTENT_PATTERNS['${intent}'] has no keywords`);
  }
});

test('INTENT_PATTERNS keywords are lowercase (normalise() never produces uppercase)', () => {
  // detectIntent() compares against normalise(message), which lowercases
  // input. A keyword with uppercase characters can never match.
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    for (const kw of keywords) {
      assert.equal(kw, kw.toLowerCase(), `INTENT_PATTERNS['${intent}'] keyword '${kw}' is not lowercase and can never match`);
    }
  }
});
