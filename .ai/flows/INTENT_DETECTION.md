# flows/INTENT_DETECTION.md

Source: `core/intents/intentEngine.js`, `core/intents/patterns.js`,
`core/intents/negationGuard.js`.

## Detection order (strict — do not reorder without understanding why each
step exists)

`detectIntent({ message, isInteractive, session, business })` returns
`{ action, intent, confidence: 'HIGH'|'MEDIUM'|'LOW', source, suggestion? }`.

1. **Button / interactive reply ID** — `isInteractive && raw` → look up
   `BUTTON_ID_MAP[upper] || BUTTON_ID_MAP[raw]`. Matched → `confidence: HIGH,
   source: 'button'`. Unmatched interactive ID (a flow-internal step button
   not in the map) → `CONTINUE_FLOW`, not `FALLBACK` — this is intentional,
   the active flow handler is responsible for interpreting its own button
   IDs.
2. **Emoji shortcut** — `EMOJI_MAP` values are raw intents (`ORDER`,
   `BOOKING`, etc.), converted to actions via `intentToAction()`.
3. **Digit / very short (≤1 char)** — always `CONTINUE_FLOW` (treated as a
   quantity or noise, never re-interpreted as a fresh intent).
4. **Exact keyword match** — `INTENT_PATTERNS[intent]` is a flat list of
   normalised exact-match phrases (see `patterns.js`).
   - **4.2 Complaint guard** (`negationGuard.analyzeMessage().complaint`) —
     runs regardless of active flow. Always escalates to `SUPPORT`. Must run
     BEFORE the correction guard (4.6) because complaints often start with
     "actually"/"sorry", which would otherwise misclassify as a correction.
   - **4.4 Cancellation guard** (`.cancelled`) — same "always runs" rule.
     Free-form cancellation phrasing that isn't a literal keyword match.
     Also must precede 4.6 for the same "actually, cancel it" reason.
   - **4.5 Direct ORDER/BOOKING phrase match** — pre-flow only
     (`!session?.currentFlow`). Catches natural language that never uses the
     literal words "order"/"book" ("give me 2 burgers", "table for
     tonight"). `DIRECT_INTENT_EXCLUDE_RE` prevents this from hijacking
     cancel/track/status/refund phrasing. Booking is checked before order
     because "i want" (an order cue) also appears inside "I want to book a
     table."
   - **4.6 Correction/confirmation guard** — in-flow only
     (`session?.currentFlow`). Free-form corrections ("actually, make that
     three") and confirmations ("yeah sure that sounds good") stay owned by
     the active flow instead of falling through to a generic AI reply that
     would derail it. Only reached after 4.2/4.4 so a complaint/cancellation
     starting with a correction-like cue still escapes correctly.
5. **Levenshtein "did you mean?"** — suggestion only, **never auto-executed**.
   `dist <= 2` and length delta `<= 4` to be considered.
6. **Short non-AI fallback** — in-flow, `raw.length < 8` → `CONTINUE_FLOW`
   without ever reaching AI (a short mid-flow reply is virtually always a
   quantity/confirmation). Pre-flow, `raw.length < 4` → `CLARIFY` (if a
   Levenshtein suggestion exists) or `FALLBACK`.
7. **AI classify** — last resort, multi-word non-numeric messages only, and
   **skipped entirely if a flow is already active** (the flow engine handles
   free-text at a later pipeline step instead — running AI classify here
   too would waste a Groq call and risk overriding the flow's own answer).
   `HIGH` confidence → executes the mapped action directly. `MEDIUM`/`LOW`
   → routes to `CLARIFY` (a natural AI reply, not a hard menu dump) instead
   of auto-executing an uncertain guess.
8. **Final fallback** — `CLARIFY` (with suggestion) or `FALLBACK`.

## `intentToAction(intent, business)`

Maps a raw intent string to the action string the router/registry expect
(e.g. `ORDER` → `START_ORDER`, `QUESTION` → `QUESTION` — NOT `ENQUIRY`,
despite how tempting that mapping looks; see the inline comment in
`intentEngine.js` about why `QUESTION` must not collapse into `ENQUIRY`).
Mode-specific intents (`AVAILABILITY_CHECK`, `AFTERCARE`, `SKINCARE_ADVICE`,
`SPEC_REQUEST`, `COLLECTION_SCHEDULE`, `WALKIN`, etc.) are mode-gated in
`getValidIntents(mode)` before the AI is even allowed to return them, and
must have a corresponding entry in this map or they silently degrade to
`FALLBACK`.

## Name extraction (`extractCustomerName`)

Deliberately narrow: only `"my name is X"`, `"call me X"`, `"name's X"`
patterns are trusted. `"I am X"` / `"I'm X"` were removed entirely — they
express state ("I am hungry", "I am here"), not identity, and were the root
cause of a real bug where a customer typing "hi" got their name stored as
"Hi". Every candidate additionally passes:
- letters/spaces only, 3–40 chars total
- an expanded `BAD_NAME_WORDS` blocklist (greetings, filler, commerce
  vocabulary, keyboard noise)
- per-word: length ≥3, must contain a vowel, no single character
  dominating >50% of the word (blocks "Hhhh", "Aaaa")

If you add a new NAME_PATTERN, it must be similarly unambiguous about
expressing identity, not state, and every candidate must go through the
same quality guards.

## `negationGuard.js` — `analyzeMessage(rawMessage)`

Single deterministic pass producing `{ complaint, cancelled, correction,
confirmed }` flags, reused by steps 4.2/4.4/4.6 above so there is exactly
one source of truth for "is this message a complaint / cancellation /
correction / confirmation" rather than each call site re-implementing (and
inevitably drifting from) its own regex.

## `patterns.js` contents

- `BUTTON_ID_MAP` — every button/list-row ID → action string.
- `EMOJI_MAP` — emoji → raw intent string.
- `INTENT_PATTERNS` — exact-keyword lists per intent
  (`CANCEL_ALL`, `CANCEL_ORDER`, `ACKNOWLEDGEMENT`, `GREETING`, `ORDER`,
  `BOOKING`, `REPEAT_ORDER`, `TRACK_ORDER`, `PAYMENT`, `WALKIN`, `SUPPORT`,
  `VIEW_MENU`, `SHOW_MENU`, `MAIN_MENU`, `CAKE_CUSTOMIZATION`,
  `SPEC_REQUEST`, `WARRANTY_INFO`, `AFTERCARE`, `AVAILABILITY_CHECK`,
  `SKINCARE_ADVICE`, `QUESTION`). Note `VIEW_MENU`/`SHOW_MENU`/`MAIN_MENU`
  are deliberately three separate intents/actions, not aliases of one
  another — see `.ai/references/RECURRING_BUG_PATTERNS.md` for why they
  were split.

## When adding a new intent/action

1. Add exact-match keywords to `INTENT_PATTERNS` in `patterns.js` (if it
   should be typeable).
2. Add any button/list-row IDs to `BUTTON_ID_MAP`.
3. Add the intent → action mapping in `intentToAction()`.
4. If AI should be able to return it, add it to `getValidIntents(mode)` for
   the relevant mode(s).
5. Register the action's handler via `registerAction()` in
   `moduleRegistry.js`, or add a `case` in `moduleRouter.js` if it's a
   cross-cutting behavior.
6. If the action is only meaningful inside an active flow, add its
   flow-internal button IDs to `isFlowPassthroughId()` /
   `STEP_VALID_BUTTONS` in `webhookController.js`.
