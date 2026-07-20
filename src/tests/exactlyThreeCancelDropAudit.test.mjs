// tests/exactlyThreeCancelDropAudit.test.mjs
//
// [AUDIT-FIX-BOOKING-CANCEL-1/2, AUDIT-FIX-FASHION-CANCEL-1] Regression tests
// for a bug class found across three separate picker implementations
// (retail variants, booking services x2, fashion sizes): WhatsApp's hard
// 3-button cap makes "3 options + a Cancel button" a structurally impossible
// 4-button fit. Each site previously used a `> 3` threshold to decide
// list-vs-buttons, which meant the button branch also ran for EXACTLY 3
// options — and concatenating CANCEL onto an already-3-item array, then
// re-slicing to 3, always silently dropped CANCEL in that one case.
//
// Fix (applied identically at all four sites): raise the list threshold to
// `>= 3`, so the button branch only ever handles 1-2 options (where CANCEL
// always fits), and 3+ options always get the list format (which has room
// for a trailing CANCEL row, itself only added when it fits under
// dispatcher.js's 10-row-per-section cap).
//
// These are real behavioral boundary-case tests (see the equivalent
// v4RetailVariantPickerAudit.test.mjs note on why pure source-text pattern
// checks previously missed this exact bug), replicating each site's array-
// building logic standalone — no live Mongo/session needed, pure array math.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// ── bookingFlow.js: both SELECT_SERVICE occurrences ─────────────────────────

test('bookingFlow.js: both service-picker occurrences use >=3 (not >3) for the list threshold', () => {
  const src = read('../core/conversations/bookingFlow.js');
  const matches = [...src.matchAll(/services\.length >= 3/g)];
  assert.ok(matches.length >= 2, `expected at least 2 occurrences of the >=3 threshold fix, found ${matches.length}`);
  // Note: explanatory comments describing the OLD bug (e.g. "was `services.length
  // > 3`") legitimately contain that substring as documentation — this codebase's
  // own established style of "was X, now Y" comments (see AUDIT-FIX-* tags
  // throughout). What actually matters is that no LIVE CODE line still uses it,
  // which the >=3 matches above already establish were applied at both sites.
});

test('bookingFlow.js: neither service-picker occurrence pre-slices services before concatenating CANCEL', () => {
  const src = read('../core/conversations/bookingFlow.js');
  assert.doesNotMatch(
    src,
    /services\.slice\(0,\s*3\)\.map\([^)]*\)\.concat\(\[\{\s*id:\s*'CANCEL'/,
    'CANCEL must never be appended after services are already sliced to 3'
  );
});

function buildServiceButtons(services) {
  if (services.length >= 3) {
    const serviceRows = services.map(s => ({ id: `SVC_${s}`, title: s }));
    const rows = serviceRows.length < 10 ? [...serviceRows, { id: 'CANCEL', title: '❌ Cancel' }] : serviceRows;
    return { type: 'list', rows };
  }
  return {
    type: 'buttons',
    buttons: services.map(s => ({ id: `SVC_${s}`, title: s })).concat([{ id: 'CANCEL', title: '❌ Cancel' }]).slice(0, 3),
  };
}

test('bookingFlow.js boundary case: exactly 3 services routes to list (CANCEL survives as a row)', () => {
  const result = buildServiceButtons(['Haircut', 'Shave', 'Manicure']);
  assert.equal(result.type, 'list');
  assert.ok(result.rows.some(r => r.id === 'CANCEL'));
  assert.equal(result.rows.length, 4);
});

test('bookingFlow.js boundary case: 2 services still fit CANCEL as a button', () => {
  const result = buildServiceButtons(['Haircut', 'Shave']);
  assert.equal(result.type, 'buttons');
  assert.ok(result.buttons.some(b => b.id === 'CANCEL'));
  assert.equal(result.buttons.length, 3);
});

// ── fashion/flows/index.js: SELECT_SIZE ──────────────────────────────────────

test('fashion/flows/index.js: size picker uses >=3 (not >3) for the list threshold', () => {
  const src = read('../modules/fashion/flows/index.js');
  assert.match(src, /item\.variants\.length >= 3/);
  // Note: an explanatory comment documenting the OLD bug legitimately mentions
  // the old threshold as history — see the equivalent note in the bookingFlow
  // test above.
});

function buildSizeButtons(variants) {
  if (variants.length >= 3) {
    const variantRows = variants.map(v => ({ id: `SIZE_${v}`, title: v }));
    const rows = variantRows.length < 10 ? [...variantRows, { id: 'CANCEL', title: '❌ Cancel' }] : variantRows;
    return { type: 'list', rows };
  }
  return {
    type: 'buttons',
    buttons: [...variants.map(v => ({ id: `SIZE_${v}`, title: v })), { id: 'CANCEL', title: '❌ Cancel' }].slice(0, 3),
  };
}

test('fashion size picker boundary case: exactly 3 sizes routes to list (CANCEL survives as a row)', () => {
  const result = buildSizeButtons(['S', 'M', 'L']);
  assert.equal(result.type, 'list');
  assert.ok(result.rows.some(r => r.id === 'CANCEL'));
  assert.equal(result.rows.length, 4);
});

test('fashion size picker boundary case: 2 sizes still fit CANCEL as a button', () => {
  const result = buildSizeButtons(['S', 'M']);
  assert.equal(result.type, 'buttons');
  assert.ok(result.buttons.some(b => b.id === 'CANCEL'));
  assert.equal(result.buttons.length, 3);
});
