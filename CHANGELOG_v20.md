# DreamLine SalesBot — v20.0 Changelog (v18 + v19 Merge)

## Overview

v20.0 is the definitive merge of `v18` and `v19_final`. Every fix and feature from both branches is included. The merge strategy was:

- **Base**: `v19_final` (more advanced `flowService`, critical stale-spread fixes, improved brainService)
- **From v18**: `.env.example`, confirmed production `package-lock.json`
- **New in v20**: Professional greeting & welcome system, hardened no-first-message guarantee

---

## What's New in v20.0

### 🎙️ Professional Greeting & Welcome Messages

**Problem**: The default welcome message (`👋 Hi there! Welcome to us. How can we help you today?`) was too casual for professional B2B or service-oriented tenants.

**Fix**: Replaced with a time-of-day-aware, warm-but-professional greeting system:

- **Time-of-day salutation** — "Good morning / Good afternoon / Good evening" based on server time
- **Customer name personalisation** — if the customer's name is known from a previous session, it's included naturally
- **Priority chain**: AI-generated greeting → tenant `welcomePersonalised` label → tenant `welcomeMessage` label → time-aware professional default
- All "Type Order / Type Book" keyword instructions are still stripped (buttons replace them)

**Files changed**: `utils/messageBuilders.js`, `controllers/webhookController.js`

### 🚫 No-First-Message Rule — Explicitly Documented & Verified

The bot **never** initiates a conversation. Confirmed safeguards:

1. `webhookController.js` — `skipTypes` guard skips `message_echo`, `system`, `reaction`
2. `webhookController.js` — Meta echo guard (`context.from === phoneNumberId`)
3. All GREET / welcome responses are triggered **only** by an inbound customer message
4. Scheduler (`schedulerService.js`) only sends WhatsApp-approved **template messages** (abandoned cart, booking reminders, payment reminders) — these are opt-in business-initiated messages permitted by Meta, not cold-start proactive messages

---

## Inherited from v19_final

### Critical Bug Fixes

| Fix | Description |
|-----|-------------|
| **FIX-STALE-SPREAD** | `updateSession` calls for `recommendedThisSession` (recoA/B/C) now always include `data.item` in the spread. Previously, a smart recommendation fired immediately after `data.item` was saved would wipe it — causing the QUANTITY step to reset to the menu. |
| **FIX-WORDS-TO-NUMBER** | Full multi-word number parser (`wordsToNumber`) injected as step 3 in `parseQuantity`. Covers arbitrary word-number phrases: "thousand" → 1000, "five hundred" → 500, "one thousand two hundred" → 1200. |
| **FIX-UPSELL-LEAK** | `UPSELL_COOLDOWN_MAX` evicts oldest entry when map reaches 5000 entries — prevents unbounded memory growth. |

### Brain Service Improvements

| Fix | Description |
|-----|-------------|
| Removed over-broad keywords | `'food'`, `'get'`, `'purchase'` removed from ORDER triggers — too broad, caused false positives on `"do you have food?"` routing to ORDER instead of ENQUIRY |
| Navigation vs cancel split | `"go back"`, `"start over"`, `"restart"` removed from CANCEL — these are navigation intent, not cancellation. Mid-flow "menu"/"go back" now triggers confirm-cancel UI |
| Mid-flow greeting fix | Greetings like `"hi thanks"` mid-flow are treated as `CONTINUE_FLOW` — the customer never accidentally loses their order by saying "hi" |
| Word-number menu shortcuts | `"one"`, `"two"`, `"three"` (+ phonetic variants) work as menu selection shortcuts |

### Webhook Controller Fixes

| Fix | Description |
|-----|-------------|
| Stale session spread | `updateSession({ mode: null })` after `clearSession` removed — redundant DB write |
| Fresh session re-fetch | Session re-fetched before interrupt handling — prevents stale `session.step` |
| REJECT_FLOW routing | Routes to `buildCancelUI` (confirm-cancel) instead of immediately wiping session |
| Step re-prompt | Uses exported `handleStepReprompt()` directly instead of passing `''` to `handleFlow` |

---

## Inherited from v18

### Features

| Feature | Description |
|---------|-------------|
| **LARGE-QTY confirm flow** | Orders > 20 units prompt a YES/CHANGE confirmation before proceeding |
| **QTY_LARGE_CONFIRM / QTY_LARGE_CHANGE** | Interactive button handlers for large-order confirmation |
| **Groq capability-aware CTA** | AI greeting CTA no longer hardcodes "order/book" — respects tenant capabilities |
| **Payment session anchoring** | `orderId` is anchored to session for precise proof lookup, preventing cross-customer collisions |
| **Tests** | Full `tests/nlp.test.mjs` suite included |
| **`.env.example`** | Minimal env var reference file |

---

## Files Changed vs v19_final

| File | Change |
|------|--------|
| `utils/messageBuilders.js` | Time-of-day professional default welcome message |
| `controllers/webhookController.js` | Overhauled GREET handler with priority chain + time-of-day greeting |
| `package.json` | Version bumped to `20.0.0`, description updated |
| `services/flowService.js` | Version comment updated |
| `.env.example` | Added from v18 |
| `CHANGELOG_v20.md` | This file |

---

## No-Breaking-Changes Guarantee

v20.0 is a drop-in replacement for both v18 and v19. No database migrations, no schema changes, no new environment variables required. Tenant `welcomeMessage` and `welcomePersonalised` labels override the new defaults — existing customisations are fully respected.
