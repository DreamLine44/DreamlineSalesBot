/**
 * services/brainService.js — Dreamline Sales Bot v10.0
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  STRICT DETERMINISTIC INTENT ENGINE                             ║
 * ║                                                                 ║
 * ║  Priority:                                                      ║
 * ║  1. Button ID / number shortcut  → exact, instant               ║
 * ║  2. Strict exact phrase match    → only exact matches trigger   ║
 * ║  3. Similarity suggestion        → suggest ONLY, never execute  ║
 * ║  4. Defensive Groq AI fallback   → controlled, no flow triggers ║
 * ║                                                                 ║
 * ║  RULES:                                                         ║
 * ║  - NO fuzzy matching triggers flows                             ║
 * ║  - NO AI guessing triggers flows                                ║
 * ║  - Groq ONLY answers safely, always ends with options menu      ║
 * ║  - Every decision is logged: raw, normalized, intent, flow      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import levenshtein                                                    from 'fast-levenshtein';
import { trackUser }                                                  from './learningService.js';
import { getModeConfig, getModeRestrictionMessage }                   from '../config/modes.js';
import { buildInterruptUI }                                           from '../utils/messageBuilders.js';
import { isAboutQuestion }                                            from './groqService.js';
import { updateSession }                                              from './sessionService.js';
import logger                                                         from '../config/logger.js';

// ─── Normalization layer ──────────────────────────────────────────────────────

export const normalizeInput = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

const tokenize = (text) => text.split(' ').filter(Boolean);

// ─── Strict intent config ─────────────────────────────────────────────────────
//
// ONLY these exact strings (after normalization) trigger flows.
// Similarity detection uses Levenshtein ONLY to suggest — NEVER to execute.

const STRICT_INTENTS = {
  ORDER:    ['order', 'order now', 'buy', 'i want to order', 'place order',
             'i want food', 'get food', 'order food', 'i want to buy'],
  BOOKING:  ['book', 'book service', 'book now', 'reserve', 'appointment',
             'i want to book', 'make a booking', 'book a table', 'make appointment'],
  QUESTION: ['question', 'ask', 'ask question', 'enquiry', 'enquire',
             'i have a question', 'i want to ask', 'i need help', 'help',
             'what', 'how', 'info', 'about', 'hours', 'location', 'address',
             'contact', 'price', 'cost', 'open', 'close'],
  CONFIRM:  ['yes', 'ok', 'okay', 'confirm', 'yep', 'sure', 'yup', 'yeah',
             'go ahead', 'sounds good', 'correct', 'proceed'],
  CANCEL:   ['cancel', 'stop', 'exit', 'quit', 'no', 'nope', 'nah',
             'never mind', 'nevermind', 'forget it', 'i changed my mind'],
  GREETING: ['hi', 'hello', 'hey', 'start', 'begin', 'good morning',
             'good afternoon', 'good evening', 'howdy'],
  SHOW_MENU:['menu', 'options', 'home', 'main menu', 'back', '0', 'restart',
             'show menu', 'show options', 'go back', 'main'],
  PAYMENT:  ['payment', 'pay', 'wave', 'how to pay', 'how do i pay',
             'total', 'amount', 'wave payment', 'send payment'],
};

// Rejection phrases — NEVER trigger any flow
const REJECTION_PHRASES = [
  "don't want", "dont want", "do not want", "not interested",
  "no booking", "no order", "don't need", "dont need",
  "not now", "maybe later", "forget it", "never mind",
  "nevermind", "not today", "changed my mind", "go back",
  "start over", "i want out", "get me out", "i want to stop",
  "not", "nt", "later", "stop",
];

// ─── Button ID map (highest priority — interactive taps) ──────────────────────

const BUTTON_ID_MAP = {
  'ORDER':      'ORDER',
  'BOOK':       'BOOKING',
  'QUESTION':   'QUESTION',
  'CONFIRM':    'CONFIRM',
  'CANCEL':     'CANCEL',
  'SWITCH_YES': 'SWITCH_YES',
  'SWITCH_NO':  'SWITCH_NO',
  'UPSELL_YES': 'UPSELL_YES',
  'UPSELL_NO':  'UPSELL_NO',
  'DATE_BACK':  'DATE_BACK',
  'TIME_BACK':  'TIME_BACK',
};

// ─── Strict exact match ───────────────────────────────────────────────────────

function strictMatch(normalized) {
  for (const [intent, phrases] of Object.entries(STRICT_INTENTS)) {
    if (phrases.includes(normalized)) return intent;
  }
  return null;
}

// ─── Similarity suggestion (Levenshtein) — NEVER triggers, ONLY suggests ──────

function buildSuggestion(normalized) {
  // Only suggest for inputs of 3+ chars to avoid noisy suggestions
  if (normalized.length < 3) return null;

  let bestIntent = null;
  let bestPhrase = null;
  let bestDist   = Infinity;

  for (const [intent, phrases] of Object.entries(STRICT_INTENTS)) {
    // Skip intents that have many short common words that would over-match
    if (['CONFIRM', 'CANCEL', 'GREETING', 'SHOW_MENU'].includes(intent)) continue;
    for (const phrase of phrases) {
      const dist = levenshtein.get(normalized, phrase);
      // Only suggest if very close (distance 1 or 2 for short inputs, up to 3 for long)
      const maxDist = phrase.length <= 5 ? 1 : phrase.length <= 10 ? 2 : 3;
      if (dist <= maxDist && dist < bestDist) {
        bestDist   = dist;
        bestIntent = intent;
        bestPhrase = phrase;
      }
    }
  }

  if (!bestIntent) return null;
  // Return the most user-friendly phrase for that intent
  const displayPhrase = {
    ORDER:    'Order Now',
    BOOKING:  'Book Service',
    QUESTION: 'Ask a Question',
    PAYMENT:  'Payment Info',
  }[bestIntent] || bestPhrase;

  return { intent: bestIntent, phrase: displayPhrase, distance: bestDist };
}

// ─── Mode enforcement ─────────────────────────────────────────────────────────

function enforceMode(intent, business) {
  const cfg = getModeConfig(business);
  if (intent === 'ORDER'   && !cfg.flows.includes('ORDER'))   return 'RESTRICT_ORDER';
  if (intent === 'BOOKING' && !cfg.flows.includes('BOOKING')) return 'RESTRICT_BOOKING';
  return intent;
}

// ─── Rejection check ─────────────────────────────────────────────────────────

function isRejection(normalized) {
  return REJECTION_PHRASES.some(p => normalized === p || normalized.includes(p));
}

// ─── Payment query check ──────────────────────────────────────────────────────

function isPaymentQuery(normalized) {
  return STRICT_INTENTS.PAYMENT.some(p => normalized.includes(p));
}

// ─── Bot echo guard ───────────────────────────────────────────────────────────

function looksLikeBotEcho(raw, session) {
  const last = session?.lastBotMessage;
  if (!last || !raw || raw.length > 80) return false;
  const rn = normalizeInput(raw);
  const ln = normalizeInput(last).slice(0, 80);
  return rn === ln || ln.startsWith(rn.slice(0, 20));
}

// ─── Options UI for clarification — always buttons, never "type X" text ──────
//
// Returns a { type, body, buttons } object ready for dispatch().
// WhatsApp requires ≥2 buttons — guaranteed here since we always include
// at least QUESTION alongside ORDER/BOOK.
// This replaces the old text-only buildOptionsText() which generated
// "Please choose an option: 🛒 Order Now — type "order"…" messages.

function buildOptionsUI(business) {
  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');

  // Use the same button definitions as the welcome screen for consistency
  const buttons = cfg.ui.welcomeButtons;

  const body = `How can we help you today? Please choose an option below 👇`;

  if (buttons && buttons.length >= 2) {
    return { type: 'buttons', body, buttons: buttons.slice(0, 3) };
  }

  // Absolute last resort (single-flow business with 1 button)
  const fallbackLines = [];
  if (canOrder) fallbackLines.push('• *Order* — place an order');
  if (canBook)  fallbackLines.push('• *Book* — make a reservation');
  fallbackLines.push('• *Question* — ask us anything');
  return {
    type: 'text',
    body: `How can we help?\n\n${fallbackLines.join('\n')}`,
  };
}

// ─── PROTECTED STEPS — never interrupt at these steps ────────────────────────

const PROTECTED_STEPS = new Set([
  'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM',
  'QUANTITY', 'SELECT_ITEM', 'SELECT_SERVICE',
  'CONFIRM', 'INTERRUPT', 'PAYMENT_PROOF', 'UPSELL',
]);

// ─── Structured intent logger ─────────────────────────────────────────────────

function logDecision({ raw, normalized, intent, flowTriggered, suggestion, aiUsed, action, source }) {
  logger.info('[Brain] Decision', {
    raw,
    normalized,
    intent:        intent  || 'null',
    action,
    flowTriggered: !!flowTriggered,
    suggestion:    suggestion ? `"${suggestion.phrase}" (${suggestion.intent})` : null,
    aiUsed:        !!aiUsed,
    source:        source  || 'unknown',
  });
}

// ─── Main think() ─────────────────────────────────────────────────────────────

export const think = async ({ message, session, business, phone }) => {
  const raw        = String(message || '').trim();
  const normalized = normalizeInput(raw);

  // ── Dedup guard ────────────────────────────────────────────────────────────
  if (looksLikeBotEcho(raw, session)) {
    logDecision({ raw, normalized, intent: 'IGNORE', action: 'IGNORE', source: 'echo' });
    return { action: 'IGNORE' };
  }

  // ── STEP 1: Button ID (interactive tap — highest priority) ─────────────────
  const buttonIntentRaw = BUTTON_ID_MAP[raw.toUpperCase()];
  if (buttonIntentRaw) {
    const finalBtn = enforceMode(buttonIntentRaw, business);
    logDecision({ raw, normalized, intent: finalBtn, action: finalBtn, flowTriggered: true, source: 'button' });
    trackUser(phone, raw, finalBtn).catch(() => {});
    if (session?.currentFlow) return { action: 'CONTINUE_FLOW' };
    if (finalBtn === 'ORDER')   return { action: 'START_ORDER' };
    if (finalBtn === 'BOOKING') return { action: 'START_BOOKING' };
    if (finalBtn === 'CONFIRM') return { action: 'CONFIRM' };
    if (finalBtn === 'CANCEL')  return { action: 'CANCEL' };
    if (finalBtn === 'SWITCH_YES' || finalBtn === 'SWITCH_NO')  return { action: 'CONTINUE_FLOW' };
    if (finalBtn === 'UPSELL_YES' || finalBtn === 'UPSELL_NO')  return { action: 'CONTINUE_FLOW' };
    if (finalBtn === 'QUESTION') return { action: 'ENQUIRY', intent: 'QUESTION' };
    return { action: 'CONTINUE_FLOW' };
  }

  // ── STEP 2: "0" → always show menu ────────────────────────────────────────
  if (raw === '0') {
    logDecision({ raw, normalized, intent: 'SHOW_MENU', action: 'SHOW_MENU', flowTriggered: false, source: 'shortcut' });
    return { action: 'SHOW_MENU' };
  }

  // ── STEP 3: Number shortcuts outside flow (1=Order, 2=Book, 3=Question) ────
  if (!session?.currentFlow) {
    const num = parseInt(raw, 10);
    const cfg = getModeConfig(business);
    if (num === 1 && cfg.flows.includes('ORDER')) {
      logDecision({ raw, normalized, intent: 'ORDER', action: 'START_ORDER', flowTriggered: true, source: 'number' });
      return { action: 'START_ORDER' };
    }
    if (num === 2 && cfg.flows.includes('BOOKING')) {
      logDecision({ raw, normalized, intent: 'BOOKING', action: 'START_BOOKING', flowTriggered: true, source: 'number' });
      return { action: 'START_BOOKING' };
    }
    if (num === 3) {
      logDecision({ raw, normalized, intent: 'QUESTION', action: 'ENQUIRY', flowTriggered: false, source: 'number' });
      return { action: 'ENQUIRY', intent: 'QUESTION' };
    }
  }

  // ── STEP 4: Rejection check — NEVER triggers any flow ─────────────────────
  if (isRejection(normalized)) {
    logDecision({ raw, normalized, intent: 'REJECTED', action: 'CLARIFY', flowTriggered: false, source: 'rejection' });
    if (session?.currentFlow) return { action: 'REJECT_FLOW' };
    return { action: 'CLARIFY', ui: buildOptionsUI(business) };
  }

  // ── STEP 5: Active flow ────────────────────────────────────────────────────
  if (session?.currentFlow) {

    // SWITCH / UPSELL buttons pass straight through
    if (['SWITCH_YES','SWITCH_NO','UPSELL_YES','UPSELL_NO'].includes(normalized.toUpperCase())) {
      return { action: 'CONTINUE_FLOW' };
    }

    // Protected steps — continue unless it's an explicit payment or enquiry signal
    if (PROTECTED_STEPS.has(session.step)) {
      if (session.step === 'PAYMENT_PROOF' && isPaymentQuery(normalized)) {
        logDecision({ raw, normalized, intent: 'PAYMENT', action: 'AI_PAYMENT_HELP', source: 'payment-query' });
        return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
      }
      // Explicit help/enquiry escape — even inside protected steps
      const strictHere = strictMatch(normalized);
      if (strictHere === 'QUESTION') {
        logDecision({ raw, normalized, intent: 'QUESTION', action: 'ENQUIRY', source: 'strict-protected' });
        return { action: 'ENQUIRY', intent: 'QUESTION' };
      }
      logDecision({ raw, normalized, intent: null, action: 'CONTINUE_FLOW', source: 'protected-step' });
      return { action: 'CONTINUE_FLOW' };
    }

    // STRICT match inside active flow
    const strictInFlow = strictMatch(normalized);

    if (strictInFlow === 'CANCEL') {
      logDecision({ raw, normalized, intent: 'CANCEL', action: 'CANCEL', flowTriggered: false, source: 'strict' });
      return { action: 'CANCEL' };
    }
    if (strictInFlow === 'CONFIRM') {
      logDecision({ raw, normalized, intent: 'CONFIRM', action: 'CONFIRM', flowTriggered: true, source: 'strict' });
      return { action: 'CONFIRM' };
    }
    if (strictInFlow === 'SHOW_MENU') {
      logDecision({ raw, normalized, intent: 'SHOW_MENU', action: 'SHOW_MENU', flowTriggered: false, source: 'strict' });
      return { action: 'SHOW_MENU' };
    }
    if (strictInFlow === 'QUESTION') {
      logDecision({ raw, normalized, intent: 'QUESTION', action: 'ENQUIRY', source: 'strict' });
      return { action: 'ENQUIRY', intent: 'QUESTION' };
    }
    if (strictInFlow === 'PAYMENT') {
      logDecision({ raw, normalized, intent: 'PAYMENT', action: 'AI_PAYMENT_HELP', source: 'strict' });
      return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    }

    // Different flow intent mid-flow → INTERRUPT
    if (strictInFlow && strictInFlow !== session.currentFlow &&
        !['CONFIRM','CANCEL','GREETING','SHOW_MENU','PAYMENT'].includes(strictInFlow)) {
      const enforced = enforceMode(strictInFlow, business);
      if (!['RESTRICT_ORDER','RESTRICT_BOOKING'].includes(enforced)) {
        const uiObj = buildInterruptUI(business, session.currentFlow, enforced);
        logDecision({ raw, normalized, intent: strictInFlow, action: 'INTERRUPT', flowTriggered: false, source: 'strict' });
        return { action: 'INTERRUPT', intent: enforced, ui: uiObj, reply: uiObj.body };
      }
    }

    // Payment query (detected via keywords even without strict match)
    if (isPaymentQuery(normalized)) {
      logDecision({ raw, normalized, intent: 'PAYMENT', action: 'AI_PAYMENT_HELP', source: 'payment-keyword' });
      return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    }

    // About/info question → AI fallback (controlled)
    if (isAboutQuestion(raw)) {
      logDecision({ raw, normalized, intent: 'ABOUT', action: 'AI_FALLBACK', aiUsed: true, source: 'about-question' });
      return { action: 'AI_FALLBACK', intent: 'ABOUT' };
    }

    // Long message (4+ chars) without strict match → defensive AI fallback
    if (raw.trim().length >= 4) {
      logDecision({ raw, normalized, intent: null, action: 'AI_FALLBACK', aiUsed: true, source: 'fallback' });
      return { action: 'AI_FALLBACK', intent: 'FALLBACK' };
    }

    // Short unrecognised → continue flow (let flowService handle step logic)
    logDecision({ raw, normalized, intent: null, action: 'CONTINUE_FLOW', source: 'short-unrecognised' });
    return { action: 'CONTINUE_FLOW' };
  }

  // ── STEP 6: No active flow — strict match only triggers flows ───────────────
  const strictIntent = strictMatch(normalized);

  if (strictIntent) {
    const finalIntent = enforceMode(strictIntent, business);
    trackUser(phone, raw, finalIntent).catch(() => {});

    if (finalIntent === 'ORDER') {
      logDecision({ raw, normalized, intent: 'ORDER', action: 'START_ORDER', flowTriggered: true, source: 'strict' });
      return { action: 'START_ORDER' };
    }
    if (finalIntent === 'BOOKING') {
      logDecision({ raw, normalized, intent: 'BOOKING', action: 'START_BOOKING', flowTriggered: true, source: 'strict' });
      return { action: 'START_BOOKING' };
    }
    if (finalIntent === 'QUESTION') {
      if (session) updateSession(session.customerPhone, session.tenantId, { lastIntent: 'QUESTION' }).catch(() => {});
      logDecision({ raw, normalized, intent: 'QUESTION', action: 'ENQUIRY', source: 'strict' });
      return { action: 'ENQUIRY', intent: 'QUESTION' };
    }
    if (finalIntent === 'GREETING' || finalIntent === 'SHOW_MENU') {
      logDecision({ raw, normalized, intent: finalIntent, action: 'GREET', source: 'strict' });
      return { action: 'GREET' };
    }
    if (finalIntent === 'PAYMENT') {
      logDecision({ raw, normalized, intent: 'PAYMENT', action: 'AI_PAYMENT_HELP', source: 'strict' });
      return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    }
    if (finalIntent === 'CONFIRM' || finalIntent === 'CANCEL') {
      // Orphaned confirm/cancel with no flow → reset to welcome
      logDecision({ raw, normalized, intent: finalIntent, action: 'SHOW_MENU', source: 'orphaned' });
      return { action: 'SHOW_MENU' };
    }
    if (finalIntent === 'RESTRICT_ORDER') {
      logDecision({ raw, normalized, intent: 'RESTRICT_ORDER', action: 'RESTRICT_ORDER', source: 'mode' });
      return { action: 'RESTRICT_ORDER', reply: getModeRestrictionMessage(business, 'ORDER') };
    }
    if (finalIntent === 'RESTRICT_BOOKING') {
      logDecision({ raw, normalized, intent: 'RESTRICT_BOOKING', action: 'RESTRICT_BOOKING', source: 'mode' });
      return { action: 'RESTRICT_BOOKING', reply: getModeRestrictionMessage(business, 'BOOKING') };
    }
  }

  // ── STEP 7: No strict match — check similarity for SUGGESTION only ──────────
  const suggestion = buildSuggestion(normalized);

  if (suggestion) {
    logDecision({
      raw, normalized, intent: null, action: 'SUGGEST',
      suggestion, flowTriggered: false, source: 'similarity',
    });
    // Return suggestion to webhookController — it will present "Did you mean X?" buttons
    return {
      action:     'SUGGEST',
      suggestion,
      reply:      `Did you mean *${suggestion.phrase}*?`,
    };
  }

  // ── STEP 8: No match, no suggestion — defensive Groq AI fallback ────────────
  // Groq ONLY answers business-related questions and redirects back to options.
  // It NEVER triggers flows, NEVER executes commands.

  if (raw.trim().length >= 4 && isAboutQuestion(raw)) {
    logDecision({ raw, normalized, intent: 'ABOUT', action: 'ABOUT', aiUsed: true, source: 'about' });
    return { action: 'ABOUT', intent: 'INQUIRY' };
  }

  if (raw.trim().length >= 4) {
    logDecision({ raw, normalized, intent: null, action: 'AI_FALLBACK', aiUsed: true, source: 'no-match' });
    return {
      action: 'AI_FALLBACK',
      intent: null,
      ui:     buildOptionsUI(business),
    };
  }

  // Short unknown input → safe clarify with options
  logDecision({ raw, normalized, intent: null, action: 'CLARIFY', flowTriggered: false, source: 'short-unknown' });
  return {
    action: 'CLARIFY',
    ui:     buildOptionsUI(business),
  };
};
