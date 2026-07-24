// tests/dispatcherListChunking.test.mjs
//
// Regression test for [FIX-LIST-TRUNC] / [FIX-LIST-CAP-2] in
// core/whatsapp/dispatcher.js.
//
// Bug: any module (restaurant menu, salon services, retail catalog, etc.)
// that builds a WhatsApp list message with a flat `rows` array (the format
// every module in src/modules uses) had that array silently truncated to
// the first 10 items via `.slice(0, 10)`. A business with more than 10
// available menu items would only ever show the first 10 to customers —
// with no error, no log, and no visible sign anything was cut off.
//
// [FIX-LIST-TRUNC] originally assumed WhatsApp allows 10 rows PER SECTION
// with up to 10 sections (100 rows total), and chunked accordingly.
// [FIX-LIST-CAP-2] corrected that assumption after a real production 400
// (2026-07-22, YM Store menu): Meta's actual limit is 10 ROWS TOTAL across
// ALL sections combined for a single interactive list message, not 100.
// Anything beyond row 10 is now dropped from the payload (never sent — a
// truncated list beats a rejected message) with a footer hint surfaced to
// the customer so they know to narrow their search.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIMULATION_MODE = 'true'; // dispatchMessage short-circuits before any network call

const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');

function makeRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    id:    String(i + 1),
    title: `Item ${i + 1}`,
    description: `D${(i + 1) * 10}`,
  }));
}

test('a flat rows list of 15 items (> 10) is capped at 10 total, with a footer hint that more exist', async () => {
  const ui = { type: 'list', header: 'Menu', body: 'Choose an item:', buttonLabel: 'View Menu', rows: makeRows(15) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  const totalRows = sections.reduce((sum, sec) => sum + sec.rows.length, 0);
  assert.equal(totalRows, 10, 'WhatsApp\'s real limit is 10 rows total — anything past #10 is dropped, not chunked');
  assert.match(payload.interactive.footer.text, /Showing 10 items/);
});

test('a flat rows list of exactly 10 items still produces one section (no behaviour change for the common case)', async () => {
  const ui = { type: 'list', header: 'Menu', body: 'Choose an item:', buttonLabel: 'View Menu', rows: makeRows(10) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  assert.equal(sections.length, 1);
  assert.equal(sections[0].rows.length, 10);
});

test('a flat rows list of 120 items is still capped at the real WhatsApp ceiling of 10 rows total', async () => {
  const ui = { type: 'list', header: 'Catalog', body: 'Choose an item:', buttonLabel: 'View', rows: makeRows(120) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  const totalRows = sections.reduce((sum, sec) => sum + sec.rows.length, 0);
  assert.equal(sections.length, 1, 'flat rows collapse into a single section once capped at 10');
  assert.equal(totalRows, 10, 'capped at the true 10-row ceiling — 120 items must not produce a 400 from Meta');
});

test('the pre-existing multi-section format (e.g. time-of-day pickers) is unaffected by the fix', async () => {
  const ui = {
    type: 'list', header: 'Pick a time', body: 'Choose a slot:', buttonLabel: 'Choose',
    sections: [
      { title: 'Morning',   rows: makeRows(3) },
      { title: 'Afternoon', rows: makeRows(3) },
    ],
  };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'Morning');
  assert.equal(sections[1].title, 'Afternoon');
});
