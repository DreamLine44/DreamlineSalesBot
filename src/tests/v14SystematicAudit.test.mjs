// tests/v14SystematicAudit.test.mjs
//
// Pure, additive regression tests for the v14 systematic audit pass across
// critical files (controllers, core, services, modules, models).
//
// Bug found and fixed: [AUDIT-FIX-15b] RESCHEDULE step/prompt mismatch.
//
// Both RESCHEDULE handlers in services/postFlowHandler.js (APPOINTMENT_REMINDER
// context and BOOKING_CONFIRMED/WALKIN_CONFIRMED context) sent the customer a
// message asking "What date works best for you?" while simultaneously setting
// session.step to 'SELECT_SERVICE' (which expects a service NAME as the next
// reply, not a date) and wiping session.data to {} (losing the original
// service/stylist entirely). The result: a customer replying with a real date
// ("tomorrow", "25 June") had their message routed into service-name matching,
// which always failed, silently re-showing the service picker instead of
// accepting their date — the reschedule flow never actually reached the DATE
// step it claimed to be asking for.
//
// Fix: land on step: 'DATE' (which core/conversations/bookingFlow.js's shared
// DATE step genuinely accepts free-text dates for) with data pre-populated
// from the customer's existing service/stylist (flowData.service / flowData.staff),
// matching the identical step:'DATE' + pre-populated-data pattern already used
// elsewhere in modules/salon/flows/index.js's handleSalonBooking when skipping
// straight to date selection after SELECT_SERVICE/SELECT_STYLIST.
//
// These are source-text guards, consistent with how the existing
// v13MergeAudit.test.mjs / customerIsolation.test.mjs suites work in this
// codebase, since postFlowHandler.js is not designed for isolated unit import
// without a live Mongo connection and Express app context.
//
// Does NOT modify any existing source file.
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

function extractRescheduleBlocks(src) {
  const blocks = [];
  const marker = "upper === 'RESCHEDULE'";
  let idx = 0;
  while (true) {
    idx = src.indexOf(marker, idx);
    if (idx === -1) break;
    const raw = src.slice(idx, idx + 1600);
    // Strip // line comments so explanatory prose (which necessarily quotes the
    // old buggy pattern, e.g. "Was setting step: 'SELECT_SERVICE' with data: {}")
    // doesn't produce false-positive/false-negative matches against the actual code.
    const codeOnly = raw
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n');
    blocks.push(codeOnly);
    idx += marker.length;
  }
  return blocks;
}

test('postFlowHandler.js: has exactly two RESCHEDULE handlers (APPOINTMENT_REMINDER + BOOKING_CONFIRMED/WALKIN_CONFIRMED)', () => {
  const src = read('../services/postFlowHandler.js');
  const blocks = extractRescheduleBlocks(src);
  assert.equal(blocks.length, 2, `Expected 2 RESCHEDULE handlers, found ${blocks.length}`);
});

test('postFlowHandler.js: RESCHEDULE never sets step to SELECT_SERVICE while asking for a date', () => {
  const src = read('../services/postFlowHandler.js');
  const blocks = extractRescheduleBlocks(src);
  assert.ok(blocks.length > 0, 'No RESCHEDULE handler found');
  for (const block of blocks) {
    assert.ok(
      !/step:\s*'SELECT_SERVICE'/.test(block),
      "RESCHEDULE handler must not set step: 'SELECT_SERVICE'"
    );
    assert.ok(
      /buildRescheduleDatePicker/.test(block) || /step:\s*'DATE'/.test(block),
      "RESCHEDULE handler should open the shared DATE picker via buildRescheduleDatePicker"
    );
  }
});

test('postFlowHandler.js: RESCHEDULE preserves the existing service/stylist instead of wiping data', () => {
  const src = read('../services/postFlowHandler.js');
  const blocks = extractRescheduleBlocks(src);
  for (const block of blocks) {
    assert.ok(
      !/data:\s*\{\s*\}/.test(block),
      'RESCHEDULE handler must not reset data to {}'
    );
    assert.ok(
      block.includes('resumeData: flowData') ||
      block.includes('flowData?.service') ||
      block.includes('flowData.service'),
      'RESCHEDULE handler should carry the previous service through from flowData'
    );
    assert.ok(
      block.includes('resumeData:') ||
      block.includes('flowData?.staff') ||
      block.includes('flowData.staff'),
      'RESCHEDULE handler should carry the previous stylist/staff through from flowData'
    );
  }
});

test('core/conversations/bookingFlow.js: DATE step genuinely accepts free-text dates (sanity check for the fix\'s premise)', () => {
  const src = read('../core/conversations/bookingFlow.js');
  const dateStepMatch = src.match(/case 'DATE': \{[\s\S]{0,4000}/);
  assert.ok(dateStepMatch, 'DATE case not found in bookingFlow.js');
  assert.ok(
    dateStepMatch[0].includes('resolveBookingDateInput'),
    'DATE step should parse and validate free-text date input — confirms landing a ' +
    'customer directly on this step after RESCHEDULE is the correct fix.'
  );
});

test('modules/salon/flows/index.js: handleSalonBooking treats DATE as a shared step (consistency check)', () => {
  const src = read('../modules/salon/flows/index.js');
  assert.ok(
    /BOOKING_SHARED_STEPS = new Set\(\[[^\]]*'DATE'/.test(src),
    "handleSalonBooking must delegate step 'DATE' to the shared handleBookingFlow — " +
    "otherwise landing a rescheduling customer on step:'DATE' would not be routed " +
    "correctly on their next message."
  );
});
