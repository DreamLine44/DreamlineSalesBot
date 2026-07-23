# development/TESTING.md

## Framework & command

Node's built-in test runner, no external framework:
```bash
npm test          # runs: node --test tests/
```
Files: `tests/*.test.mjs`. Import `test` from `node:test`, `assert` from
`node:assert/strict`.

## The two test patterns used in this codebase

### 1. Behavior tests (preferred when the code can be imported cleanly)
Import the real function and assert on its output, exactly like a normal
unit test. Used for pure functions (`isWithinBusinessHours`,
`resolveOrderFields`, `extractCustomerName`, etc.) and anything importable
without requiring a live MongoDB connection.

Example structure (`tests/businessHours.test.mjs`):
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWithinBusinessHours } from '../controllers/webhookController.js';

test('business hours: day-specific override resolves to business timezone, not server', () => {
  // ... construct input that would only pass if the fix is correct ...
  const result = isWithinBusinessHours(hours);
  assert.equal(result, false, 'explanation of why false is the correct answer');
});
```

### 2. Source-text guards (used when live infra — Mongo, network — would be
required to import the module directly)
Read the modified source file as text and assert the fix is present, PLUS
(when possible) copy the actual fixed logic verbatim into the test and
exercise it in isolation, so the test fails both if the fix is reverted
AND if the underlying behavior regresses independently of the exact source
text.

Example structure (`tests/waCatalogPartialUpdate.test.mjs`):
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
}
const src = read('../controllers/businessController.js');

// Copied verbatim from the fix — fails if the BEHAVIOR regresses, not just the text.
function flattenWaCatalog(update) { /* ... */ }

test('waCatalog partial update flattens instead of replacing the subdocument', () => {
  // assert against flattenWaCatalog(...) directly
});
```
Use this pattern for any fix inside a controller/service that requires
`BusinessConfig`/`Order`/`Session` models (i.e. a live Mongo connection) to
import directly — consistent with the existing
`leadCaptureTriggerAudit.test.mjs` / `postFlowSentimentAI.test.mjs` /
`waCatalogPartialUpdate.test.mjs` precedent.

## Writing a regression test for a new fix

1. **Reproduce first.** Write the test so it FAILS against the pre-fix code
   — if you can't make it fail without your fix, it isn't testing the bug.
2. **Name the file** after the bug/feature, `*.test.mjs`, in `tests/`.
3. **Explain the bug in a comment block** at the top of the test file: root
   cause, why it was silent (most bugs here are silent-failure bugs — see
   `.ai/references/RECURRING_BUG_PATTERNS.md`), and what the fix changes.
   This project treats the test file itself as part of the documentation of
   the bug, not just a pass/fail check.
4. Prefer the real-import pattern; fall back to the source-text-guard
   pattern only when live infra would otherwise be required.
5. Run the full suite (`npm test`) and confirm zero regressions before
   considering the change complete.

## What NOT to do

- Don't mock MongoDB — this codebase doesn't use an in-memory Mongo or
  mocking library; tests either avoid needing a DB (pure functions,
  source-text guards) or are skipped/excluded from CI-style runs that lack
  live infra.
- Don't write a test that only asserts "the function doesn't throw" — every
  test here asserts a specific, previously-wrong behavior is now correct.
- Don't delete or weaken an existing test to make a new change pass; if a
  new change genuinely invalidates an old test's assumption, that's a sign
  to slow down and confirm the change is intentional and correct, not to
  route around the test.
