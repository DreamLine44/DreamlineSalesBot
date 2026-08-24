// tests/v1RestaurantConfirmAudit.test.mjs
//
// Regression tests for the v1 systematic audit of the restaurant flow systems
// (orderFlow.js CONFIRM step, bookingFlow.js BOOKING_CONFIRM step).
//
// Bug found and fixed:
//
// [AUDIT-FIX-CONFIRM-1] Both orderFlow.js's ORDER-CONFIRM step and the shared
// bookingFlow.js's BOOKING_CONFIRM step — the two steps that actually SAVE the
// order/booking — accepted "yes/y/confirm/ok/okay/sure" but were missing
// "yeah"/"yep". Every OTHER confirmation step in the same files
// (SUGGESTION_CONFIRM and UPSELL in orderFlow.js; DATE_CONFIRM and
// TIME_CONFIRM in bookingFlow.js) already accepted "yeah"/"yep". A customer
// who naturally typed "yeah" at the final step — the one moment that matters
// most, since it's the one that actually places the order or saves the table
// booking — got the summary silently re-displayed instead of their order/
// booking being saved, with no indication of what went wrong. This affected
// restaurant food orders directly, and restaurant table bookings (and every
// other module sharing bookingFlow.js) via the shared BOOKING_CONFIRM step.
//
// These are source-text guards, consistent with how the existing
// v22RestaurantFlowAudit.test.mjs / v19FlowsAudit.test.mjs suites work in this
// codebase — orderFlow.js and bookingFlow.js pull in Mongoose models and
// session/dispatch services that are not safe to exercise end-to-end without
// a live Mongo connection and Express app context.
//
// Run with: node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('orderFlow.js: CONFIRM step accepts "yeah" and "yep" like every other confirmation step in this file', () => {
  const src = read('../modules/restaurant/flows/orderFlow.js');
  const start = src.indexOf("case 'CONFIRM': {");
  assert.ok(start !== -1, 'CONFIRM case not found');
  const body = src.slice(start, start + 1200);

  // [FIX-DUALLAYER-CONFIRM] widened this to a two-part OR (bare-word regex ||
  // the shared confirmationMatcher check), spanning multiple lines, so the
  // statement no longer ends in `.test(clean);` on the same line.
  const match = body.match(/const isConfirm = (\/\^.*?\$\/i)\.test\(clean\)/);
  assert.ok(match, 'expected an isConfirm regex test in the CONFIRM case');

  const re = new RegExp(match[1].slice(1, -2), 'i'); // strip surrounding /.../i for reuse
  assert.match('yeah', re, 'CONFIRM step must accept "yeah" — it must match every other confirm step in this file');
  assert.match('yep', re, 'CONFIRM step must accept "yep" — it must match every other confirm step in this file');
});

test('orderFlow.js: SUGGESTION_CONFIRM and UPSELL steps still accept "yeah"/"yep" (consistency baseline)', () => {
  const src = read('../modules/restaurant/flows/orderFlow.js');
  assert.match(src, /yes\|y\|yep\|yeah\|confirm\|ok\|okay/, 'SUGGESTION_CONFIRM regex should still include yep/yeah');
  assert.match(src, /yes\|y\|yep\|yeah\|ok\|okay\|sure\|add\|upsell_yes/, 'UPSELL regex should still include yep/yeah');
});

test('bookingFlow.js: BOOKING_CONFIRM step accepts "yeah" and "yep" like DATE_CONFIRM/TIME_CONFIRM do', () => {
  const src = read('../core/conversations/bookingFlow.js');
  const start = src.indexOf("case 'BOOKING_CONFIRM': {");
  assert.ok(start !== -1, 'BOOKING_CONFIRM case not found');
  const body = src.slice(start, start + 3200);

  // [FIX-DUALLAYER-CONFIRM] the guard is now computed into a named
  // `isBookingConfirm` variable (bare-word regex || clean === 'confirm' ||
  // the shared confirmationMatcher check) and checked via `if (!isBookingConfirm)`,
  // rather than an inline `if (!(/regex/i).test(clean) && ...)` expression.
  const match = body.match(/const isBookingConfirm = (\/\^.*?\$\/i)\.test\(clean\)/);
  assert.ok(match, 'expected the BOOKING_CONFIRM guard regex');

  const re = new RegExp(match[1].slice(1, -2), 'i');
  assert.match('yeah', re, 'BOOKING_CONFIRM step must accept "yeah" — this is the step that actually saves the booking');
  assert.match('yep', re, 'BOOKING_CONFIRM step must accept "yep" — this is the step that actually saves the booking');
});

test('bookingFlow.js: DATE_CONFIRM and TIME_CONFIRM still accept "yeah"/"yep" (consistency baseline)', () => {
  const src = read('../core/conversations/bookingFlow.js');
  const matches = src.match(/\/\^\(yes\|y\|yep\|yeah\)\$\/i/g) || [];
  assert.ok(matches.length >= 2, 'expected DATE_CONFIRM and TIME_CONFIRM to both use the yes/y/yep/yeah regex');
});
