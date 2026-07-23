# prompts/CODE_REVIEW.md — Prompt template for reviewing a change

Use this when asking an AI assistant to review a diff/PR against this
codebase's standards before it merges.

---

Review the following change to the WhatSales codebase. Before reviewing:

1. Read `.ai/README.md` in full.
2. Read whichever `.ai/` docs cover the area the diff touches.

**The diff / change to review:**
[Paste the diff, or point at the files changed.]

**Review checklist — go through every item explicitly, don't just skim:**

### Correctness
- [ ] Does every new/changed session or business-config field appear in
      its Mongoose schema, with a default? (Rule 1)
- [ ] Does every new enum value used anywhere in the diff already exist in
      the corresponding schema's `enum: [...]`? (Rule 2)
- [ ] If routes were added/reordered in `app.js` or any router file, is the
      mount order still correct per the inline comments and
      `.ai/ARCHITECTURE.md`'s "Route mount order" section? (Rule 3)
- [ ] Does any new outbound-message code path go through
      `core/whatsapp/dispatcher.js` rather than calling the Meta Graph API
      directly? (Rule 4)
- [ ] If new interactive buttons/list rows were added, are their IDs
      present in `BUTTON_ID_MAP`, `isFlowPassthroughId()`, or
      `STEP_VALID_BUTTONS` as appropriate? (Rule 5)
- [ ] Does the diff respect Meta's real limits (10 rows total, 30 product
      items total, 3 buttons, field length caps) per
      `.ai/whatsapp/DISPATCHER_AND_LIMITS.md`, rather than assuming a
      per-section limit?
- [ ] Does the diff introduce or risk any pattern from
      `.ai/references/RECURRING_BUG_PATTERNS.md`? Check each of the 10
      patterns explicitly.
- [ ] Does the diff respect `.ai/business/SESSION_RULES.md`'s "Key product
      rules FT enforces strictly" (no upselling/loyalty/fabricated data
      signals, no name in initial greeting)?

### Testing
- [ ] Is there a regression test for each bug fix, per
      `.ai/development/TESTING.md`, that would fail without the fix?
- [ ] Does `npm test` pass with no reduction in test count vs. baseline?

### Style / scope
- [ ] Is the change surgical and single-purpose, or does it bundle
      unrelated changes?
- [ ] Are fixes tagged with a `[AUDIT-FIX-*]`/`[FIX-*]`-style comment
      explaining root cause?
- [ ] Were any existing `[AUDIT-FIX-*]`/`[FIX-*]` comments removed or
      altered without the described bug being fully re-verified as still
      fixed?

**Output format:** for each unchecked item, explain specifically what's
missing/wrong and point at the exact line(s). Don't approve with
unaddressed items — either they're fixed, or explicitly flagged as
out-of-scope with the reviewer's sign-off requested.
