import { test } from 'node:test';
import assert from 'node:assert/strict';
import Session from '../models/Session.js';
import { createSession } from '../core/sessions/sessionService.js';

// [FIX-SES-9] regression: createSession() upserts onto the SAME document
// (matched by the phone+tenantId composite key) when a session is re-created
// after TTL expiry — it does NOT delete the old expired doc first. Mongo's
// $set only touches the fields it lists, so any field createSession's $set
// omits silently survives from the expired session into the "new" one.
//
// postFlowAck/postFlowData were previously omitted from that $set block.
// webhookController's step-14 postFlowAck state machine reads
// `session.postFlowAck` directly off the freshly (re)created session, so a
// customer starting a brand-new conversation days later could have their
// first message misrouted through handlePostFlowMessage using postFlowData
// that references a long-gone order/shortId.
//
// We stub the Mongoose Model static directly — this environment has no Mongo
// instance available, and createSession is a pure findOneAndUpdate call with
// no schema/validation logic to lose by stubbing.

function withStubbedSession(run) {
  const original = Session.findOneAndUpdate;
  let setPatchPassedToUpdate = null;
  let setOnInsertPatchPassedToUpdate = null;

  Session.findOneAndUpdate = (filter, update) => {
    setPatchPassedToUpdate = update.$set;
    setOnInsertPatchPassedToUpdate = update.$setOnInsert;
    return Promise.resolve({ ...filter, ...update.$set, ...update.$setOnInsert });
  };

  return run({
    getSetPatch: () => setPatchPassedToUpdate,
    getSetOnInsertPatch: () => setOnInsertPatchPassedToUpdate,
  }).finally(() => {
    Session.findOneAndUpdate = original;
  });
}

test('createSession: resets postFlowAck and postFlowData to null on every call', async () => {
  await withStubbedSession(async ({ getSetPatch }) => {
    await createSession('2207000000', 'tenant123', { phoneNumberId: 'pnid1' });
    const patch = getSetPatch();
    assert.equal(patch.postFlowAck, null, 'postFlowAck must be explicitly reset to null');
    assert.equal(patch.postFlowData, null, 'postFlowData must be explicitly reset to null');
  });
});

test('createSession: resets postFlowAck/postFlowData even when restoring humanMode from an expired session', async () => {
  // This is the exact real-world path: webhookController's TTL-restore branch
  // calls createSession with humanMode:true when an expired session had an
  // active human handoff. That expired doc may also have had a stale
  // postFlowAck='ORDER_CONFIRMED' from before the handoff — it must not leak
  // into the freshly (re)created session.
  await withStubbedSession(async ({ getSetPatch }) => {
    await createSession('2207000000', 'tenant123', { phoneNumberId: 'pnid1', humanMode: true });
    const patch = getSetPatch();
    assert.equal(patch.humanMode, true, 'humanMode should still be restored');
    assert.equal(patch.postFlowAck, null, 'postFlowAck must still be reset even on humanMode restore path');
    assert.equal(patch.postFlowData, null, 'postFlowData must still be reset even on humanMode restore path');
  });
});
