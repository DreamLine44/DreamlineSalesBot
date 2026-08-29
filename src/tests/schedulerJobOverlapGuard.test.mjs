// tests/schedulerJobOverlapGuard.test.mjs
//
// [FIX-SCHED-OVERLAP] Regression test.
//
// Bug found and fixed: all four scheduler jobs (abandoned cart, booking
// reminder, payment reminder, post-appointment follow-up) were wired via
// bare `setInterval(() => runXJob().catch(...), intervalMs)` with no
// re-entrancy guard. Each job marks a record "reminded" only AFTER awaiting
// a WhatsApp send, one record at a time in a sequential for-loop — so a run
// that takes longer than its own interval (slow Meta API response, a large
// candidate batch) would still be in flight when the next tick fired,
// causing a second overlapping run of the SAME job. That second run's query
// would see every record the first run hadn't reached yet as still
// unmarked, and send the same customer the same reminder twice.
//
// wrapWithGuard() makes a job a no-op (skip + log) if a previous invocation
// of that same job is still running, so a slow run delays the next tick
// instead of doubling up on outbound customer messages.

import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapWithGuard } from '../services/schedulerService.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('wrapWithGuard: a second call while the first is still running is skipped, not run concurrently', async () => {
  const gate = deferred();
  let concurrentCalls = 0;
  let maxConcurrent = 0;
  let totalRuns = 0;

  const slowJob = async () => {
    concurrentCalls++;
    maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
    totalRuns++;
    await gate.promise; // stays "in flight" until the test releases it
    concurrentCalls--;
  };

  const guarded = wrapWithGuard('test-job', slowJob);

  const firstRun = guarded();   // starts and awaits the gate
  await Promise.resolve();      // let it register as running
  const secondRun = guarded();  // should be skipped immediately (no-op)

  await secondRun; // resolves right away — it never called slowJob again
  assert.equal(totalRuns, 1, 'the overlapping second call must not invoke the job a second time');
  assert.equal(maxConcurrent, 1, 'the job must never run concurrently with itself');

  gate.resolve();
  await firstRun;
});

test('wrapWithGuard: after a run completes, the next call runs normally (no permanent lock)', async () => {
  let calls = 0;
  const guarded = wrapWithGuard('test-job-2', async () => { calls++; });

  await guarded();
  await guarded();
  await guarded();

  assert.equal(calls, 3, 'the guard must release after each run so future ticks are not blocked forever');
});

test('wrapWithGuard: the guard releases even if the wrapped job throws', async () => {
  let attempt = 0;
  const guarded = wrapWithGuard('test-job-3', async () => {
    attempt++;
    if (attempt === 1) throw new Error('boom');
  });

  await assert.rejects(() => guarded(), /boom/);
  // A second call after the failure must actually run (guard was released in `finally`),
  // not be silently skipped as if the failed run were still "in progress".
  await guarded();
  assert.equal(attempt, 2, 'the guard must not stay locked after the job throws');
});

test('wrapWithGuard: two different job names never block each other', async () => {
  const gateA = deferred();
  let ranB = false;

  const guardedA = wrapWithGuard('job-a', async () => { await gateA.promise; });
  const guardedB = wrapWithGuard('job-b', async () => { ranB = true; });

  const runA = guardedA();
  await guardedB(); // must complete immediately — different job name, independent lock
  assert.equal(ranB, true, 'a different job name must not be blocked by an unrelated in-flight job');

  gateA.resolve();
  await runA;
});
