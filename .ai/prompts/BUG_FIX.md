# prompts/BUG_FIX.md — Prompt template for fixing a reported bug

Use this as a starting prompt (fill in the bracketed parts) when asking an
AI assistant to fix a bug in WhatSales.

---

I need you to fix a bug in the WhatSales codebase. Before writing any code:

1. Read `.ai/README.md` in full (5 non-negotiable rules + audit methodology).
2. Read whichever `.ai/modules/`, `.ai/flows/`, or `.ai/business/` doc
   covers the area described below.
3. Check `.ai/references/RECURRING_BUG_PATTERNS.md` — this bug may be an
   instance of a known pattern (undeclared schema field, per-section vs.
   total Meta limit, server-time vs. business-time, etc.).

**Bug report:**
[Describe the symptom exactly as observed — what the customer/admin saw,
what they expected instead, any relevant tenant/mode/step context.]

**Steps to reproduce (if known):**
[...]

**Your process:**
1. Reproduce the bug by reading the actual code path (don't guess from a
   filename or comment) — trace it with `grep`/`view` from the entry point
   (usually `controllers/webhookController.js`'s `handleIncomingMessage()`)
   through to wherever the behavior diverges from expected.
2. Identify the ROOT CAUSE, not just a symptom-level patch. If it's a
   silent-failure pattern (see recurring bug patterns doc), say so
   explicitly in your fix comment.
3. Apply a surgical, single-purpose fix. Do not refactor unrelated code
   "while you're here."
4. Tag the fix with a comment: `// [AUDIT-FIX-<SHORT-NAME>] <root cause and
   what changed>`.
5. If the fix touches a Mongoose schema, confirm every read/write site
   agrees on the field name and shape.
6. Write a regression test in `tests/<descriptive-name>.test.mjs` per
   `.ai/development/TESTING.md` that fails on the pre-fix code.
7. Run `npm test` and confirm zero regressions.
8. Summarize: root cause, the fix, and the test that proves it.
