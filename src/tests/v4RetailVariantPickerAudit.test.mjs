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

test('retail/flows/index.js: variant picker switches to a list for 4+ variants', () => {
  const src = read('../modules/retail/flows/index.js');
  const body = getVariantPickerBlock(src);

  assert.match(
    body,
    /variantKeys\.length > 3/,
    'expected a branch that switches to a list UI once variants exceed 3'
  );
  assert.match(
    body,
    /type:\s*'list'/,
    'expected a list-type UI branch for 4+ variants'
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
