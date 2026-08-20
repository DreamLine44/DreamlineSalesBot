// tests/moduleRouterDeadEnquiryQuestionCases.test.mjs
//
// Regression test for a cleanup noted during the [FIX-STARTFLOW-FALLBACK]
// audit: moduleRouter.js's route() had explicit `case 'ENQUIRY':` and
// `case 'QUESTION':` switch branches, each with a "generic fallback" for
// modes without a dedicated flow. That fallback was unreachable dead code —
// moduleRegistry.js unconditionally registers ACTION_REGISTRY['ENQUIRY'] and
// ['QUESTION'] once at startup (regardless of business mode), so the
// `if (handler) return handler(...)` guard immediately above the fallback
// always took the early return, and the switch's own generic
// `ACTION_REGISTRY.get(upper)` delegation after the switch statement does
// the identical lookup anyway. Removed both cases entirely.
//
// Source-extraction test, same convention as the other flowEngine/
// moduleRegistry regression tests in this suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}

test('moduleRouter.js: no longer has dedicated ENQUIRY/QUESTION switch cases with unreachable fallback bodies', () => {
  const src = read('../core/conversations/moduleRouter.js');

  assert.doesNotMatch(
    src,
    /case 'ENQUIRY':/,
    "route() must not have a dedicated 'ENQUIRY' case — ENQUIRY falls through to the generic ACTION_REGISTRY delegation, which does the same lookup"
  );
  assert.doesNotMatch(
    src,
    /case 'QUESTION':/,
    "route() must not have a dedicated 'QUESTION' case — QUESTION falls through to the generic ACTION_REGISTRY delegation, which does the same lookup"
  );

  // The generic post-switch delegation these two actions now rely on must
  // still be present and unconditional.
  assert.match(
    src,
    /const handler = ACTION_REGISTRY\.get\(upper\);\s*\n\s*if \(handler\) \{\s*\n\s*return handler\(/,
    'the generic ACTION_REGISTRY delegation after the switch statement must still exist for ENQUIRY/QUESTION (and everything else) to fall through to'
  );
});
