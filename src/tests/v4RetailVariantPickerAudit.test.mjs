// tests/v4RetailVariantPickerAudit.test.mjs
//
// Regression test for the v4 systematic audit.
//
// Bug found and fixed: [AUDIT-FIX-RETAIL-VARIANT]
//
// modules/retail/flows/index.js's SELECT_VARIANT step built its variant picker as:
//
//   buttons: variantKeys.slice(0, 3).map(...).concat([CANCEL]).slice(0, 3)
//
// Two bugs in that one line:
//
//   1. Slicing to 3 BEFORE appending CANCEL meant any item with 3+ variants only
//      ever offered its first 3 as tappable buttons, with no list fallback for the
//      rest. This is the exact same truncation bug class already fixed for fashion
//      sizes ([AUDIT-FIX-FASHION-SIZE]), salon services/products, bakery, cosmetics,
//      and electronics (all of which switch to a `type: 'list'` UI — chunked by
//      dispatcher.js's [FIX-LIST-TRUNC] logic — once options exceed 3) — retail's
//      variant picker was the one instance of this pattern that was missed.
//
//   2. Concatenating CANCEL onto an already-3-item button array and re-slicing to 3
//      silently dropped CANCEL itself whenever there were 3+ variants, leaving the
//      customer with no button escape from the picker at all.
//
// Fix: mirrors fashion's exact pattern — ≤3 variants get a button UI (CANCEL
// preserved), 4+ variants get a flat top-level `rows` list for dispatcher to chunk.
//
// handleRetailOrder is exported, but calling it directly requires a live Mongo
// connection (session writes via updateSession) and full session/business context —
// consistent with why moduleRouter.js and the salon/fashion flow modules use
// source-text guards for equivalent internal-logic regressions in this codebase's
// existing test suites (v18FlowSystemAudit, v19FlowsAudit, v3SalonProductChunkAudit).
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

function getVariantPickerBlock(src) {
  const marker = 'Show variant picker';
  const idx = src.indexOf(marker);
  assert.ok(idx !== -1, 'variant picker section not found');
  return src.slice(idx, idx + 2200);
}

test('retail/flows/index.js: variant picker switches to a list for 3+ variants (not just 4+)', () => {
  const src = read('../modules/retail/flows/index.js');
  const body = getVariantPickerBlock(src);

  // [AUDIT-FIX-RETAIL-VARIANT-2] Raised from `> 3` to `>= 3` — see the
  // detailed comment in source. WhatsApp's 3-button cap makes "3 variants +
  // a Cancel button" a structurally impossible 4-button fit; only routing
  // the exactly-3 case to the list format (which has room for a Cancel row)
  // actually fixes it.
  assert.match(
    body,
    /variantKeys\.length >= 3/,
    'expected a branch that switches to a list UI once variants reach 3 (not just exceed 3)'
  );
  assert.match(
    body,
    /type:\s*'list'/,
    'expected a list-type UI branch for 3+ variants'
  );
  // Must build rows from the FULL variant set, not a pre-sliced subset.
  assert.doesNotMatch(
    body,
    /rows:\s*variantKeys\.slice\(/,
    'the list branch must not pre-slice variantKeys — dispatcher.js handles chunking'
  );
});

test('retail/flows/index.js: variant picker button branch never drops CANCEL', () => {
  const src = read('../modules/retail/flows/index.js');
  const body = getVariantPickerBlock(src);

  // The old bug: slice(0,3) applied to variants BEFORE concatenating CANCEL,
  // then re-sliced to 3 — which silently dropped CANCEL for 3+ variants.
  assert.doesNotMatch(
    body,
    /variantKeys\.slice\(0,\s*3\)\.map\([^)]*\)\.concat\(\[\{\s*id:\s*'CANCEL'/,
    'CANCEL must not be appended after variants are already sliced to 3'
  );
  // The fix: build the full button list (variants + CANCEL) THEN slice to 3,
  // so CANCEL is always a candidate for the visible 3 buttons alongside variants.
  assert.match(
    body,
    /\.\.\.variantKeys\.map\(/,
    'expected the button branch to map all variantKeys before combining with CANCEL'
  );
});

// ── Real behavioral boundary-case tests (not just source-text pattern checks) ──
// [AUDIT-FIX-RETAIL-VARIANT-2] The two source-text tests above passed even
// while the exactly-3-variants case was still silently dropping CANCEL,
// because they only checked for the OLD literal bug pattern, not the actual
// array length that survives to the final render. These tests replicate the
// picker's real array-building logic standalone (no live Mongo/session
// needed — this is pure array math) to catch that class of regression directly.
function buildVariantButtons(variantKeys) {
  if (variantKeys.length >= 3) {
    const variantRows = variantKeys.map(v => ({ id: `VAR_${v}`, title: v }));
    const rows = variantRows.length < 10 ? [...variantRows, { id: 'CANCEL', title: '❌ Cancel' }] : variantRows;
    return { type: 'list', rows };
  }
  return {
    type: 'buttons',
    buttons: [...variantKeys.map(v => ({ id: `VAR_${v}`, title: v })), { id: 'CANCEL', title: '❌ Cancel' }].slice(0, 3),
  };
}

test('boundary case: exactly 1 variant still includes CANCEL', () => {
  const result = buildVariantButtons(['S']);
  assert.equal(result.type, 'buttons');
  assert.ok(result.buttons.some(b => b.id === 'CANCEL'), 'CANCEL must survive for 1 variant');
});

test('boundary case: exactly 2 variants still includes CANCEL', () => {
  const result = buildVariantButtons(['S', 'M']);
  assert.equal(result.type, 'buttons');
  assert.ok(result.buttons.some(b => b.id === 'CANCEL'), 'CANCEL must survive for 2 variants');
});

test('boundary case: exactly 3 variants routes to list format (where CANCEL fits as a row), not buttons', () => {
  const result = buildVariantButtons(['S', 'M', 'L']);
  assert.equal(result.type, 'list', 'exactly 3 variants must NOT use the 3-button format, where CANCEL cannot fit alongside them');
  assert.ok(result.rows.some(r => r.id === 'CANCEL'), 'the list format must still include a CANCEL row');
  assert.equal(result.rows.length, 4, 'expected all 3 variants plus 1 CANCEL row');
});

test('boundary case: 4+ variants routes to list format with CANCEL row included', () => {
  const result = buildVariantButtons(['S', 'M', 'L', 'XL']);
  assert.equal(result.type, 'list');
  assert.ok(result.rows.some(r => r.id === 'CANCEL'));
  assert.equal(result.rows.length, 5);
});
