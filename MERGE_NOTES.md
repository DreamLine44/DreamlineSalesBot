# DreamLine SalesBot — Final Merged Version (v11 + v7 + v12)

## Lineage

| Source | Contribution |
|--------|-------------|
| `DreamlineSalesBot_final` (v11) | Base: multi-tenant MongoDB, ESM, Groq AI, 10 industry modes, analytics, scheduling, smart recommendations, payment service, circuit breaker, dedup, lead capture |
| `DreamlineSalesBot_v7_merged` (v7) | Strict deterministic intent engine philosophy (ported into brainService) |
| `DreamlineSalesBot_v12` (v12) | 6 surgical fixes — see below |

---

## Files Changed vs `DreamlineSalesBot_final` (v11 base)

| File | Source | What changed |
|------|--------|--------------|
| `services/brainService.js` | v7 + v12 | Full intent engine rewrite (v7 strict rules) + Fix 1: AI threshold raised inside flows |
| `services/flowService.js` | v12 | Fix 2: QUANTITY step button UX + AI threshold raised to 10 chars |
| `services/groqService.js` | v12 | Fix 4: FALLBACK prompt is flow/step-aware |
| `services/messageService.js` | v12 | Fix 6: dispatch() handles arrays |
| `services/adminPaymentHandler.js` | v12 | Fix 5: payment rejection sends button message |
| `controllers/webhookController.js` | v12 | Fix 3: AI mid-flow re-prompts current step; Fix 5: rejection buttons |

---

## AI Behaviour Rules — The Core Contract

### When AI is NEVER called
- Inside PROTECTED steps (`DATE`, `DATE_CONFIRM`, `TIME`, `TIME_CONFIRM`, `QUANTITY`, `SELECT_ITEM`, `SELECT_SERVICE`, `CONFIRM`, `INTERRUPT`, `PAYMENT_PROOF`, `UPSELL`)
- For any button tap (button ID match → instant action, zero AI)
- For the "0" shortcut (→ SHOW_MENU)
- For greetings (→ GREET)
- For emojis (→ intent action)
- For number shortcuts outside flows (1/2/3 → Order/Book/Question)
- For rejection phrases (→ CLARIFY or REJECT_FLOW)

### When AI is called inside an active flow
Only when ALL three conditions are true:
1. Message length ≥ 10 characters
2. Not a pure digit string
3. Not a single word (≤ 6 chars)

This prevents "twelve", "ok", "four", "yes", "2 pls" from hitting Groq and being misinterpreted.

### After AI answers mid-flow
The current step prompt is always re-sent immediately after the AI reply. The customer gets their answer AND a clear next action. The flow is never left hanging.

### Groq FALLBACK prompt is flow-aware
If inside a flow: AI answers the question in 1 sentence then redirects to the current step. Never open-ended. If no flow: original clarifying behaviour.

---

## Intent Engine Priority Stack

| # | Input | Result |
|---|-------|--------|
| 1 | Echo / dedup guard | IGNORE |
| 2 | Button ID match | Instant action — zero AI |
| 3 | "0" shortcut | SHOW_MENU |
| 4 | Greeting regex | GREET — even inside active flows |
| 5 | Emoji | Intent → action (only outside flows) |
| 6 | Number shortcuts | 1/2/3 → Order/Book/Question (outside flows) |
| 7 | Rejection phrase | CLARIFY or REJECT_FLOW |
| 8 | **Active flow** | **Flow rules below** |
| 9 | Strict exact match | Triggers flow — no AI |
| 10 | Levenshtein ≤ 3 | SUGGEST only — never execute |
| 11 | About-question | AI info only |
| 12 | Long unknown (≥ 4) | AI_FALLBACK + CTA options |
| 13 | Short unknown | CLARIFY → buttons |

### Active Flow Rules

**PROTECTED steps** (`DATE`, `DATE_CONFIRM`, `TIME`, `TIME_CONFIRM`, `QUANTITY`, `SELECT_ITEM`, `SELECT_SERVICE`, `CONFIRM`, `INTERRUPT`, `PAYMENT_PROOF`, `UPSELL`):
- Only CANCEL and CONFIRM escape
- PAYMENT_PROOF step also allows payment queries → AI_PAYMENT_HELP

**Other active-flow steps**:
- CANCEL / CONFIRM / SHOW_MENU — always escape
- QUESTION → ENQUIRY (non-destructive)
- PAYMENT → AI_PAYMENT_HELP (non-destructive)
- TRACK_ORDER → track info
- Different flow intent → INTERRUPT (user must confirm — never auto-switch)
- AI_FALLBACK only when length ≥ 10 AND not a digit AND not a single word
- Everything else → CONTINUE_FLOW (flowService handles it natively)

---

## Setup

```bash
npm install
cp .env.development.local.example .env
# Fill: MONGODB_URI, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
#       META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, GROQ_API_KEY
node seed.js   # Seed a demo tenant
node app.js    # Start server
```
