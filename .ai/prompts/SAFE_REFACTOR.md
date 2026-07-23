# prompts/SAFE_REFACTOR.md — Prompt template for refactoring existing code

WhatSales's stability comes from small, well-documented, single-purpose
diffs — not sweeping rewrites. Use this template to keep a refactor safe.

---

I need you to refactor part of the WhatSales codebase. Before writing any
code:

1. Read `.ai/README.md` (5 non-negotiable rules) — a refactor is exactly
   the kind of change most likely to accidentally violate one of them
   (e.g. moving a session-field write without checking the schema still
   declares it, or reordering routes/middleware).
2. Read the `.ai/` doc(s) covering the file(s) you're refactoring.
3. Read `.ai/references/RECURRING_BUG_PATTERNS.md` — many of these bugs
   were introduced BY a refactor (e.g. the cancelFlow DB-write regression
   was a botched merge during cleanup). A refactor is a higher-risk moment
   than a fresh feature, not a lower-risk one.

**What to refactor and why:**
[Describe the code smell / duplication / structural problem, and the
specific area — do not request an open-ended "clean this up".]

**Your process:**
1. Establish a green baseline: `npm test` before touching anything. Note
   the pass count.
2. Read every call site of everything you intend to change — `grep` for
   the function/field name across the whole repo, not just the file you're
   editing. Given this codebase's history of "built but never wired"
   modules, assume there may be call sites you don't expect.
3. Make the refactor behavior-preserving. If you believe a behavior change
   is actually warranted as part of this refactor, stop and flag it
   explicitly rather than bundling it silently into the "just a refactor."
4. Do not touch files outside the stated scope, even if you notice
   something else that looks improvable — note it separately instead.
5. Preserve every existing `[AUDIT-FIX-*]` / `[FIX-*]` comment verbatim
   unless the code it describes is being removed entirely — these comments
   are load-bearing documentation of prior bugs, not clutter.
6. Re-run the full test suite. Pass count must match the baseline exactly
   (same tests passing, none silently skipped or deleted).
7. If the refactor moves a Mongoose field write, a route mount, or a
   dispatcher call, explicitly re-verify Rules 1–4 in `.ai/README.md`
   still hold for the new location.
8. Summarize exactly what moved/changed shape, confirm zero behavior
   change (or explicitly flag any intentional exception), and confirm the
   test baseline is unchanged.
