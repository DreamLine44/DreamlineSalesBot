// tests/waCatalogQueueDrain.test.mjs
//
// Regression tests for the [CATALOG-QUEUE-2] pure extractions in
// modules/catalog/waCatalogHelpers.js that back the multi-item WA cart
// queue-draining behaviour in waCatalogFlow.js:
//
//   - resolveNextOrderStep(cfg)      — "what step comes after SELECT_ITEM"
//   - pickNextQueuedLine(business, queue) — the drain-time re-resolve loop
//   - buildQueuedFollowUpNote(queuedLines)
//   - buildSkippedLinesNote(extraLinesSkipped)
//
// waCatalogFlow.js itself (handleCatalogOrderMessage / drainCatalogQueue /
// offerCatalogOnStartOrder / browseCatalogExplicit) is orchestration — it
// touches sessionService (mongoose), flowEngine.advance(), and
// dispatcher.dispatchMessage(), so it's exercised at the integration level
// (full test suite + manual QA) rather than re-mocked here. These four
// functions hold ALL of that orchestration's actual decision logic in pure,
// dependency-free form, so unit-testing them here is what actually locks
// down the multi-item queuing behaviour without needing a live Mongo
// connection or a mocked dispatcher.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  resolveNextOrderStep, pickNextQueuedLine,
  buildQueuedFollowUpNote, buildSkippedLinesNote,
} = await import('../modules/catalog/waCatalogHelpers.js');

function makeBusiness(overrides = {}) {
  return {
    tenantId: 't1',
    menuItems: [
      { _id: 'item1', name: 'Blue Shirt', available: true, variants: [{ name: 'Small' }, { name: 'Large' }] },
      { _id: 'item2', name: 'Red Hat',    available: true },
      { _id: 'item3', name: 'Old Shoes',  available: false }, // deleted/unavailable
    ],
    ...overrides,
  };
}

// ── resolveNextOrderStep ─────────────────────────────────────────────────

test('resolveNextOrderStep returns the step right after SELECT_ITEM (retail-style: variant step next)', () => {
  const cfg = { steps: { ORDER: ['SELECT_ITEM', 'SELECT_VARIANT', 'QUANTITY', 'CONFIRM'] } };
  assert.equal(resolveNextOrderStep(cfg), 'SELECT_VARIANT');
});

test('resolveNextOrderStep returns QUANTITY for modules that go straight from SELECT_ITEM to QUANTITY', () => {
  const cfg = { steps: { ORDER: ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'] } };
  assert.equal(resolveNextOrderStep(cfg), 'QUANTITY');
});

test('resolveNextOrderStep falls back to QUANTITY when SELECT_ITEM is missing from steps.ORDER', () => {
  assert.equal(resolveNextOrderStep({ steps: { ORDER: ['BROWSE', 'CONFIRM'] } }), 'QUANTITY');
});

test('resolveNextOrderStep falls back to QUANTITY when SELECT_ITEM is the last step', () => {
  assert.equal(resolveNextOrderStep({ steps: { ORDER: ['BROWSE', 'SELECT_ITEM'] } }), 'QUANTITY');
});

test('resolveNextOrderStep falls back to QUANTITY for a missing/malformed cfg (never throws)', () => {
  assert.equal(resolveNextOrderStep(null), 'QUANTITY');
  assert.equal(resolveNextOrderStep({}), 'QUANTITY');
  assert.equal(resolveNextOrderStep({ steps: {} }), 'QUANTITY');
});

// ── pickNextQueuedLine ───────────────────────────────────────────────────

test('pickNextQueuedLine resolves the first queued line against the live menu', () => {
  const business = makeBusiness();
  const queue = [{ retailerId: 'item2', quantity: 3 }, { retailerId: 'item1::small', quantity: 1 }];
  const { next, remainingQueue } = pickNextQueuedLine(business, queue);

  assert.equal(next.item.name, 'Red Hat');
  assert.equal(next.variant, null);
  assert.equal(next.quantity, 3);
  assert.deepEqual(remainingQueue, [{ retailerId: 'item1::small', quantity: 1 }]);
});

test('pickNextQueuedLine resolves a variant-specific queued line back to { item, variant }', () => {
  const business = makeBusiness();
  const { next, remainingQueue } = pickNextQueuedLine(business, [{ retailerId: 'item1::large', quantity: 2 }]);

  assert.equal(next.item.name, 'Blue Shirt');
  assert.equal(next.variant, 'Large');
  assert.equal(next.quantity, 2);
  assert.deepEqual(remainingQueue, []);
});

test('pickNextQueuedLine skips a line whose product was deleted/disabled since the WA cart order arrived', () => {
  const business = makeBusiness();
  // item3 is unavailable (simulating an admin disabling it between order-time and drain-time).
  const queue = [{ retailerId: 'item3', quantity: 1 }, { retailerId: 'item2', quantity: 1 }];
  const { next, remainingQueue } = pickNextQueuedLine(business, queue);

  assert.equal(next.item.name, 'Red Hat');
  assert.deepEqual(remainingQueue, []); // both lines consumed: item3 skipped, item2 taken
});

test('pickNextQueuedLine returns next:null when every remaining line is unresolvable', () => {
  const business = makeBusiness();
  const { next, remainingQueue } = pickNextQueuedLine(business, [
    { retailerId: 'item3', quantity: 1 },        // unavailable
    { retailerId: 'does-not-exist', quantity: 1 }, // deleted entirely
  ]);
  assert.equal(next, null);
  assert.deepEqual(remainingQueue, []);
});

test('pickNextQueuedLine returns next:null for an empty or malformed queue (never throws)', () => {
  const business = makeBusiness();
  assert.deepEqual(pickNextQueuedLine(business, []), { next: null, remainingQueue: [] });
  assert.deepEqual(pickNextQueuedLine(business, null), { next: null, remainingQueue: [] });
  assert.deepEqual(pickNextQueuedLine(business, undefined), { next: null, remainingQueue: [] });
});

test('pickNextQueuedLine never mutates the queue array passed in', () => {
  const business = makeBusiness();
  const queue = [{ retailerId: 'item2', quantity: 1 }, { retailerId: 'item1', quantity: 1 }];
  const frozenCopy = queue.map(q => ({ ...q }));
  pickNextQueuedLine(business, queue);
  assert.deepEqual(queue, frozenCopy);
});

// ── buildQueuedFollowUpNote ──────────────────────────────────────────────

test('buildQueuedFollowUpNote returns "" when there is nothing queued', () => {
  assert.equal(buildQueuedFollowUpNote([]), '');
  assert.equal(buildQueuedFollowUpNote(null), '');
  assert.equal(buildQueuedFollowUpNote(undefined), '');
});

test('buildQueuedFollowUpNote uses singular grammar for exactly one queued item', () => {
  const note = buildQueuedFollowUpNote([{ retailerId: 'item1', quantity: 1 }]);
  assert.match(note, /You added 1 more item —/);
  assert.doesNotMatch(note, /1 more items/);
});

test('buildQueuedFollowUpNote uses plural grammar for more than one queued item', () => {
  const note = buildQueuedFollowUpNote([
    { retailerId: 'item1', quantity: 1 },
    { retailerId: 'item2', quantity: 1 },
  ]);
  assert.match(note, /You added 2 more items —/);
});

// ── buildSkippedLinesNote ────────────────────────────────────────────────

test('buildSkippedLinesNote returns "" when nothing was skipped', () => {
  assert.equal(buildSkippedLinesNote(0), '');
  assert.equal(buildSkippedLinesNote(null), '');
  assert.equal(buildSkippedLinesNote(undefined), '');
  assert.equal(buildSkippedLinesNote(-1), ''); // defensive: never a negative count in practice
});

test('buildSkippedLinesNote uses singular grammar ("isn\'t" / "it was") for exactly one skipped line', () => {
  const note = buildSkippedLinesNote(1);
  assert.match(note, /1 item from your catalog selection isn't available anymore, so it was skipped/);
});

test('buildSkippedLinesNote uses plural grammar ("aren\'t" / "they were") for more than one skipped line', () => {
  const note = buildSkippedLinesNote(2);
  assert.match(note, /2 items from your catalog selection aren't available anymore, so they were skipped/);
});

// ── Combined: the exact reply.body += ... sequence handleCatalogOrderMessage runs ──

test('a reply body with both a queued follow-up and a skipped-lines note concatenates both notes in order', () => {
  let body = 'Great choice! How many would you like?';
  body += buildQueuedFollowUpNote([{ retailerId: 'item1', quantity: 1 }]);
  body += buildSkippedLinesNote(1);

  assert.equal(
    body,
    "Great choice! How many would you like?" +
    "\n\n_(You added 1 more item — let's finish this one first, then I'll bring up the next automatically!)_" +
    "\n\n_(Heads up — 1 item from your catalog selection isn't available anymore, so it was skipped.)_",
  );
});
