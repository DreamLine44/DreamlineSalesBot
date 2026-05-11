# DreamLine SalesAgent Bot — v12.0 Upgrade Guide

> **Upgrade from:** v11.0  
> **Upgrade to:** v12.0  
> **Files changed:** 6 (no new files, no schema changes, no new dependencies)  
> **Migration required:** None — drop-in replacement

---

## What Was Fixed

This release is a **surgical repair** of the six most impactful issues identified in the system prompt. No architecture was rebuilt. No working systems were touched. Only the specific broken behaviours were corrected.

---

### Fix 1 — AI No Longer Overrides Active Flows

**File:** `services/brainService.js`  
**Problem:** Inside an active ORDER or BOOKING flow, any message of 4+ characters that wasn't an exact-matched intent fell through to `AI_FALLBACK`. This let Groq respond with open-ended chatbot replies while the customer was mid-order — breaking flow context completely.

**What changed:**  
The `AI_FALLBACK` threshold inside active flows was raised from `>= 4 chars` to `>= 10 chars AND not a single word AND genuinely about-the-business`. Short messages, numbers, word-numbers ("twelve", "four"), and single-word inputs now route to `CONTINUE_FLOW` — which passes them directly to the step handler in `flowService` where they belong.

```
Before: "twelve" (len=6) → AI_FALLBACK → Groq interprets it freely
After:  "twelve" (len=6) → CONTINUE_FLOW → QUANTITY step parses it as qty=12
```

---

### Fix 2 — Quantity Step Is Now Fully Protected

**File:** `services/flowService.js`  
**Problem:** The QUANTITY step had `isInteractive` handling that showed a plain text message. Invalid inputs also called Groq for messages as short as 6 characters, creating a path where the AI could misinterpret the input.

**What changed (two sub-fixes):**

**2a — Interactive taps during QUANTITY now return a proper button UI:**
```
Before: "Please *type* a number for the quantity..." (plain text, dead-end)
After:  Button prompt with item name + [❌ Cancel Order] escape hatch
```

**2b — Invalid input threshold raised before calling Groq:**  
Groq is now only called for genuinely conversational, off-topic messages (`>= 10 chars, not a pure digit, not a single word`). Everything shorter falls through to the button nudge prompt — no AI involvement.

When Groq IS called (e.g. customer complains mid-order), the response is now a **two-message array**: the AI answer followed immediately by the quantity re-prompt button. The customer gets their answer AND knows exactly what to do next.

---

### Fix 3 — AI Answers During Active Flows Now Re-Prompt the Step

**File:** `controllers/webhookController.js`  
**Problem:** When `AI_FALLBACK` fired mid-flow and Groq answered successfully, the conversation stopped there. The customer read the AI reply and had no signal of what to do next. They were left mid-flow with no prompt.

**What changed:**  
After the AI reply is dispatched, `handleFlow` is immediately called with the current session to re-show the current step prompt. The customer sees:

```
[AI answer about location / hours / etc.]
[Current step prompt: "How many Domoda would you like? 🛒"]
```

The flow is never left without a clear next action.

---

### Fix 4 — Groq FALLBACK Prompt Is Now Flow-Aware

**File:** `services/groqService.js`  
**Problem:** The `FALLBACK` intent system prompt told Groq to "ask ONE short clarifying question" — making it behave like a general chatbot even when the customer was mid-order.

**What changed:**  
The prompt now injects the `currentFlow` and `currentStep` context:
- If inside a flow: Groq answers the question briefly, then redirects back to the current step
- If no flow: original clarifying behaviour unchanged
- Hard limit: 2 sentences total, never open-ended

---

### Fix 5 — Payment Rejection Uses Button-First UX

**Files:** `services/adminPaymentHandler.js`, `controllers/webhookController.js`  
**Problem:** When an admin rejected a payment proof, the customer received a text message listing options 1/2/3 — old-style UX that violates the WhatsApp button-first design principle.

**What changed:**

**adminPaymentHandler.js:** After sending the rejection text, now also sends a `sendButtonMessage` with three action buttons:
- 📸 Resend Proof  
- 🤝 Contact Support  
- ❌ Cancel Order  

**webhookController.js (STEP 7d):** The `awaiting_rejection_action` handler was rewritten to accept both the new button IDs (`REJECTION_RESEND`, `REJECTION_SUPPORT`, `REJECTION_CANCEL`) and the legacy typed inputs (`1`, `resend`, `support`, `cancel`, etc.) for backward compatibility. Unknown input re-shows the buttons instead of a typed-number reminder.

---

### Fix 6 — dispatch() Now Handles Arrays

**File:** `services/messageService.js`  
**Problem:** `dispatch()` only accepted a single UI object. Fix 2b returns a two-item array `[aiReply, nudgePrompt]` from the QUANTITY step — without this fix it would silently fail.

**What changed:**  
`dispatch()` now checks `Array.isArray(ui)` and iterates sequentially. This is a general improvement — any future handler that needs to send multiple messages in sequence can return an array.

---

## Files Changed (Summary)

| File | Change | Lines |
|------|--------|-------|
| `services/brainService.js` | AI_FALLBACK threshold raised inside active flows | ~10 |
| `services/flowService.js` | QUANTITY isInteractive + invalid input UX + Groq threshold | ~35 |
| `services/groqService.js` | FALLBACK prompt is now flow/step aware | ~6 |
| `services/messageService.js` | dispatch() handles array of UI objects | ~8 |
| `services/adminPaymentHandler.js` | Sends button message after payment rejection | ~15 |
| `controllers/webhookController.js` | awaiting_rejection_action button UX + AI re-prompt | ~55 |

**No other files were changed.**  
**No new dependencies.**  
**No schema migrations.**  
**No environment variables added.**

---

## How to Deploy

```bash
# 1. Replace the old directory with v12
cp -r DreamlineSalesBot_v12/* your-deployment-folder/

# 2. Restart the process (no npm install needed — no new deps)
pm2 restart dreamline   # or your process manager
```

Sessions in-flight at deploy time will continue correctly — the session schema is unchanged and all existing session fields are compatible.

---

## Testing Checklist

Run through these scenarios after deploying to verify all fixes are working:

### Quantity isolation
1. Start an ORDER flow, select "Domoda"
2. When asked for quantity, type `twelve` → should parse as qty=12, NOT menu item #12
3. When asked for quantity, type `2 please` → should parse as qty=2
4. When asked for quantity, type `where are you located?` → should get AI location answer + quantity re-prompt
5. When asked for quantity, tap a button → should show button nudge with [❌ Cancel Order]

### AI boundary during active flows
1. Start an ORDER flow, get to SELECT_ITEM step
2. Type `what time do you close?` → should get brief AI answer + re-prompt for item
3. Type `hi` → should route to CONTINUE_FLOW (not AI)
4. Type `ok` → should route to CONTINUE_FLOW (not AI)

### Payment rejection buttons
1. As admin, reject a payment proof
2. Customer should receive rejection text + button message with 3 options
3. Tap "📸 Resend Proof" → customer put back in PAYMENT_PROOF step
4. Tap "❌ Cancel Order" → session cleared, cancel UI shown
5. Type `1` (legacy) → still works as Resend

### General flow resilience
1. Start ORDER, get to CONFIRM step, type `cancel` → session cleared, cancel UI shown
2. Start ORDER, get to QUANTITY step, type `cancel` → session cleared, cancel UI shown
3. Start ORDER, get to QUANTITY, type `menu` → welcome UI shown (global 0 / SHOW_MENU)

---

## What Was NOT Changed (and Why)

These issues were described in the system prompt but were **already fixed in v11** and working correctly:

- **Quantity confusion (the core bug):** `parseQuantity()` already exists in `flowService.js` with full word-number support, negation guards, and natural language parsing. The QUANTITY step is in `PROTECTED_STEPS` in `brainService.js`, which prevents the brain from misclassifying quantity inputs as menu selections. The remaining gap (AI calling Groq on short inputs) is fixed in v12 Fix 2.

- **Flow interruption system:** Already implemented with `INTERRUPT` step, `pendingIntent`, `previousStep`/`previousFlow` — fully functional.

- **Loop detection:** Already implemented with `loopCount`, `lastLoopMessage`, `lastLoopStep` in both the session model and `flowService`.

- **State persistence:** `sessionService.js` uses atomic MongoDB `findOneAndUpdate` with `$set` — reliable.

- **Button-first UX:** `buildMenuUI`, `buildConfirmUI`, `buildServicesUI`, `buildSmartFallbackUI` all return structured button/list objects — fully WhatsApp native.
