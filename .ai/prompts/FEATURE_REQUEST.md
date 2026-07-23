# prompts/FEATURE_REQUEST.md — Prompt template for adding a new feature

---

I need you to add a new feature to the WhatSales codebase. Before writing
any code:

1. Read `.ai/README.md`, `.ai/PROJECT_OVERVIEW.md`, `.ai/ARCHITECTURE.md`.
2. Read `.ai/flows/FLOW_ENGINE.md` if this touches conversation flow, or
   `.ai/modules/BUSINESS_MODULES.md` if it's vertical-specific.
3. Read `.ai/business/SESSION_RULES.md` — specifically the "Key product
   rules FT enforces strictly" section. **If this feature implies
   upselling, cross-selling, personalized recommendations, loyalty/
   wishlist/trending/new-arrivals mechanics, or any fabricated data signal,
   stop and flag this before implementing** — these are deliberate product
   decisions, not gaps.

**Feature description:**
[What should the feature do, from the customer's or admin's point of view?]

**Which vertical(s) does this apply to?**
[All modes? One specific mode? New mode?]

**Your process:**
1. Confirm whether an existing flow/action can be extended, or whether this
   needs a new flow/action/intent — check `.ai/flows/INTENT_DETECTION.md`'s
   "adding a new intent/action" checklist and
   `.ai/flows/FLOW_ENGINE.md`'s "adding a vertical" checklist as templates
   for what needs to change together.
2. If it introduces new persisted data, declare it in the relevant
   Mongoose schema FIRST (Rule 1/2 in `.ai/README.md`), including any new
   enum values.
3. If it introduces new customer-facing UI (buttons/lists), respect Meta's
   real limits — see `.ai/whatsapp/DISPATCHER_AND_LIMITS.md` — and the
   3-button welcome-screen cap most modules are already at.
4. If it's gated on tenant data, make sure it's actually gated — e.g. don't
   show a "browse by category" UI unless the tenant genuinely has 2+
   categories.
5. Register everything the checklist calls for — flow, action, intent
   keywords, button IDs, flow-passthrough IDs — in one coherent change,
   not partially wired.
6. Write tests per `.ai/development/TESTING.md`.
7. Run `npm test`, confirm zero regressions.
8. Summarize what was added and where, and note anything that needs a
   frontend (`whatsales-frontend`) counterpart change (this repo doesn't
   include the frontend).
