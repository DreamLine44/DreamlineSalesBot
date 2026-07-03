// tests/dispatcherListChunking.test.mjs
//
// Regression test for [FIX-LIST-TRUNC] in core/whatsapp/dispatcher.js.
//
// Bug: any module (restaurant menu, salon services, retail catalog, etc.)
// that builds a WhatsApp list message with a flat `rows` array (the format
// every module in src/modules uses) had that array silently truncated to
// the first 10 items via `.slice(0, 10)`. A business with more than 10
// available menu items would only ever show the first 10 to customers —
// with no error, no log, and no visible sign anything was cut off.
//
// WhatsApp's actual limit is 10 rows PER SECTION, with up to 10 sections
// (100 rows total) — not 10 rows overall. The fix chunks the flat rows
// list into multiple sections instead of dropping everything past #10.
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

test('a flat rows list of 15 items (> 10) is NOT truncated — all 15 rows survive across sections', async () => {
  const ui = { type: 'list', header: 'Menu', body: 'Choose an item:', buttonLabel: 'View Menu', rows: makeRows(15) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  const totalRows = sections.reduce((sum, sec) => sum + sec.rows.length, 0);
  assert.equal(totalRows, 15, 'all 15 rows should be present across sections, none silently dropped');

  // WhatsApp hard cap: no single section may exceed 10 rows.
  for (const sec of sections) {
    assert.ok(sec.rows.length <= 10, 'no section may exceed WhatsApp\'s 10-row-per-section limit');
  }
});

test('a flat rows list of exactly 10 items still produces one section (no behaviour change for the common case)', async () => {
  const ui = { type: 'list', header: 'Menu', body: 'Choose an item:', buttonLabel: 'View Menu', rows: makeRows(10) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  assert.equal(sections.length, 1);
  assert.equal(sections[0].rows.length, 10);
});

test('a flat rows list of 100+ items is capped at the real WhatsApp ceiling (10 sections × 10 rows = 100), not silently truncated at 10', async () => {
  const ui = { type: 'list', header: 'Catalog', body: 'Choose an item:', buttonLabel: 'View', rows: makeRows(120) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  const totalRows = sections.reduce((sum, sec) => sum + sec.rows.length, 0);
  assert.ok(sections.length <= 10, 'no more than 10 sections');
  assert.equal(totalRows, 100, 'capped at the true 100-row ceiling, well past the old 10-row bug');
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
