# business/SESSION_RULES.md

## Session TTL rules (`core/sessions/sessionService.js`)

`resolveTTL(step, humanMode)`, priority highest → lowest:
1. `humanMode === true` → 24h (`HUMAN_MODE_SESSION_TTL_HOURS`, default 24).
   Deliberately long so an overnight admin-handled conversation doesn't
   silently expire and auto-resume the bot mid-conversation.
2. `step` is a payment step (`PAYMENT_PROOF`, `PAYMENT_CONFIRM`,
   `AWAITING_PAYMENT`) → 4h (`PAYMENT_SESSION_TTL_HOURS`, default 4). Wave
   payments in West Africa often take 30–90 minutes; the old 30-minute TTL
   was expiring sessions before the customer could send their screenshot.
3. Default → 30 min (`SESSION_TTL_MINUTES`).

`humanMode` semantics:
- `humanMode: false` is the default and is **never reset to `false`** by
  `createSession()`'s upsert unless explicitly passed — a session expiring
  (30-min TTL) while a customer is in human-takeover mode must not silently
  flip the bot back on. `$setOnInsert` only sets `humanMode: false` for
  genuinely brand-new documents; re-created sessions preserve whatever
  `humanMode` value already existed.
- `humanModeNotified` is similarly preserved on `$setOnInsert` only — so a
  TTL expiry can't trigger a duplicate "customer needs a human" admin alert.
- `updateSession()` recomputes TTL not just when `step`/`currentFlow`
  change, but also whenever `humanMode` itself is being toggled. When a
  patch changes `step`/`currentFlow` WITHOUT mentioning `humanMode` (e.g.
  an admin confirming/rejecting an order, which always resets
  `currentFlow: null, step: null`), the function looks up the session's
  *existing* `humanMode` from the DB rather than assuming `false` — this
  matters because assuming `false` would silently collapse a 24h
  human-mode TTL back to 30 minutes on any admin action.

## `postFlowAck` / `postFlowData`

Set by `flowEngine.completeFlow()` after a flow finishes, and by admin
actions (order/booking confirm/reject/ready). Consumed and cleared by
`services/postFlowHandler.js` at the top of `handlePostFlowMessage()` —
see `.ai/flows/POST_FLOW.md` for the full state machine. On a brand-new
session document (post-TTL-expiry re-creation), `createSession()`
explicitly clears both rather than inheriting stale values from the expired
doc — MongoDB's `$set` only touches fields it lists, so an omission here
would let a stale ack context leak into a customer's first message of an
entirely new conversation.

## No-name greeting policy (`[NO-MEMORY-2]`)

The `GREET` case does **not** personalize the opening message with the
customer's name pulled from cross-session memory
(`core/memory/customerMemory.js`), even for returning customers — this is a
deliberate product decision, not a bug. Name capture and mid-conversation
use of the customer's name (e.g. "Thanks, Lamin!" later in a flow) is still
intact; only the very first greeting avoids it, to sidestep an unsolicited-
familiarity feel. If you touch `GREET`, do not "helpfully" add name
personalization back in.

## Key product rules FT enforces strictly

These are explicit product decisions, not omissions — do not add them back
in as a "feature" without checking with the project owner first:

- **No** upselling, cross-selling, or personalized recommendations beyond
  what a customer explicitly asks about.
- **No** loyalty features, wishlist, "trending"/"best-sellers", or
  "new arrivals" — none of these exist, and none should be fabricated from
  data the platform doesn't actually track.
- **No fabricated data signals of any kind.** Every UI element that implies
  a claim ("popular," "5 left in stock," "new") must be backed by real
  tenant data or must not be shown at all.
- Features must be **gated on real tenant data** — e.g. category-first
  browsing only appears when a tenant actually has 2+ real categories in
  their menu; it must not render an empty or single-category "browse by
  category" experience just because the vertical supports it.
- The bot must **not** mention the customer by name in the initial greeting
  (see above).

## Practical implication for future work

If a feature request implies inventing a badge, ranking, or personalization
signal the platform doesn't already compute from real data, flag it rather
than implementing a plausible-looking fake — this project's whole audit
history is about eliminating exactly this class of "looks right, isn't
real" behavior.
