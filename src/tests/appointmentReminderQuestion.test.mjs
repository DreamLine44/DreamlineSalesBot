// tests/appointmentReminderQuestion.test.mjs
//
// Pure, additive regression test for the [FIX-REMINDER-Q] fix in
// services/postFlowHandler.js's 'APPOINTMENT_REMINDER' case:
//   isQuestion is computed once at the top of the function (same variable used
//   by ORDER_READY / handleWalkInQueueAck) but the APPOINTMENT_REMINDER case
//   never checked it — CONFIRM / RESCHEDULE / CANCEL_BOOKING / isAck / isComplaint
//   were all handled explicitly, but a genuine typed question ("what should I
//   bring?", "do I need to pay in advance?") fell through to the generic
//   "What would you like to do?" default, silently dropping the question.
//
// This is a source-text guard (not a live-DB test), consistent with how
// patterns.test.mjs / customerIsolation.test.mjs guard other postFlowHandler
// fixes, since this function is not designed for isolated unit import without
// a Mongo connection + AI provider.
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

function appointmentReminderCaseSource() {
  const src = read('../services/postFlowHandler.js');
  const start = src.indexOf(`case 'APPOINTMENT_REMINDER':`);
  assert.ok(start !== -1, `'APPOINTMENT_REMINDER' case not found in postFlowHandler.js`);
  const end = src.indexOf(`case 'WALKIN':`, start);
  assert.ok(end !== -1, `Could not find the end boundary of the APPOINTMENT_REMINDER case`);
  return src.slice(start, end);
}

test('postFlowHandler.js: APPOINTMENT_REMINDER checks isQuestion before falling to the default reminder menu', () => {
  const block = appointmentReminderCaseSource();
  assert.ok(
    /if\s*\(\s*isQuestion\s*\)/.test(block),
    'APPOINTMENT_REMINDER case must check isQuestion — otherwise typed questions are silently dropped'
  );
});

test('postFlowHandler.js: APPOINTMENT_REMINDER answers questions via the AI provider, not a static message', () => {
  const block = appointmentReminderCaseSource();
  const qIdx = block.search(/if\s*\(\s*isQuestion\s*\)/);
  assert.ok(qIdx !== -1);
  const afterQ = block.slice(qIdx, qIdx + 600);
  assert.ok(
    afterQ.includes("await import('../core/ai/providers/aiRouter.js')"),
    'the isQuestion branch should call the AI provider to actually answer the question'
  );
});

test('postFlowHandler.js: APPOINTMENT_REMINDER re-arms postFlowAck after answering a question, so further replies keep working', () => {
  const block = appointmentReminderCaseSource();
  const qIdx = block.search(/if\s*\(\s*isQuestion\s*\)/);
  const afterQ = block.slice(qIdx, qIdx + 900);
  assert.ok(
    /updateSession\(from, tenantId, \{ postFlowAck: 'APPOINTMENT_REMINDER'/.test(afterQ),
    'must re-arm postFlowAck=APPOINTMENT_REMINDER after answering, or the customer only gets one question answered ever ' +
    '(the exact MFQ_RESUME infinite-single-question bug this mirrors — AUDIT-FIX-15)'
  );
});

test('postFlowHandler.js: the isQuestion check for APPOINTMENT_REMINDER comes before the unconditional default fallback', () => {
  const block = appointmentReminderCaseSource();
  const qIdx = block.indexOf(`if (isQuestion) {`);
  const defaultIdx = block.indexOf(`// Default — show options`);
  assert.ok(qIdx !== -1, 'isQuestion branch must exist');
  assert.ok(defaultIdx !== -1, 'default fallback must exist');
  assert.ok(qIdx < defaultIdx, 'isQuestion must be checked before the default fallback runs');
});
