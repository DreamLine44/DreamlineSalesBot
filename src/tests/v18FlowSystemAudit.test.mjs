// tests/v18FlowSystemAudit.test.mjs
//
// Regression tests for the v18 systematic flows-system audit.
//
// Bugs found and fixed:
//
// [FIX-CAT-LIST-CAP] (electronics) modules/electronics/handlers/uiBuilders.js's
// buildCategoryUI() mapped ALL categories into list rows with no 10-row cap or
// overflow notice, unlike buildProductList() in the same file which already had
// both. A tenant with 11+ categories would silently lose everything past the
// 10th row (dropped by the dispatcher's row-slicing) with no indication to the
// customer that the list was incomplete.
//
// [FIX-SIZE-LIST-CAP] (fashion) modules/fashion/flows/index.js's SELECT_SIZE
// list branch mapped ALL of item.variants with no cap — same class of bug for
// a product configured with 11+ sizes.
//
// [FIX-CAT-LIST-CAP] (retail) modules/retail/flows/index.js's _buildCategoryUI()
// mapped ALL categories AND unconditionally appended a trailing "Browse All"
// row, so 10+ categories could push the total past the 10-row ceiling with no
// cap or overflow notice.
//
// [AUDIT-FIX-SPEC-WARRANTY] services/postFlowHandler.js's ackCtx switch had no
// case for 'SPEC_REQUEST' or 'WARRANTY' — two postFlowAck states set by
// modules/electronics/flows/orderFlow.js's completeFlow() calls — so any
// customer follow-up after an electronics spec or warranty answer fell to the
// generic `default` branch and logged a spurious "Unknown ackCtx" warning for
// an entirely expected, legitimate state.
//
// These are source-text guards, consistent with how the existing
// v13MergeAudit.test.mjs / v14SystematicAudit.test.mjs suites work in this
// codebase (many of these files are not designed for isolated unit import
// without a live Mongo connection and Express app context).
//
// [AUDIT-FIX-6 ADDENDUM] The electronics buildCategoryUI test below was updated
// during a later systematic audit: the original [FIX-CAT-LIST-CAP] cap+notice
// approach it tested for was itself a bug (same class as restaurant's
// [AUDIT-FIX-ROWCAP-REVERT]), since dispatcher.js's [FIX-LIST-TRUNC] already
// chunks a flat rows array without needing a pre-slice. See uiBuilders.js.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('electronics/handlers/uiBuilders.js: buildCategoryUI does NOT cap rows at 10 — dispatcher.js owns list chunking [AUDIT-FIX-6]', () => {
  // Supersedes the original v18 [FIX-CAT-LIST-CAP] expectation below. That fix
  // added a notice for the truncation but not the truncation itself — the
  // underlying pre-slice bug it was meant to catch. Same class of bug as
  // restaurant's [AUDIT-FIX-ROWCAP-REVERT] (v23): dispatcher.js's
  // [FIX-LIST-TRUNC] already chunks a flat `rows` array into valid WhatsApp
  // sections up to the true 100-row ceiling, so pre-slicing here only hides
  // real categories before the dispatcher ever gets a chance to place them.
  const src = read('../modules/electronics/handlers/uiBuilders.js');
  const start = src.indexOf('export function buildCategoryUI');
  assert.ok(start !== -1, 'buildCategoryUI not found');
  const body = src.slice(start, start + 900);
  assert.doesNotMatch(body, /const rows = categories\.slice\(0,\s*10\)/, 'buildCategoryUI must not pre-truncate rows');
  assert.match(body, /categories\.map\(\(cat,\s*i\)\s*=>/, 'expected buildCategoryUI to map rows directly from the full categories array');
});

test('fashion/flows/index.js: SELECT_SIZE list branch does NOT pre-slice variants — dispatcher.js owns list chunking [AUDIT-FIX-FASHION-SIZE]', () => {
  // Supersedes the original v18 [FIX-SIZE-LIST-CAP] expectation below. That
  // fix capped variants at 10 with an overflow notice but, same bug class as
  // electronics' [AUDIT-FIX-6] and restaurant's [AUDIT-FIX-ROWCAP-REVERT],
  // pre-slicing here silently dropped every size past the 10th before
  // dispatcher.js's [FIX-LIST-TRUNC] ever got a chance to chunk them. The fix
  // now builds a flat `rows` array from the full variant set instead.
  const src = read('../modules/fashion/flows/index.js');
  const marker = 'item.variants.length > 3';
  const idx = src.indexOf(marker);
  assert.ok(idx !== -1, 'SELECT_SIZE variant-list branch not found');
  const body = src.slice(idx, idx + 900);
  assert.doesNotMatch(body, /item\.variants\.slice\(0,\s*10\)/, 'SELECT_SIZE must not pre-truncate variants');
  assert.match(body, /item\.variants\.map\(v\s*=>/, 'expected SELECT_SIZE to map rows directly from the full variants array');
});

test('retail/flows/index.js: _buildCategoryUI caps categories at 9 (plus the appended Browse All row) with an overflow notice', () => {
  const src = read('../modules/retail/flows/index.js');
  const start = src.indexOf('function _buildCategoryUI');
  assert.ok(start !== -1, '_buildCategoryUI not found');
  const body = src.slice(start, start + 900);
  assert.match(body, /categories\.slice\(0,\s*9\)/, 'expected a 9-row slice cap (10th row reserved for Browse All)');
  assert.match(body, /categories\.length > 9/, 'expected an overflow-length check');
});

test('postFlowHandler.js: has dedicated SPEC_REQUEST and WARRANTY ackCtx cases (not falling to default)', () => {
  const src = read('../services/shared/postFlowHandler.js');
  assert.match(src, /case 'SPEC_REQUEST':\s*{/, 'expected a dedicated SPEC_REQUEST case');
  assert.match(src, /case 'WARRANTY':\s*{/, 'expected a dedicated WARRANTY case');
});

test('postFlowHandler.js: SPEC_REQUEST and WARRANTY cases appear before the default branch in switch order', () => {
  const src = read('../services/shared/postFlowHandler.js');
  const specIdx    = src.indexOf("case 'SPEC_REQUEST':");
  const warrantyIdx = src.indexOf("case 'WARRANTY':");
  const defaultIdx  = src.indexOf('default: {');
  assert.ok(specIdx > -1 && warrantyIdx > -1 && defaultIdx > -1);
  assert.ok(specIdx < defaultIdx, 'SPEC_REQUEST case must precede default');
  assert.ok(warrantyIdx < defaultIdx, 'WARRANTY case must precede default');
});
