import { test } from 'node:test';
import assert from 'node:assert/strict';
import Session from '../models/Session.js';
import { updateSession } from '../core/sessions/sessionService.js';

// [FIX-SES-8] regression: updateSession() must not silently collapse an active
// 24h humanMode TTL back down to the 30-minute default just because a caller
// (e.g. adminCommandService confirming/rejecting an order) sets step/currentFlow
// without mentioning humanMode in that same patch. The TTL must reflect the
// session's REAL current humanMode state, looked up from the DB when the patch
// itself doesn't say.
//
// We stub the Mongoose Model statics directly rather than hitting a real DB —
// this environment has no Mongo instance available, and these are pure static
// method calls (no schema/validation logic to lose by stubbing).

function withStubbedSession({ existingHumanMode }, run) {
  const originalFindOne = Session.findOne;
  const originalFindOneAndUpdate = Session.findOneAndUpdate;

  let findOneCalledWithProjection = null;
  let setPatchPassedToUpdate = null;

  Session.findOne = (filter, projection) => {
    findOneCalledWithProjection = projection;
    return { lean: () => Promise.resolve({ humanMode: existingHumanMode }) };
  };

  Session.findOneAndUpdate = (filter, update) => {
    setPatchPassedToUpdate = update.$set;
    return Promise.resolve({ ...filter, ...update.$set });
  };

  return run({
    getFindOneProjection: () => findOneCalledWithProjection,
    getSetPatch: () => setPatchPassedToUpdate,
  }).finally(() => {
    Session.findOne = originalFindOne;
    Session.findOneAndUpdate = originalFindOneAndUpdate;
  });
}

test('updateSession: preserves 24h humanMode TTL when step changes without humanMode in the patch', async () => {
  await withStubbedSession({ existingHumanMode: true }, async ({ getSetPatch }) => {
    const before = Date.now();
    await updateSession('2207000000', 'tenant123', { currentFlow: null, step: null, postFlowAck: 'ORDER_CONFIRMED' });
    const patch = getSetPatch();
    assert.ok(patch.expiresAt instanceof Date, 'expiresAt should be set');

    const ttlMs = patch.expiresAt.getTime() - before;
    const TWENTY_THREE_HOURS_MS = 23 * 60 * 60 * 1000;
    assert.ok(
      ttlMs > TWENTY_THREE_HOURS_MS,
      `expected ~24h TTL preserved (humanMode was true in DB), got ${(ttlMs / 1000 / 60).toFixed(1)} minutes — ` +
      `this is the exact regression: admin confirming an order silently shrinking an active humanMode session's TTL`
    );
  });
});

test('updateSession: uses default 30min TTL when step changes and humanMode is NOT active', async () => {
  await withStubbedSession({ existingHumanMode: false }, async ({ getSetPatch }) => {
    const before = Date.now();
    await updateSession('2207000000', 'tenant123', { currentFlow: 'ORDER', step: 'SELECT_ITEM' });
    const patch = getSetPatch();
    const ttlMs = patch.expiresAt.getTime() - before;
    const FORTY_FIVE_MIN_MS = 45 * 60 * 1000;
    assert.ok(ttlMs <= FORTY_FIVE_MIN_MS, `expected ~30min default TTL, got ${(ttlMs / 1000 / 60).toFixed(1)} minutes`);
  });
});

test('updateSession: explicit humanMode in the same patch skips the extra DB lookup', async () => {
  await withStubbedSession({ existingHumanMode: false }, async ({ getSetPatch, getFindOneProjection }) => {
    const before = Date.now();
    await updateSession('2207000000', 'tenant123', { humanMode: true });
    assert.equal(getFindOneProjection(), null, 'should not query existing humanMode when this patch already declares it');
    const patch = getSetPatch();
    const ttlMs = patch.expiresAt.getTime() - before;
    const TWENTY_THREE_HOURS_MS = 23 * 60 * 60 * 1000;
    assert.ok(ttlMs > TWENTY_THREE_HOURS_MS, 'explicit humanMode:true in the patch should get the 24h TTL directly');
  });
});

test('updateSession: updates with no step/currentFlow/humanMode change skip TTL recompute entirely', async () => {
  await withStubbedSession({ existingHumanMode: true }, async ({ getSetPatch, getFindOneProjection }) => {
    await updateSession('2207000000', 'tenant123', { postFlowAck: 'QUESTION' });
    assert.equal(getFindOneProjection(), null, 'no DB lookup needed when TTL is not being recomputed');
    const patch = getSetPatch();
    assert.equal(patch.expiresAt, undefined, 'expiresAt should not be touched for unrelated field updates');
  });
});
