// tests/v23RestaurantFlowAudit.test.mjs
//
// Regression test for the v23 systematic audit of the restaurant flow systems.
//
// Bug found, then a self-caught false fix, then corrected:
//
// [AUDIT-FIX-ROWCAP-REVERT] An earlier pass of this audit added a slice(0, 10)
// cap + "Showing X of Y" footer to buildMenuUI(), copying a pattern seen in
// bakery/cosmetics/retail/salon/electronics/services. That was WRONG:
// core/whatsapp/dispatcher.js already has its own [FIX-LIST-TRUNC] that takes
// a flat `rows` array from any module and chunks it into up to 10 sections ×
// 10 rows (100 rows total) rather than truncating at 10. Capping in
// buildMenuUI threw away rows 11+ before dispatchMessage() ever got a chance
// to place them into a second section — actively defeating the dispatcher's
// fix and hiding real menu items behind a misleading "Showing 10 of 15"
// message. The correct fix is to NOT cap here at all and let the dispatcher
// handle sectioning, which is what this test locks in.
//
// This is a source-text guard, consistent with how v18FlowSystemAudit.test.mjs /
// v19FlowsAudit.test.mjs / v22RestaurantFlowAudit.test.mjs already verify this
// codebase's fixes without needing a live Mongo connection. The dispatcher's
// own chunking behaviour is separately covered end-to-end by
// dispatcherListChunking.test.mjs.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('restaurant/handlers/uiBuilders.js: buildMenuUI does NOT cap rows at 10 — dispatcher.js owns list chunking', () => {
  const src = read('../modules/restaurant/handlers/uiBuilders.js');
  const start = src.indexOf('export function buildMenuUI');
  assert.ok(start !== -1, 'buildMenuUI not found');
  const body = src.slice(start, start + 1400);

  assert.doesNotMatch(
    body,
    /\.slice\(0,\s*10\)/,
    'buildMenuUI must not pre-truncate rows — dispatcher.js\'s [FIX-LIST-TRUNC] already chunks flat rows arrays into valid WhatsApp sections up to the true 100-row ceiling; truncating here would hide real items before the dispatcher ever sees them'
  );
  assert.match(
    body,
    /items\.map\(\(item,\s*i\)\s*=>/,
    'expected buildMenuUI to map rows directly from the full filtered items array'
  );
});

test('restaurant/flows/orderFlow.js: SELECT_ITEM numeric index resolves against the same unsliced, filtered menu order buildMenuUI\'s rows are drawn from', () => {
  const orderFlowSrc = read('../modules/restaurant/flows/orderFlow.js');
  assert.match(
    orderFlowSrc,
    /const menu\s*=\s*\(business\?\.menuItems\s*\|\|\s*\[\]\)\.filter\(i => i\.available !== false\)/,
    'expected orderFlow.js to keep resolving the full filtered menu (not capped) for numeric-index selection'
  );
});
