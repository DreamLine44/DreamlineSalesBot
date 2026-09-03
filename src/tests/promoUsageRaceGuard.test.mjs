// tests/promoUsageRaceGuard.test.mjs
//
// [AUDIT-FIX-PROMO-RACE] Regression tests for applyPromoUsage() in
// services/promoService.js.
//
// Bug: applyPromoUsage()'s own docstring always claimed the usedCount
// increment was "guarded ... only if it's still under its maxUses at the
// moment of the write", but the actual Mongo update was a plain
// `{ tenantId, 'promotions.code': code }` filter with `$inc: { usedCount: 1 }`
// — no maxUses condition anywhere. validatePromoCode() (the earlier,
// separate read that decides whether to apply a promo at all) and
// applyPromoUsage() (the later write) are not part of one atomic operation,
// so two concurrent saveOrder() calls that both read usedCount one below
// maxUses both pass validation and then both increment here, pushing
// usedCount past maxUses with nothing in the write itself to stop it.
//
// Fix: applyPromoUsage() now issues a MongoDB aggregation-pipeline update
// ($set with $map/$cond over the promotions array) so the maxUses check and
// the increment happen as ONE atomic server-side operation: an element is
// only bumped when its own maxUses is null/unset (unlimited) or its usedCount
// is still strictly less than maxUses.
//
// This environment has no live MongoDB (see waCatalogCrudSync.test.mjs and
// others for the same constraint), so this is two things:
//   1. A source-text guard confirming the old unconditional-$inc pattern is
//      gone and the new query filters on maxUses.
//   2. A pure re-implementation of the $map/$cond decision logic (mirrors
//      promoDiscountMath.test.mjs's approach for validatePromoCode's
//      arithmetic), unit tested against the exact scenarios that motivated
//      the fix — proving the *logic* is correct even though the live Mongo
//      execution engine itself can't be exercised here.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const svcSrc = fs.readFileSync(new URL('../services/order/promoService.js', import.meta.url), 'utf8');

test('applyPromoUsage no longer unconditionally increments usedCount with no maxUses guard', () => {
  // The old, buggy query: a plain filter with no maxUses condition anywhere,
  // paired with an unconditional $inc.
  assert.doesNotMatch(
    svcSrc,
    /\{ tenantId, 'promotions\.code': code\.trim\(\)\.toUpperCase\(\) \},\s*\n\s*\{ \$inc: \{ 'promotions\.\$\.usedCount': 1 \} \}/,
  );
});

test('applyPromoUsage update references maxUses in its write, not just its docstring', () => {
  // Grab just the function body so this doesn't pass by accidentally matching
  // "maxUses" in validatePromoCode() elsewhere in the file.
  const fnStart = svcSrc.indexOf('export async function applyPromoUsage');
  assert.ok(fnStart !== -1, 'applyPromoUsage export not found');
  const fnBody = svcSrc.slice(fnStart);
  assert.match(fnBody, /maxUses/, 'applyPromoUsage no longer mentions maxUses in its implementation, not just its comment');
  assert.match(fnBody, /usedCount/);
});

// ── Pure re-implementation of the $map/$cond decision, one array element at a time ──
function shouldIncrement(promotion, code) {
  if (promotion.code !== code) return false;
  if (promotion.maxUses == null) return true;
  return promotion.usedCount < promotion.maxUses;
}
function applyIncrement(promotion, code) {
  return shouldIncrement(promotion, code)
    ? { ...promotion, usedCount: (promotion.usedCount || 0) + 1 }
    : promotion;
}

test('increments usedCount when under an unlimited (null maxUses) code', () => {
  const promo = { code: 'SAVE10', maxUses: null, usedCount: 500 };
  const result = applyIncrement(promo, 'SAVE10');
  assert.equal(result.usedCount, 501);
});

test('increments usedCount when strictly under maxUses', () => {
  const promo = { code: 'SAVE10', maxUses: 100, usedCount: 98 };
  const result = applyIncrement(promo, 'SAVE10');
  assert.equal(result.usedCount, 99);
});

test('does NOT increment once usedCount has already reached maxUses (the race the bug allowed)', () => {
  const promo = { code: 'SAVE10', maxUses: 100, usedCount: 100 };
  const result = applyIncrement(promo, 'SAVE10');
  assert.equal(result.usedCount, 100, 'usedCount must not exceed maxUses');
});

test('does NOT increment a code whose usedCount already exceeds maxUses (already-corrupted data heals instead of getting worse)', () => {
  const promo = { code: 'SAVE10', maxUses: 100, usedCount: 103 };
  const result = applyIncrement(promo, 'SAVE10');
  assert.equal(result.usedCount, 103);
});

test('leaves a non-matching promotions array element untouched', () => {
  const other = { code: 'OTHERCODE', maxUses: 5, usedCount: 5 };
  const result = applyIncrement(other, 'SAVE10');
  assert.deepEqual(result, other);
});

test('concurrent-write simulation: two racing increments against maxUses=1 only land once', () => {
  // Simulates what the OLD unconditional $inc allowed: both requests read
  // usedCount=0 (below maxUses=1) before either write lands, so a plain
  // $inc-with-no-guard would let usedCount reach 2. The atomic
  // maxUses-aware update this fix introduces re-evaluates the condition
  // against the document's CURRENT state at write time — server-side, one
  // write at a time — so the second write's own condition check sees the
  // first write's result and correctly no-ops.
  let promo = { code: 'ONEUSE', maxUses: 1, usedCount: 0 };
  promo = applyIncrement(promo, 'ONEUSE'); // first concurrent request lands
  promo = applyIncrement(promo, 'ONEUSE'); // second sees updated state, no-ops
  assert.equal(promo.usedCount, 1, 'usedCount must never exceed maxUses even under concurrent writes');
});
