// tests/parseIntIndexCorruption.test.mjs
//
// Regression tests for the parseInt() index-corruption bug found across 9
// flow files during the systematic audit.
//
// ROOT CAUSE: parseInt("2 red shirts", 10) returns 2, NOT NaN. Every one of
// these files computed `const numIdx = parseInt(raw, 10) - 1;` and then
// trusted it as a menu/service array index whenever it wasn't NaN — so any
// customer message that merely STARTED with a digit ("2 red shirts", "3 large
// pizzas", "2 haircuts please") silently resolved to menu[numIdx] instead of
// ever reaching findBestMatch()/name-matching. The customer would silently
// get the WRONG item with no error, no "did you mean?", nothing.
//
// The existing `!isInteractive && !session.menuViewed` guard (present in most
// of these files) does NOT fix this: it only gates the case where a customer
// types a bare number BEFORE ever seeing the menu. Once menuViewed is true —
// the normal case, since the menu is shown before the customer replies — the
// guard no longer applies, and "2 red shirts" still hijacks the array index.
//
// FIX: only trust the parsed numeric index when the raw input is a BARE
// number (`/^\d+$/.test(raw.trim())`) or came from an interactive tap
// (list row / button — isInteractive). Mixed alphanumeric input now always
// falls through to fuzzy name matching, same as any other free-text reply.
//
// These are source-text guards (consistent with v18FlowSystemAudit.test.mjs /
// v22RestaurantFlowAudit.test.mjs in this suite) since these handlers pull in
// live sessionService/Mongoose calls not safe to exercise without a real DB.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// Pure logic proof, independent of any source file: this is exactly the bug.
test('sanity check: parseInt() does not reject digit-prefixed mixed input (proves the bug class is real)', () => {
  assert.equal(parseInt('2 red shirts', 10), 2, 'parseInt silently parses the leading digit');
  assert.ok(!Number.isNaN(parseInt('2 red shirts', 10)));
  // The fix's actual gate:
  assert.equal(/^\d+$/.test('2 red shirts'.trim()), false, 'mixed input must fail the pure-numeric test');
  assert.equal(/^\d+$/.test('2'.trim()), true, 'a bare number must still pass the pure-numeric test');
});

const FILES = [
  { path: '../modules/bakery/flows/orderFlow.js',      label: 'bakery' },
  { path: '../modules/electronics/flows/orderFlow.js', label: 'electronics' },
  { path: '../modules/delivery/flows/index.js',        label: 'delivery' },
  { path: '../modules/salon/flows/index.js',           label: 'salon' },
  { path: '../modules/cosmetics/flows/orderFlow.js',   label: 'cosmetics' },
  { path: '../modules/fashion/flows/index.js',         label: 'fashion' },
  { path: '../modules/retail/flows/index.js',          label: 'retail' },
];

for (const { path, label } of FILES) {
  test(`${label}/flows: SELECT_ITEM guards the parsed numeric index on isPureNumeric/isInteractive, not just menuViewed`, () => {
    const src = read(path);
    const idx = src.indexOf('AUDIT-FIX-PARSEINT');
    assert.ok(idx !== -1, `${label}: expected an AUDIT-FIX-PARSEINT marker`);
    const window = src.slice(idx, idx + 700);

    assert.match(window, /isPureNumeric\s*=\s*\/\^\\d\+\$\/\.test\(raw\.trim\(\)\)/,
      `${label}: expected isPureNumeric = /^\\d+$/.test(raw.trim())`);
    assert.match(window, /\(isInteractive \|\| isPureNumeric\)/,
      `${label}: expected the item resolution to require (isInteractive || isPureNumeric)`);
  });
}

test('restaurant/flows/orderFlow.js: SELECT_ITEM only computes a parseInt-based index when raw is pure-numeric', () => {
  const src = read('../modules/restaurant/flows/orderFlow.js');
  const idx = src.indexOf('AUDIT-FIX-PARSEINT-6');
  assert.ok(idx !== -1, 'expected AUDIT-FIX-PARSEINT-6 marker');
  const window = src.slice(idx, idx + 1100);

  assert.match(window, /isPureNumeric\s*=\s*\/\^\\d\+\$\/\.test\(raw\.trim\(\)\)/,
    'expected isPureNumeric = /^\\d+$/.test(raw.trim())');
  // The WORD_NUMS lookup is exact-match-only and safe; only the parseInt fallback
  // needed gating so it never fires on mixed alphanumeric input.
  assert.match(window, /WORD_NUMS\[clean\]\s*\?\?\s*\(isPureNumeric \? parseInt\(raw, 10\) - 1 : NaN\)/,
    'expected the parseInt fallback to be gated behind isPureNumeric, else NaN');
});

test('core/conversations/bookingFlow.js: SELECT_SERVICE only computes a numeric index when raw is pure-numeric', () => {
  const src = read('../core/conversations/bookingFlow.js');
  const idx = src.indexOf('AUDIT-FIX-PARSEINT-9');
  assert.ok(idx !== -1, 'expected AUDIT-FIX-PARSEINT-9 marker');
  const window = src.slice(idx, idx + 700);

  assert.match(window, /isPureNumeric\s*=\s*\/\^\\d\+\$\/\.test\(raw\.trim\(\)\)/,
    'expected isPureNumeric = /^\\d+$/.test(raw.trim())');
  assert.match(window, /const idx = isPureNumeric \? parseInt\(raw, 10\) - 1 : NaN;/,
    'expected idx computation to be gated behind isPureNumeric, else NaN');
});
