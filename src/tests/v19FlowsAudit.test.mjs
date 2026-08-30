// tests/v19FlowsAudit.test.mjs
//
// Regression tests for the v19 systematic flows-system audit.
//
// Bug found and fixed: [AUDIT-FLOWS-RESCHEDULE]
//
// patterns.js's BUTTON_ID_MAP mapped the 'RESCHEDULE' button ID straight to the
// generic 'START_BOOKING' action. That action (handled at the bottom of
// moduleRouter.js's route()) just calls flowEngine.startFlow({ flowName: 'BOOKING' }),
// which resets the session and begins a brand-new booking WITHOUT ever touching the
// customer's existing pending/confirmed appointment.
//
// The "📅 Reschedule" button is shown to a customer with an active booking from the
// greeting-gate screen (moduleRouter.js's GREET case, for SALON/BARBERSHOP). Tapping
// it therefore left the OLD booking live in the database and created a second,
// unrelated booking from the fresh flow — silently duplicating the appointment (and
// the admin confirm/decline alert), rather than actually rescheduling anything.
//
// This directly contradicted the documented behavior in modules/salon/flows/index.js
// ([v14-RESCHEDULE]: "Bot looks up their most recent confirmed appointment and starts
// a new BOOKING flow while cancelling the old one atomically") and the already-correct
// implementation for the SAME button in services/postFlowHandler.js's postFlowAck-context
// RESCHEDULE handling, which does cancel the old booking before restarting.
//
// Fix: BUTTON_ID_MAP now routes 'RESCHEDULE' to its own 'RESCHEDULE' action, and
// moduleRouter.js implements a case 'RESCHEDULE' that mirrors postFlowHandler.js's
// existing logic — cancel the most recent active, non-walk-in booking, then land the
// customer on step 'DATE' with the previous service/stylist carried over.
//
// These are source-text guards, consistent with how the existing
// v13MergeAudit.test.mjs / v14SystematicAudit.test.mjs suites work in this codebase,
// since moduleRouter.js is not designed for isolated unit import without a live
// Mongo connection and Express app context.
//
// Does NOT modify any existing source file (other than the audited fix itself).
//
// Run with:  node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('patterns.js: RESCHEDULE button ID no longer aliases straight to START_BOOKING', () => {
  const src = read('../core/intents/patterns.js');
  const match = src.match(/'RESCHEDULE':\s*'([A-Z_]+)'/);
  assert.ok(match, "Expected to find a BUTTON_ID_MAP entry for 'RESCHEDULE'");
  assert.notEqual(
    match[1], 'START_BOOKING',
    "RESCHEDULE must not map directly to START_BOOKING — that resets the session " +
    "and starts a fresh booking without cancelling the customer's existing appointment."
  );
  assert.equal(match[1], 'RESCHEDULE', "RESCHEDULE should route to its own dedicated action");
});

test('moduleRouter.js: has a dedicated RESCHEDULE case that cancels the previous booking', () => {
  const src = read('../core/conversations/moduleRouter.js');
  const idx = src.indexOf("case 'RESCHEDULE'");
  assert.ok(idx !== -1, "Expected a case 'RESCHEDULE' block in moduleRouter.js");

  const block = src.slice(idx, idx + 2200);

  assert.match(
    block, /status:\s*\{\s*\$in:\s*\[\s*'pending',\s*'confirmed'\s*\]\s*\}/,
    'RESCHEDULE case should look up the pending/confirmed booking to cancel'
  );
  assert.match(
    block, /\$set:\s*\{\s*status:\s*'cancelled'/,
    'RESCHEDULE case should cancel the previous booking before starting a new one'
  );
  assert.match(
    block, /bookingType:\s*\{\s*\$ne:\s*'walkin'\s*\}/,
    'RESCHEDULE case should only ever target a real appointment, never a walk-in queue entry'
  );
  assert.match(
    block, /step:\s*'DATE'/,
    "RESCHEDULE case should land the customer on step 'DATE', consistent with the " +
    'postFlowHandler.js RESCHEDULE handlers'
  );
  assert.doesNotMatch(
    block, /data:\s*\{\s*\}/,
    'RESCHEDULE case should carry the previous service/stylist through, not wipe data to {}'
  );
});
