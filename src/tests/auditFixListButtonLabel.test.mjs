// tests/auditFixListButtonLabel.test.mjs
//
// Regression test for [AUDIT-FIX-BTNLABEL].
//
// Bug found in this audit pass: three `type: 'list'` UI builders omitted the
// `button` field entirely:
//
//   - modules/services/flows/index.js  handleEnquiryFlow() INIT branch
//   - modules/services/flows/index.js  _askServiceType()
//   - modules/retail/flows/index.js    _buildCategoryUI()
//
// core/whatsapp/dispatcher.js's list-message builder falls back to a generic
// 'Choose option' label whenever `ui.button` / `ui.buttonLabel` is missing
// (`String(ui.button || ui.buttonLabel || 'Choose option').slice(0, 20)`).
// This is the exact same bug class already fixed once for
// activeOrderResolver.js (see [FIX-AOR-BTNLABEL]) — every customer-facing
// WhatsApp list should show a purpose-specific button label ("Choose
// service", "Choose category"), not the generic fallback.
//
// These three builders are internal (non-exported) functions reached only
// through flow handlers that call updateSession() (a live Mongo write), so —
// consistent with this codebase's existing convention for equivalent
// internal-logic regressions that can't be exercised without a DB connection
// (see v4RetailVariantPickerAudit, v3SalonProductChunkAudit,
// v18FlowSystemAudit) — this is a source-text guard test.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

// Returns the text of the smallest `return { type: 'list', ... };` object
// literal starting at the first `type: 'list'` occurrence at or after
// `fromIndex`, by matching braces.
function getListReturnBlock(src, fromIndex = 0) {
  const idx = src.indexOf(`type: 'list'`, fromIndex);
  assert.ok(idx !== -1, `no "type: 'list'" found from index ${fromIndex}`);
  const braceStart = src.lastIndexOf('{', idx);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { block: src.slice(braceStart, i + 1), idx };
    }
  }
  throw new Error('unbalanced braces while scanning list return block');
}

test('services/flows/index.js handleEnquiryFlow INIT list has an explicit button label', () => {
  const src = read('../modules/services/flows/index.js');
  const { block } = getListReturnBlock(src, src.indexOf('export async function handleEnquiryFlow'));
  assert.match(block, /button:\s*'Choose service'/, 'INIT quote-type list must set an explicit button label, not rely on the dispatcher\'s generic "Choose option" fallback');
});

test('services/flows/index.js _askServiceType list has an explicit button label', () => {
  const src = read('../modules/services/flows/index.js');
  const fnIdx = src.indexOf('function _askServiceType(business)');
  assert.ok(fnIdx !== -1, '_askServiceType not found');
  const { block } = getListReturnBlock(src, fnIdx);
  assert.match(block, /button:\s*'Choose service'/, '_askServiceType list must set an explicit button label');
});

test('retail/flows/index.js _buildCategoryUI list has an explicit button label', () => {
  const src = read('../modules/retail/flows/index.js');
  const fnIdx = src.indexOf('function _buildCategoryUI(categories, business)');
  assert.ok(fnIdx !== -1, '_buildCategoryUI not found');
  const { block } = getListReturnBlock(src, fnIdx);
  assert.match(block, /button:\s*'Choose category'/, '_buildCategoryUI list must set an explicit button label');
});

test('no `type: \'list\'` return block anywhere in the flow modules is missing a button field', () => {
  const files = [
    '../modules/services/flows/index.js',
    '../modules/delivery/flows/index.js',
    '../modules/cosmetics/flows/index.js',
    '../modules/fashion/flows/index.js',
    '../modules/general/flows/index.js',
    '../modules/retail/flows/index.js',
    '../services/activeOrderResolver.js',
    '../core/conversations/moduleRouter.js',
    '../core/conversations/bookingFlow.js',
  ];
  for (const f of files) {
    const src = read(f);
    let from = 0;
    while (true) {
      const idx = src.indexOf(`type: 'list'`, from);
      if (idx === -1) break;
      const { block, idx: usedIdx } = getListReturnBlock(src, idx);
      assert.match(
        block,
        /button:/,
        `${f}: list block at index ${usedIdx} is missing a button field and will fall back to dispatcher.js's generic 'Choose option' label`,
      );
      from = idx + 10;
    }
  }
});
