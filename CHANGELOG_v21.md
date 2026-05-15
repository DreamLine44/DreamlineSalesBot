# DreamLine SalesBot — v21.0 Changelog (v19 + v20 Merge)

## Overview

v21.0 is the definitive merge of `v19_final` and `v20_merged`. All bug fixes, features,
and improvements from both branches are included. The merge strategy was:

- **Base**: `v20_merged` (already contained v18 + v19 features)
- **New in v21**: Professional communication overhaul — all customer-facing messages
  audited and upgraded to warm, professional language suitable for B2B and
  service-oriented businesses.

---

## What's New in v21.0

### ✅ No-First-Message Rule — Fully Enforced

The bot **never** initiates a conversation. All four safeguards confirmed:

1. `webhookController.js` — `skipTypes` guard skips `message_echo`, `system`, `reaction`
2. `webhookController.js` — Meta echo guard (`context.from === phoneNumberId`)
3. All GREET / welcome responses are triggered **only** by an inbound customer message
4. Scheduler (`schedulerService.js`) sends only WhatsApp-approved **template messages**
   (abandoned cart, booking reminders, payment reminders) — opt-in business-initiated
   messages permitted by Meta, not cold-start proactive messages

### 🎙️ Professional Communication Overhaul

Every default customer-facing message has been reviewed and upgraded:

| Location | Before | After |
|----------|--------|-------|
| `webhookController.js` — greeting reset | `Sure! Here's the main menu 👇` | `Of course! Here is the main menu:` |
| `webhookController.js` — greeting reset (returning customer) | `👋 Welcome back! Here's what you can do:` | `Welcome back! Here is what we can help you with:` |
| `webhookController.js` — SHOW_MENU navigation | `Sure! Taking you back to the main menu 👇` | `Certainly! Returning you to the main menu.` |
| `webhookController.js` — GREET time-of-day fallback | _(already professional from v20)_ | Unchanged — kept as-is |
| `utils/messageBuilders.js` — `buildOptionsUI` | `How can we help you today? Please choose an option below 👇` | `How may we assist you today? Please select an option below.` |
| `utils/messageBuilders.js` — `buildOptionsUI` fallback text | `How can we help?` | `How may we assist you?` |
| `utils/messageBuilders.js` — `buildAnswerUI` enquiry prompt | `Sure — what would you like to know? 😊 … Just type your question below 👇` | `Of course — what would you like to know? … Please type your question below.` |
| `utils/messageBuilders.js` — `buildEnquiryUI` | `Sure! 😊 What would you like to know? … Just type your question and I'll do my best to help. … Or use the buttons below to get started 👇` | `Certainly! What would you like to know? … Please type your question and we will do our best to assist you. … Or use the options below to get started:` |
| `utils/messageBuilders.js` — capability fallback | `How can I help you? Type *0* to see options.` | `How may we assist you? Type *0* to see all options.` |
| `services/flowService.js` — booking start | `Sure! Let's set up your booking 📅 … What *date* would you like?` | `We'd be happy to arrange a booking for you. 📅 … Please provide your preferred *date*:` |
| `services/flowService.js` — `startBookingFlow` | `Sure 👍 … [prompt]` | `We'd be happy to assist with your booking. … [prompt]` |

**Principles applied:**
- Replace first-person singular ("I'll", "I can") with first-person plural ("we will", "we can")
- Remove casual exclamations ("Sure!", "Sure 👍", "Oops")
- Replace directional emojis like `👇` used as punctuation
- Retain functional emojis (📅 for dates) where they aid clarity
- Soften imperative commands ("type your question") → polite invitations ("please type your question")
- Keep messages concise — no added verbosity

---

## Inherited from v20_merged

### Professional Greeting & Welcome Messages (from v20)

- Time-of-day salutation: "Good morning / Good afternoon / Good evening"
- Customer name personalisation when known from a prior session
- Priority chain: AI-generated greeting → tenant `welcomePersonalised` label →
  tenant `welcomeMessage` label → time-aware professional default

### Critical Bug Fixes (from v19)

| Fix | Description |
|-----|-------------|
| **FIX-STALE-SPREAD** | `updateSession` calls for `recommendedThisSession` always include `data.item` in the spread |
| **FIX-WORDS-TO-NUMBER** | Full multi-word number parser covering "thousand", "five hundred", "one thousand two hundred" |
| **FIX-UPSELL-LEAK** | `UPSELL_COOLDOWN_MAX` evicts oldest entry when map reaches 5000 entries |

### Brain Service Improvements (from v19)

- Removed over-broad ORDER keywords (`food`, `get`, `purchase`)
- Navigation vs cancel split — "go back", "start over" no longer trigger CANCEL
- Mid-flow greeting fix — "hi thanks" mid-flow treated as `CONTINUE_FLOW`
- Word-number menu shortcuts — "one", "two", "three" work as selection shortcuts

### Features (from v18 via v20)

- LARGE-QTY confirm flow for orders > 20 units
- Groq capability-aware CTA
- Payment session anchoring
- Full `tests/nlp.test.mjs` suite

---

## No-Breaking-Changes Guarantee

v21.0 is a drop-in replacement for v19 and v20. No database migrations, no schema
changes, no new environment variables required. Tenant `welcomeMessage` and
`welcomePersonalised` labels continue to override all defaults.
