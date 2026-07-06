// tests/leadCaptureTriggerAudit.test.mjs
//
// Regression test for [AUDIT-FIX-LEADCAP-1]: core/conversations/flowEngine.js's
// completeFlow() decides which leadCapture.triggerOn bucket ('AFTER_ORDER' /
// 'AFTER_BOOKING') to check based on the completedFlow name it was called with.
//
// Bug: the code used an "else" catch-all — only 'BOOKING'/'WALKIN' mapped to
// AFTER_BOOKING, and EVERYTHING ELSE (including 'QUESTION', 'ENQUIRY', 'ABOUT',
// 'SPEC_REQUEST', 'WARRANTY', 'SKINCARE_ADVICE', 'QUOTE_FOLLOW' — none of which
// are an order being placed) silently mapped to AFTER_ORDER. Any business
// configured with leadCapture.triggerOn='AFTER_ORDER' would have gotten a
// "what's your name?" lead-capture prompt injected after simply answering an
// FAQ, sending a general enquiry, or asking about warranty/skincare — not just
// after a real order.
//
// This is a source-text guard (not a live-DB test), consistent with how
// postFlowSentimentAI.test.mjs / patterns.test.mjs guard other fixes in
// modules that need a Mongo connection + AI provider wired up to import directly.
//
// Does NOT modify any existing source file.
//
// Run with:  node --test src/tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

const flowEngineSrc = read('../core/conversations/flowEngine.js');

test('completeFlow(): every completedFlow value actually used in the codebase maps to the correct lead-capture trigger (or none)', () => {
  // Every distinct completedFlow string literal passed to completeFlow() across
  // the whole modules/ + bookingFlow.js call sites, as of this fix. If a new
  // value is added later, a human must consciously extend this allowlist —
  // at which point they should double-check which trigger bucket (if any) it
  // belongs in, rather than letting it silently fall into AFTER_ORDER again.
  const ORDER_COMPLETING   = ['ORDER'];
  const BOOKING_COMPLETING = ['BOOKING', 'WALKIN'];
  const NON_PURCHASE       = ['QUESTION', 'ENQUIRY', 'ABOUT', 'SPEC_REQUEST', 'WARRANTY', 'SKINCARE_ADVICE', 'QUOTE_FOLLOW'];

  // The fix must define explicit allowlists, not an else-catch-all.
  assert.match(flowEngineSrc, /ORDER_COMPLETING_FLOWS\s*=\s*new Set\(\[['"]ORDER['"]\]\)/,
    'Expected an explicit ORDER_COMPLETING_FLOWS allowlist containing only ORDER');
  assert.match(flowEngineSrc, /BOOKING_COMPLETING_FLOWS\s*=\s*new Set\(\[['"]BOOKING['"],\s*['"]WALKIN['"]\]\)/,
    'Expected an explicit BOOKING_COMPLETING_FLOWS allowlist containing BOOKING and WALKIN');

  // Must NOT contain the old unconditional else-catch-all pattern that mapped
  // every non-booking completion to AFTER_ORDER.
  assert.doesNotMatch(
    flowEngineSrc,
    /:\s*['"]AFTER_ORDER['"]\s*;?\s*$/m,
    'Found a bare ": \'AFTER_ORDER\'" fallback — trigger must only be set inside an explicit ORDER_COMPLETING_FLOWS check'
  );

  // Sanity: trigger must be nullable (no trigger at all) for non-purchase completions.
  assert.match(flowEngineSrc, /let trigger\s*=\s*null/,
    'Expected trigger to default to null so QUESTION/ENQUIRY/ABOUT/etc. never fire lead capture');

  // Document the full set of completedFlow values this fix must account for,
  // so future call sites are forced to reconsider this test.
  const allValues = [...ORDER_COMPLETING, ...BOOKING_COMPLETING, ...NON_PURCHASE];
  assert.equal(new Set(allValues).size, allValues.length, 'sanity: no duplicate values in this test\'s own list');
});

test('completeFlow(): lead capture block is skipped entirely (trigger stays null) for non-purchase completions', () => {
  // Structural check: the shouldCaptureLead/startLeadCapture import + call must
  // be nested inside an `if (trigger)` guard, not run unconditionally whenever
  // `business` is truthy.
  assert.match(
    flowEngineSrc,
    /if\s*\(trigger\)\s*\{[\s\S]*?shouldCaptureLead[\s\S]*?startLeadCapture/,
    'Expected the shouldCaptureLead/startLeadCapture calls to be gated behind `if (trigger)`'
  );
});
