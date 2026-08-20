// tests/startFlowModeFallback.test.mjs
//
// [FIX-STARTFLOW-FALLBACK] Regression tests for a systemic dead-end bug class:
// several flows are only registered for the specific business mode(s) they
// make sense for (WARRANTY/SPEC_REQUEST → ELECTRONICS, CAKE_CUSTOMIZATION →
// BAKERY, SKINCARE_ADVICE → COSMETICS, WALKIN → SALON/BARBERSHOP, ENQUIRY →
// SERVICES/GENERAL) — but intentEngine.js's deterministic keyword matching
// (both the exact-match step and the Levenshtein fuzzy-match step) runs the
// same global INTENT_PATTERNS list for every business mode with no gating,
// and RECOMMENDATION/SIZE_GUIDE/PRODUCT_INQUIRY/COMPATIBILITY_CHECK all map
// to the ENQUIRY action regardless of mode too. So e.g. a RETAIL customer
// typing "birthday cake", or a RESTAURANT customer typing "warranty", or an
// ELECTRONICS customer asking "does this work with my phone"
// (COMPATIBILITY_CHECK → ENQUIRY, only registered for SERVICES/GENERAL)
// previously hit flowEngine.js's startFlow() "no handler" branch and got a
// flat "⚠️ This option is not available. Please choose another action."
// dead end — for words that look like an entirely ordinary question.
//
// Fix: flowEngine.js exports hasFlow(mode, flowName); moduleRegistry.js's
// affected action handlers (WALKIN, CAKE_CUSTOMIZATION, SKINCARE_ADVICE,
// SPEC_REQUEST, WARRANTY, ENQUIRY) now check it via the shared
// startFlowOrAnswerQuestion() helper and fall back to the same Q&A path the
// QUESTION action itself already used (mode's own QUESTION flow, or the
// generic AI answer) instead of the dead end.
//
// Source-extraction tests (same technique as questionModeCartPreservation
// .test.mjs / midFlowOrderBookingSwitch.test.mjs) since flowEngine.js and
// moduleRegistry.js pull in a live Mongo-backed sessionService at module
// scope.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('flowEngine.js exports hasFlow(mode, flowName) using the same lookup startFlow() itself uses', () => {
  const src = read('../core/conversations/flowEngine.js');
  assert.match(
    src,
    /export function hasFlow\(mode, flowName\)/,
    'flowEngine.js must export a hasFlow(mode, flowName) helper so callers can check registration before starting a flow'
  );
  const fnMatch = src.match(/export function hasFlow\(mode, flowName\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'hasFlow function body not found');
  assert.match(fnMatch[0], /FLOW_REGISTRY\.has/, 'hasFlow must check FLOW_REGISTRY');
  assert.match(fnMatch[0], /GENERIC_REGISTRY\.has/, 'hasFlow must also check GENERIC_REGISTRY');
});

test('moduleRegistry.js: startFlowOrAnswerQuestion helper checks hasFlow() before starting and falls back to Q&A otherwise', () => {
  const src = read('../core/shared/moduleRegistry.js');
  const start = src.indexOf('async function startFlowOrAnswerQuestion');
  assert.ok(start !== -1, 'startFlowOrAnswerQuestion helper not found');
  const end = src.indexOf('\n}', start);
  const block = src.slice(start, end);

  assert.match(block, /hasFlow\(mode, flowName\)/, 'must check hasFlow(mode, flowName) before starting');
  assert.match(block, /handleQuestionAction\(/, 'must fall back to handleQuestionAction when the mode has no handler for this flow');
});

for (const action of ['WALKIN', 'CAKE_CUSTOMIZATION', 'SKINCARE_ADVICE', 'SPEC_REQUEST', 'WARRANTY', 'ENQUIRY']) {
  test(`moduleRegistry.js: registerAction('${action}', ...) routes through the shared mode-fallback helper, not a bare startFlow`, () => {
    const src = read('../core/shared/moduleRegistry.js');
    const marker = `registerAction('${action}',`;
    const start = src.indexOf(marker);
    assert.ok(start !== -1, `registerAction('${action}', ...) not found`);
    // Grab a small window after the marker — enough to see the handler body
    // for these are one-line arrow functions in the fixed source.
    const window = src.slice(start, start + 250);
    assert.match(
      window,
      /startFlowOrAnswerQuestion\(\{\s*flowName:\s*'([A-Z_]+)'/,
      `registerAction('${action}', ...) must delegate to startFlowOrAnswerQuestion so a mode without this flow gets a real answer instead of a dead end`
    );
  });
}

test("moduleRegistry.js: registerAction('COMPARE', ...) is left as a bare startFlow (button-only trigger, no keyword path, no fallback needed)", () => {
  const src = read('../core/shared/moduleRegistry.js');
  const start = src.indexOf("registerAction('COMPARE',");
  assert.ok(start !== -1, "registerAction('COMPARE', ...) not found");
  const window = src.slice(start, start + 250);
  assert.match(window, /startFlow\(\{\s*flowName:\s*'COMPARE'/, 'COMPARE should still call startFlow directly');
});

test("moduleRegistry.js: registerAction('QUESTION', ...) now delegates to the shared handleQuestionAction function", () => {
  const src = read('../core/shared/moduleRegistry.js');
  assert.match(
    src,
    /registerAction\('QUESTION',\s*handleQuestionAction\)/,
    "registerAction('QUESTION', ...) must reuse the same handleQuestionAction function the other actions fall back to, not a separate duplicated inline implementation"
  );
});
