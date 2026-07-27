// tests/dispatcherListChunking.test.mjs
//
// Regression test for [FIX-LIST-CAP-2] in core/whatsapp/dispatcher.js.
//
// History: [FIX-LIST-TRUNC] originally fixed a hard `.slice(0, 10)` bug that
// silently truncated any flat `rows` list past the first 10 items, on the
// assumption that WhatsApp allows 10 rows PER SECTION with up to 10 sections
// (100 rows total) — chunking overflow into extra sections instead of
// dropping it.
//
// That assumption turned out to be wrong: Meta's Graph API actually enforces
// 10 ROWS TOTAL across ALL sections combined for a single interactive list
// message. Sending more returns a hard 400:
//   (#131009) Parameter value is not valid — "Total row count exceed
//   max allowed count: 10"
// — a real production incident (2026-07-22, YM Store menu). [FIX-LIST-CAP-2]
// replaced the chunk-into-more-sections approach with a hard cap at 10 rows
// total (collected across sections in order), truncating anything past that
// and surfacing a footer hint so the customer knows options were cut off,
// rather than sending a payload Meta will reject outright.
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

test("a flat rows list of 15 items (> 10) is truncated to Meta's real 10-row-total ceiling, with a footer hint", async () => {
  const ui = { type: 'list', header: 'Menu', body: 'Choose an item:', buttonLabel: 'View Menu', rows: makeRows(15) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  const totalRows = sections.reduce((sum, sec) => sum + sec.rows.length, 0);
  assert.equal(totalRows, 10, 'Meta hard-rejects more than 10 total rows in one list message — must be capped, not sent');
  assert.match(
    payload.interactive.footer?.text || '',
    /type what you're looking for/i,
    'a truncated list should surface a footer hint so the customer knows options were cut off',
  );
});

test('a flat rows list of exactly 10 items still produces one section (no behaviour change for the common case)', async () => {
  const ui = { type: 'list', header: 'Menu', body: 'Choose an item:', buttonLabel: 'View Menu', rows: makeRows(10) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  assert.equal(sections.length, 1);
  assert.equal(sections[0].rows.length, 10);
  // Nothing was cut off, so no truncation footer should be injected.
  assert.equal(payload.interactive.footer, undefined);
});

test('a flat rows list of 120 items is still hard-capped at 10 rows total, never the old false ceiling of 100', async () => {
  const ui = { type: 'list', header: 'Catalog', body: 'Choose an item:', buttonLabel: 'View', rows: makeRows(120) };
  const { payload } = await dispatchMessage('1234567890', ui, {});
  const sections = payload.interactive.action.sections;

  const totalRows = sections.reduce((sum, sec) => sum + sec.rows.length, 0);
  assert.equal(totalRows, 10, 'capped at the true Meta ceiling of 10 rows total, regardless of how many items exist');
});

test('the pre-existing multi-section format (e.g. time-of-day pickers) is also capped at 10 rows total across all sections combined', async () => {
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
  const totalRows = sections.reduce((sum, sec) => sum + sec.rows.length, 0);
  assert.equal(totalRows, 6, 'well under the 10-row cap, so both sections pass through unchanged');
});
