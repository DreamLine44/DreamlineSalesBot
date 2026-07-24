// tests/v3SalonProductChunkAudit.test.mjs
//
// Regression test for the v3 systematic audit.
//
// Bug found and fixed: [AUDIT-FIX-SALON-PRODUCT-CHUNK]
//
// modules/salon/flows/index.js's _buildProductMenu() built its `rows` array from
// the FULL, unsliced product catalog (per its own [AUDIT-FIX-4] comment, meant to
// let dispatcher.js chunk anything past 10 items into multiple list sections) but
// then wrapped that array inside a single `sections: [{ title: ..., rows }]` entry
// instead of returning it as a flat top-level `rows` field.
//
// dispatcher.js's row-chunking logic ([FIX-LIST-TRUNC]) only chunks the FLAT
// `ui.rows` format into ≤10-row sections. When `ui.sections` is already present,
// it trusts the caller to have pre-chunked and simply slices EACH given section to
// 10 rows (see the `ui.sections.map(sec => ({ ..., rows: (sec.rows||[]).slice(0,10)
// ... }))` branch). A single section holding all N products therefore still
// silently dropped everything past the 10th — the exact truncation bug this
// function's own [AUDIT-FIX-4] comment claims to have already fixed. That fix only
// removed the build-time `items.slice(0, 10)`; it never switched the return shape,
// so the fix never actually took effect for salons/barbershops with 11+ products.
//
// This file's own sibling functions (_buildServiceMenu, _buildStylistMenu) use the
// correct flat top-level `rows` format for exactly this reason, as does retail's
// equivalent _buildProductList — confirming the flat-rows format is the
// established, correct convention this function was the sole outlier from.
//
// _buildProductMenu is a private (non-exported) helper, so — consistent with how
// this codebase's existing test suites (v18FlowSystemAudit.test.mjs,
// v19FlowsAudit.test.mjs) already test unexported salon/module-flow internals —
// this is a source-text guard rather than a direct unit-test import.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('salon/flows/index.js: _buildProductMenu returns flat top-level rows, not a single pre-wrapped section', () => {
  const src = read('../modules/salon/flows/index.js');
  const start = src.indexOf('function _buildProductMenu');
  assert.ok(start !== -1, '_buildProductMenu not found');
  const end = src.indexOf('\nexport {', start); // named exports block at end of file
  const body = src.slice(start, end === -1 ? start + 3000 : end);

  const returnStart = body.indexOf('return {', body.indexOf('const rows ='));
  assert.ok(returnStart !== -1, 'return statement not found after rows construction');
  const returnBlock = body.slice(returnStart, returnStart + 500);

  assert.doesNotMatch(
    returnBlock,
    /sections:\s*\[\{/,
    '_buildProductMenu must not wrap the full unsliced rows array inside a single ' +
    'sections entry — dispatcher.js only chunks the flat top-level `rows` format'
  );
  assert.match(
    returnBlock,
    /\brows,/,
    'expected _buildProductMenu to return a flat top-level `rows` field'
  );
});

test('salon/flows/index.js: _buildProductMenu builds rows from the full catalog (no build-time slice)', () => {
  const src = read('../modules/salon/flows/index.js');
  const start = src.indexOf('function _buildProductMenu');
  const end = src.indexOf('\nexport {', start);
  const body = src.slice(start, end === -1 ? start + 3000 : end);

  assert.doesNotMatch(
    body,
    /const rows = items\.slice\(0,\s*10\)/,
    '_buildProductMenu must not pre-truncate the product catalog at build time'
  );
});
