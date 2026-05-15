# DreamLine SalesBot — v18.0 Changelog

## Summary
v18 is the definitive combined release merging all v16 and v17 features, with two new
critical bug fixes not present in either version.

---

## 🐛 Critical Bug Fixes (NEW in v18)

### [FIX-STALE-SPREAD] Quantity input resets flow to menu after recommendation fires
**File:** `services/flowService.js`
**Symptom:** Customer selects an item (e.g. Benachin Chicken), receives a smart
recommendation (Tapalapa pairing), then types any quantity (e.g. `15`, `two`, `5`) —
the bot responds with the menu again instead of proceeding to the order summary.

**Root cause:** Three `updateSession` calls for `recommendedThisSession: true` all used
`{ ...session.data, recommendedThisSession: true }`. Because `session.data` is the
in-memory snapshot from *before* the item was stored, spreading it would overwrite
`data.item` back to `undefined` in MongoDB. The QUANTITY handler then found
`session.data?.item === undefined` and reset to the menu.

**Fix:** All three reco writes now include the item variable:
- `recoA`: `{ ...session.data, item: selected, recommendedThisSession: true }`
- `recoB`: `{ ...session.data, item, recommendedThisSession: true }`
- `recoC`: `{ ...session.data, item: name, recommendedThisSession: true }`

**Affected paths:** suggestion-confirm flow (recoA), numeric index selection (recoB),
text/fuzzy name selection (recoC). All three are fixed.

---

## ✅ v16 Fixes Applied to v17 Base

### [FIX-WORDS-TO-NUMBER] Multi-word number phrases not understood
**File:** `services/flowService.js`
**Symptom:** Typing `thousand`, `five hundred`, `one thousand two hundred` at any
quantity prompt returned the "I'm not sure" error.

**Fix:** `wordsToNumber()` function added — a full additive parser that handles
arbitrary word-number phrases. Injected as step 3 in `parseQuantity()`, after
`PHRASE_NUMBERS` and `WORD_NUMBERS` checks.

Examples now working:
| Input | Result |
|-------|--------|
| `thousand` | 1000 |
| `five hundred` | 500 |
| `one thousand two hundred` | 1200 |
| `five hundred thousand` | 500000 |
| `a hundred` | 100 |
| `ninty two` | 92 |

### [FIX-GROQ-CTA] Booking-only businesses shown incorrect CTA
**File:** `services/groqService.js`
**Fix:** `STRICT_GROQ_RULE` now builds `ctaKeywords` dynamically from `canOrder`/`canBook`
flags. Booking-only businesses no longer see "Type *order* to continue."

### [FIX-BRAIN-SHORTCUTS] Menu shortcuts didn't accept word-numbers
**File:** `services/brainService.js`
**Fix:** Main menu shortcuts (1/2/3) now accept word equivalents: "one" → Order,
"two" → Booking, "three" → Enquiry.

### [FIX-BRAIN-FALSEPOS] False-positive ORDER intent on generic words
**File:** `services/brainService.js`
**Fix:** Removed `'food'`, `'get'`, `'purchase'` from ORDER intent keywords. These were
too broad and matched natural questions like "do you have food?" as order intents.

### [FIX-PHRASE-ENGINE] detectNumber ignored word-numbers
**File:** `utils/phraseEngine.js`
**Fix:** `detectNumber()` now checks `_PE_WORD_NUMS` lookup and embedded digit regex
before returning null, so "three", "ninty", "twenty" are correctly detected as numbers.

### [FIX-PAYMENT-SESSION] Cross-customer proof collision risk
**File:** `services/paymentService.js`
**Fix:** `receiveProof()` now accepts `sessionOrderId` parameter. When provided, uses
`_id`-anchored lookup instead of time-range query, preventing proof from attaching to
the wrong order when two customers of the same tenant submit proofs simultaneously.

### [FIX-WEBHOOK-CLEARSES] Redundant DB write before clearSession
**File:** `controllers/webhookController.js`
**Fix:** Removed `updateSession({ mode: null })` immediately before `clearSession()`.
`clearSession` already removes all fields; the prior write was a wasted round-trip.

---

## Features Carried From v17 (unchanged)

- **Large-order confirmation** (`qty > 20`): `QTY_LARGE_CONFIRM` / `QTY_LARGE_CHANGE`
  button flow with price total display
- **UPSELL_COOLDOWN_MAX** eviction: map capped at 5000 entries, no memory leak
- **Item images** sent before quantity prompt (non-blocking)
- **AI fallback at SELECT_ITEM** for conversational off-topic messages
- **Payment retry tracking** with human-support escalation after 3 failed uploads
- **Session TTL tuning** via `.env`: `SESSION_TTL_MINUTES`, `PAYMENT_SESSION_TTL_HOURS`
- **Token encryption** (AES-256-GCM) for WhatsApp access tokens at rest
- **Scheduler on/off** via `SCHEDULER_ENABLED` env flag

---

## Test Results
```
69 passed, 0 failed out of 69 total ✅
```
Run with: `node tests/nlp.test.mjs`

---

## Files Changed in v18

| File | Changes |
|------|---------|
| `services/flowService.js` | FIX-STALE-SPREAD (3 lines), FIX-WORDS-TO-NUMBER (wordsToNumber added), version header |
| `services/groqService.js` | FIX-GROQ-CTA (capability-aware ctaKeywords) |
| `services/brainService.js` | FIX-BRAIN-SHORTCUTS (word-number menu), FIX-BRAIN-FALSEPOS |
| `services/paymentService.js` | FIX-PAYMENT-SESSION (sessionOrderId param) |
| `utils/phraseEngine.js` | FIX-PHRASE-ENGINE (detectNumber word support) |
| `controllers/webhookController.js` | FIX-WEBHOOK-CLEARSES (remove redundant write) |
| `tests/nlp.test.mjs` | +13 new tests (sections 7 & 8) |
| `package.json` | version → 18.0.0 |
| `CHANGELOG_v18.md` | this file |
