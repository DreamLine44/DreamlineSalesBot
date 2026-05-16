# DreamlineSalesBot v20.0 — Perfect Merge (v14 + v18 + v19_final)

## What this is
A clean, conflict-free merge of all three versions plus two targeted professional UX improvements.

---

## v20.0 changes (this merge)

### Files taken from v19_final

| File | Why v19_final wins |
|------|--------------------|
| `services/flowService.js` | v19.0: CRITICAL FIX-STALE-SPREAD (quantity reset after smart recommendation), full multi-word number parser (`wordsToNumber`), large-order confirmation (qty > 20), AI fallback at SELECT_ITEM also returns interactive menu |
| `services/brainService.js` | CRITICAL mid-flow GREETING fix (saying "hi" mid-order no longer wipes the session), word-number menu shortcuts ("one"/"two"/"three"), removed false-positive ORDER keywords (`food`, `get`, `purchase`), "go back"/"start over" correctly treated as navigation not cancellation |
| `utils/phraseEngine.js` | `detectNumber()` now resolves word-numbers and embedded digits, not just plain integers |
| `services/paymentService.js` | PAY-F4: `sessionOrderId` parameter for precise `_id`-anchored proof lookup — prevents cross-customer proof collisions |
| `tests/nlp.test.mjs` | +13 new tests (sections 7 & 8); 69 total, 0 failures |
| `CHANGELOG_v18.md` | Added |

### Files taken from merged_final (v19 merge) — these were better

| File | Why merged_final wins |
|------|-----------------------|
| `services/groqService.js` | v13.0: prompt-injection sanitization, HUMAN_ESCALATION intent, real multi-turn conversation history (G-1), 12 s timeout (G-7), max_tokens 280 for ENQUIRY, dynamic currency |
| `services/adminPaymentHandler.js` | Has RESUME BOT admin WhatsApp command + AES-256 token decryption |
| `services/templateService.js` | Template names overridable via env vars (`TEMPLATE_NAME_*`) |
| `app.js` | Graceful shutdown on SIGTERM/SIGINT (closes MongoDB, stops scheduler) |
| `services/schedulerService.js` | SC-1 batched DB lookups, SC-2 booking date fix, SC-3 48h window, SC-4 `allSettled`, SC-5 startup log |
| `models/Booking.js` | customerName + partySize + admin confirmation workflow + parsedDate |
| `utils/sanitize.js` | Prompt-injection sanitizer |
| `tests/v18.test.mjs` | Additional test suite |

### Fixes applied from v19_final to merged_final base

| File | Fix applied |
|------|-------------|
| `controllers/webhookController.js` | FIX-WEBHOOK-CLEARSES: removed redundant `updateSession({ mode: null })` before `clearSession()` |
| `controllers/webhookController.js` | REJECT_FLOW now routes to `buildCancelUI` instead of creating a new session and showing welcome |
| `controllers/webhookController.js` | Step reprompt uses exported `handleStepReprompt()` instead of calling `handleFlow('', ...)` |
| `services/groqService.js` | FIX-GROQ-CTA: `STRICT_GROQ_RULE` now builds `ctaKeywords` dynamically — booking-only businesses never see "Type *order*" |

---

## Professional communication fixes (v20 new)

The bot **never** initiates contact. All messages are responses to customer-initiated webhook events.
The scheduler templates (abandoned cart, booking reminder, payment reminder) are follow-ups to
customer-initiated transactions — not cold outreach.

### Specific message changes

| Location | Before | After |
|----------|--------|-------|
| `utils/messageBuilders.js` — default welcome | `👋 Hi there! Welcome to *Name*. How can we help you today?` | `Welcome to *Name*.\n\nHow may we assist you today?` |
| `utils/messageBuilders.js` — cancel acknowledgement | `No worries at all! 😊\n\nYour request has been cancelled. Whenever you're ready, we're here to help.\n\n*Biz* — happy to assist you anytime.` | `Your request has been cancelled.\n\nFeel free to reach out whenever you're ready — we're happy to help.` |
| `webhookController.js` — greeting reset double-message | `Sure! Here's the main menu 👇` + welcome UI | Welcome UI only (single clean response) |
| `webhookController.js` — SHOW_MENU double-message | `Sure! Taking you back to the main menu 👇` + welcome UI | Welcome UI only |
| `webhookController.js` — humanMode handoff | `👤 You're now chatting with our team directly. Thanks for your patience! 😊` | `Your message has been received. A member of our team will respond to you shortly.` |
| `webhookController.js` — SUPPORT action | `🤝 *Support*\n\nI've flagged your message…🙏` | `*Support Request Received*\n\nYour message has been noted and forwarded to our team. A team member will respond to you shortly.` |

> **Owner override:** Any default message can be overridden via `businessConfig.labels` (e.g. `welcomeMessage`, `cancelMsg`, `humanMode`) without code changes.

---

## No-initiation guarantee

The codebase has zero proactive first-contact messages. Every `dispatch()` call is inside a
webhook event handler that only runs because the customer sent a message first. The comment
on line 403 of `webhookController.js` documents this explicitly:

> `// NOTE: the bot NEVER sends a message unless the customer wrote first.`
> `// There are zero proactive / unsolicited messages in this codebase.`

