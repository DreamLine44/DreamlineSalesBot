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

## Known issue: `npm test` (`node --test tests/`) vs. `node --test tests/*.test.mjs`

On Node v22.22.2 in this environment, `npm test` (which runs exactly
`node --test tests/`) failed immediately with `Cannot find module
'/path/tests'` — passing the directory without a trailing glob didn't
discover files as expected. Running `node --test tests/*.test.mjs`
directly worked and executed all 420 tests. If `npm test` fails
immediately with a `MODULE_NOT_FOUND` on the bare `tests/` path in your
environment, try the explicit glob before assuming something else is
broken.

## KNOWN FAILING TESTS as of this audit pass — read before trusting a green/red result

Running the full suite in this environment: **403 passing, 17 failing.**
At least one cluster of failures is a **genuinely stale test file**, not a
code regression — worth fixing (or deleting) rather than trusting blindly:

- **`tests/dispatcherListChunking.test.mjs`** tests `[FIX-LIST-TRUNC]`
  (the OLDER assumption: 10 rows *per section*, up to 10 sections, chunk
  overflow into "(cont.)" sections). This has since been **superseded** by
  `[FIX-LIST-CAP-2]` in `core/whatsapp/dispatcher.js` (10 rows *total*
  across the whole message — see `.ai/whatsapp/DISPATCHER_AND_LIMITS.md`
  and `.ai/references/RECURRING_BUG_PATTERNS.md` #4), which was itself a
  fix for a real Meta 400 error the chunking approach caused in
  production. The test file's assertions directly contradict the current,
  correct `dispatcher.js` behavior. **This test file should be rewritten
  or removed** — it is currently testing for behavior the code
  deliberately no longer has.
- A cluster of `buildWelcomeSequence` test failures (`moduleRouter.js`)
  expect a two-message shape (plain-text greeting + separate buttons
  message) that doesn't match the current single-Interactive-List welcome
  UI described in `.ai/modules/BUSINESS_MODULES.md` — likely the same
  "test written against an earlier UI iteration" issue as above.
- A cluster of WA Catalog tests (`shouldOfferCatalog`, `shouldShowCatalogButton`,
  `withCatalogWelcomeOption`, `syncWaCatalog` response fields) are also
  failing — these need investigation to determine whether they're stale
  (same class as above) or represent a real regression in
  `modules/catalog/waCatalogConfig.js` / `waCatalogService.js`. Given this
  session's `isCatalogEnabled()` behavior matched its own doc comments
  exactly when read directly, stale-test is the more likely explanation,
  but **do not assume this without actually running the specific failing
  assertions against the current function output** — confirm before
  deleting or "fixing" any of these.

**Do not treat a passing `npm test` run as ground truth without first
running it and checking the current pass/fail delta against this list** —
either resolve these 17 (likely by retiring `dispatcherListChunking.test.mjs`
and updating/removing the stale welcome/catalog assertions to match current
behavior), or at minimum confirm the failure count hasn't grown before
considering any new change "regression-free."

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
