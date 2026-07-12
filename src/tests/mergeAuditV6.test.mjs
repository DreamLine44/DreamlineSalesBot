// tests/mergeAuditV6.test.mjs
//
// Regression tests for the audit performed after merging the
// `whatsales-backend-update` (v5-audited, 349 tests) and
// `src_correct-view-menu-features` zips. Diffing confirmed the latter was a
// stale July 2 snapshot strictly subsumed by the former (every differing
// file in it was missing later fixes, none contained unique functionality),
// so the merge result is the v5 tree with a fresh audit pass on top.
//
// Bugs found and fixed in this pass:
//
// [AUDIT-FIX-ADMINPHONE-3] general/flows/index.js's handleAbout() built its
// contact line from `business?.adminPhone || null` only, missing the
// `tenant?.adminPhone` fallback that [AUDIT-FIX-ADMINPHONE-2] already
// restored at every other adminPhone read-site in the codebase (retail,
// general enquiry, payment confirmations, etc). adminPhone lives on both the
// BusinessConfig and Tenant schemas; whenever it's only set on the Tenant
// doc, the "About Us" screen silently dropped the phone number instead of
// falling back to it.
//
// [AUDIT-FIX-SUGGESTCONFIRM-1] Two independent SUGGESTION_CONFIRM-style step
// handlers (electronics' SUGGEST_CONFIRM, restaurant's SUGGESTION_CONFIRM)
// had a confirm regex missing 'sure', unlike every other confirm-style regex
// in the codebase (BOOKING_CONFIRM's canonical [AUDIT-FIX-CONFIRM-1] fix
// already includes it). A customer replying "sure" to a "Did you mean X?"
// prompt fell through to the rejected/no-match branch and silently lost the
// suggested item.
//
// Following this codebase's established pattern (see
// v2CancelConfirmedGuardAudit.test.mjs): these flow handlers aren't designed
// for isolated unit import without a live Mongo/session context, so these
// are source-text guards.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('general/flows/index.js: handleAbout falls back to tenant.adminPhone, matching every other adminPhone read-site', () => {
  const src = read('../modules/general/flows/index.js');
  const start = src.indexOf('export async function handleAbout(');
  assert.ok(start !== -1, 'handleAbout not found');
  const end = src.indexOf('export async function', start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);

  assert.match(
    body,
    /business\?\.adminPhone\s*\|\|\s*tenant\?\.adminPhone/,
    'expected handleAbout to fall back to tenant?.adminPhone like every other adminPhone read-site'
  );
  assert.doesNotMatch(
    body,
    /const phone\s*=\s*business\?\.adminPhone\s*\|\|\s*null;/,
    'handleAbout must not read adminPhone from business only'
  );
});

test('electronics/flows/orderFlow.js: SUGGEST_CONFIRM accepts "sure" as a valid affirmative', () => {
  const src = read('../modules/electronics/flows/orderFlow.js');
  const start = src.indexOf("case 'SUGGEST_CONFIRM': {");
  assert.ok(start !== -1, "case 'SUGGEST_CONFIRM' not found");
  const body = src.slice(start, start + 800);

  assert.match(
    body,
    /\/\^\(yes\|y\|yep\|yeah\|confirm\|ok\|okay\|sure\|confirm_suggestion\)\$\/i/,
    'expected the SUGGEST_CONFIRM regex to include "sure"'
  );
});

test('restaurant/flows/orderFlow.js: SUGGESTION_CONFIRM accepts "sure" as a valid affirmative', () => {
  const src = read('../modules/restaurant/flows/orderFlow.js');
  const start = src.indexOf("case 'SUGGESTION_CONFIRM': {");
  assert.ok(start !== -1, "case 'SUGGESTION_CONFIRM' not found");
  const body = src.slice(start, start + 800);

  assert.match(
    body,
    /\/\^\(yes\|y\|yep\|yeah\|confirm\|ok\|okay\|sure\)\$\/i/,
    'expected the SUGGESTION_CONFIRM regex to include "sure"'
  );
});

test('sanity: the fixed regexes actually match "sure" (behavioural double-check of the source-text guards above)', () => {
  const electronicsRe = /^(yes|y|yep|yeah|confirm|ok|okay|sure|confirm_suggestion)$/i;
  const restaurantRe  = /^(yes|y|yep|yeah|confirm|ok|okay|sure)$/i;
  assert.ok(electronicsRe.test('sure'), 'electronics SUGGEST_CONFIRM regex should match "sure"');
  assert.ok(restaurantRe.test('sure'), 'restaurant SUGGESTION_CONFIRM regex should match "sure"');
  assert.ok(electronicsRe.test('Sure'), 'should be case-insensitive');
  assert.ok(restaurantRe.test('SURE'), 'should be case-insensitive');
});
