# references/RECURRING_BUG_PATTERNS.md

This project has been through many audit passes. These are the bug CLASSES
that recurred (sometimes more than twice, in different files) across that
history. When you touch adjacent code, proactively check for these — don't
wait for a bug report.

## 1. Undeclared Mongoose schema field → silent data loss

**Pattern:** application code reads/writes `some.field` on a Mongoose
document; `some.field` is never declared in that model's schema. `strict`
mode discards the write with zero error. Symptoms show up far from the
write site — a feature "sometimes doesn't save," a customer's cart
"randomly empties," a customer's variant selection "doesn't stick."

**Known past instances:** `pendingCatalogQueue`/`multiItemCart` (WA
Catalog), `menuItems[].variants`, `BusinessConfig.address`,
`customMessages.reopened`.

**Prevention:** Rule 1 in `.ai/README.md`. Grep the model before writing a
new field.

## 2. Enum missing a value → silent write-as-null or swallowed ValidationError

**Pattern:** same failure family as #1 but for `enum: [...]` constraints.
`Session.currentFlow`'s schema literally has an inline maintenance-rule
comment about this because it recurred enough to warrant a permanent
warning baked into the schema file itself.

**Prevention:** Rule 2 in `.ai/README.md`.

## 3. "Built but never wired" — a fully-implemented module with no caller

**Pattern:** a service/flow module is completely implemented, exports
correct functions, even has comments describing where it's "supposed" to
be called from — but the actual call site was never added, or was removed
during a refactor and never restored. Found via grep: exported function
with zero call sites outside its own file/tests.

**Known past instances:** the entire WA Catalog `START_ORDER` integration
(`offerCatalogOnStartOrder` existed and was fully correct, but
`moduleRegistry.js` never called it); emotion detection, intent
classification, usage tracking (`incrementTenantUsage`), and audit logging
(`logAudit`) were all implemented service modules sitting disconnected from
the live message pipeline until an audit pass wired each one in.

**Prevention:** when you finish implementing a new function meant to be
called from the pipeline, grep for its name across the codebase before
considering the task done — a hit count of 1 (its own definition) means it
isn't actually running.

## 4. Per-section limit assumed instead of per-message-total limit (Meta API)

**Pattern:** Meta's interactive list (10 rows) and product_list (30 items)
caps are message-TOTAL, not per-section. Code that assumes per-section and
chunks/paginates within that wrong assumption produces a payload that looks
correct locally but gets a hard 400 from the Graph API once real data
crosses the true combined limit.

**Prevention:** enforced centrally in `dispatcher.js`'s `buildPayload()` —
see `.ai/whatsapp/DISPATCHER_AND_LIMITS.md`. Don't reintroduce a
caller-side truncation that assumes a different (wrong) ceiling.

## 5. Truthy-but-failed return value defeats a caller's fallback logic

**Pattern:** a function that's supposed to signal failure returns something
technically truthy on failure (e.g. the raw non-ok `Response` object from a
failed `fetch`), and a caller checking `if (result)` treats a failure as a
success and skips its own fallback/retry path.

**Known past instance:** `dispatchMessage()` used to propagate a Meta 4xx/
5xx `Response` object; `sendCatalogMessage()` and similar callers treated
any truthy return as "delivered." Fixed by making `dispatchMessage()`
explicitly return `null` on any Meta error response.

**Prevention:** functions with a "did this actually succeed?" contract
should return `null`/`false`/`undefined` on failure, never a technically-
truthy error object, and callers should be written assuming failure is
communicated via falsiness, not via inspecting the shape of the result.

## 6. Nested-object `$set` silently replaces (doesn't merge) a subdocument

**Pattern:** `findOneAndUpdate(filter, { $set: { someNestedObject: {...} }})`
with a plain (non-dot-path) object REPLACES the whole subdocument in
MongoDB — it does not merge sibling fields, even though Mongoose applying
schema defaults on the document read might make it look like it does.

**Known past instance:** `updateBusinessConfig()` accepting
`{ waCatalog: { catalogId: 'X' } }` wiped `enabled`/`mode` that had been
set moments earlier by a separate partial update.

**Prevention:** flatten nested-object updates into dot-notation keys
(`waCatalog.catalogId`) before the `$set`, so each leaf field updates
independently. See `tests/waCatalogPartialUpdate.test.mjs` for the
canonical fix pattern.

## 7. Server-local time used where business-local time was required

**Pattern:** `new Date().getDay()` / similar resolves the WEEKDAY (or hour)
in the server process's timezone, not the tenant's configured business
timezone — wrong specifically near timezone boundaries where the two
disagree on what day/hour it currently is.

**Known past instance:** day-specific business-hours overrides resolving
against server/UTC weekday instead of the business's configured timezone.

**Prevention:** use `Intl.DateTimeFormat('en', { timeZone: business.hours.timezone,
weekday: 'long' })` (or equivalent) anywhere "what day/hour is it for this
business right now" matters — never the server's raw `Date` getters. See
`tests/businessHours.test.mjs` for the exact testing technique (pick a
tz far enough from the server's to force disagreement, rather than trying
to mock the clock).

## 8. Route/collision shadowing from mount order or generic action mapping

**Pattern:** a more specific route/case is registered AFTER a broader
catch-all that already matches the same path/action, so the specific
handler is unreachable — or two different concepts get collapsed onto one
action/intent name and the more specific one is starved of its own
identity.

**Known past instances:** `/admin/tenants` vs. broad `/admin` mount order
in `app.js`; `SHOW_MENU` vs. `VIEW_MENU` vs. `MAIN_MENU` — these three used
to collapse onto one action, so a customer tapping "📋 View Menu" got the
generic "Start Over" reset instead of the actual menu, and a customer
typing "main menu" hit the product list instead of the two-step welcome
sequence. Now three deliberately distinct actions.

**Prevention:** when two things are conceptually different from a
customer's point of view ("show me the product list" vs. "reset me to the
top" vs. "take me to the main welcome screen"), keep them as distinct
actions even if their current implementations happen to look similar —
collapsing them for DRYness is what caused this bug class.

## 9. Double DB round-trip disguised as "just being careful"

**Pattern:** a write followed immediately by an unnecessary read-back of
the same document, when the write operation (`findOneAndUpdate(...,
{ new: true })`) already returns the fresh document. Not a correctness bug,
but a recurring performance smell worth removing when you touch the code
anyway (`flowEngine.startFlow()` had exactly this, on the hot tap-to-reply
path).

## 10. A booking/order cancellation cleared session state but left the DB
record active

**Pattern:** a "cancel" UX gives the customer an immediate friendly
confirmation by resetting session fields, but the actual `Booking`/`Order`
document's `status` is never updated — so the record resurfaces as "still
active" on the customer's very next message.

**Known past instance:** this was fixed, then a subsequent botched edit
literally merged a guarding `if (...) {` into a comment via a stray literal
`\n` instead of a real newline — so the fix silently stopped running for a
period. Now consolidated into `flowEngine.cancelFlow()` so every caller
gets it for free instead of each remembering to implement it separately.

**Prevention:** any new "cancel"-shaped UX must go through
`flowEngine.cancelFlow()` rather than hand-rolling its own session reset.
