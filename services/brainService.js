/**
 * services/brainService.js — WhatsBotLyn v5.0
 *
 * LAYER 1 — DECISION ONLY.
 * Answers: "What does the user want?"
 * Never touches DB, never sends messages, never runs flow logic.
 *
 * v5.0 IMPROVEMENTS:
 * AI FALLBACK CHAIN: think() now returns action:'AI_FALLBACK' for
 *         unresolved messages INSIDE a flow. webhookController calls groqService
 *         with full session context. Groq is STRICTLY blocked from confirming
 *         orders, modifying cart, or changing totals.
 * AI MEMORY: session context (currentFlow, step, lastIntent, lastMessage)
 *         is passed to groqService on every AI call so responses are coherent.
 *         Memory resets automatically on session clear.
 * PAYMENT CONTEXT: when step=PAYMENT_PROOF and user asks about payment,
 *         brain returns action:'AI_PAYMENT_HELP' → groqService gets payment-aware
 *         prompt ("Wave, after confirming your order").
 * lastIntent is written to session after every think() so groqService
 *         can reference what the user was trying to do.
 * DEDUP GUARD: if message === session.lastBotMessage, action:'IGNORE'
 *         prevents echoing the bot's own messages back.
 *
 * Preserved from v3.1:
 * Clarification-first fallback for short/unknown messages
 * UPSELL button pass-through
 * INQUIRY → ABOUT routing
 * Anti-spam: single-word unknowns get clarification, not AI
 * Revenue-boosting: ORDER/BOOKING win on ambiguous messages
 */

import levenshtein from 'fast-levenshtein';
import { trackUser }                                                  from './learningService.js';
import { getModeConfig, getModeRestrictionMessage }                   from '../config/modes.js';
import { buildInterruptUI }                                           from '../utils/messageBuilders.js';
import { isAboutQuestion }                                            from './groqService.js';
import { updateSession }                                              from './sessionService.js';

const normalize = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

const tokenize = (text) => text.split(' ').filter(Boolean);

// ─── Base keyword sets ────────────────────────────────────────────────────────

const BASE_KEYWORDS = {
  ORDER:    ['order', 'buy', 'food', 'meal', 'eat', 'hungry', 'item', 'dish', 'want',
             'shop', 'purchase', 'get', 'product', 'menu', 'price'],
  BOOKING:  ['book', 'booking', 'reserve', 'reservation', 'appointment', 'schedule',
             'table', 'slot', 'visit', 'service', 'haircut', 'hair', 'cut', 'nails',
             'available', 'availability'],
  INQUIRY:  ['what', 'how', 'why', 'tell', 'info', 'about', 'question', 'know',
             'detail', 'hours', 'open', 'close', 'cost', 'location', 'address',
             'contact', 'phone', 'where'],
  CONFIRM:  ['yes', 'ok', 'okay', 'confirm', 'yep', 'sure', 'yup', 'yeah', 'done',
             'correct', 'right', 'alright', 'proceed', 'go'],
  CANCEL:   ['no', 'cancel', 'stop', 'exit', 'quit', 'nope', 'nah', 'wrong',
             'nevermind', 'forget'],
  GREETING: ['hi', 'hello', 'hey', 'good', 'morning', 'evening', 'afternoon',
             'howdy', 'greetings', 'sup', 'start', 'begin'],
  SHOW_MENU:['menu', 'help', 'options', 'restart', 'home', 'main', 'back', 'return'],
  PAYMENT:  ['payment', 'pay', 'wave', 'money', 'send', 'transfer', 'screenshot',
             'how to pay', 'how do i pay', 'how much', 'total', 'amount', 'price'],
};

const BASE_PHRASES = {
  ORDER:    ['i want food', 'can i order', 'place an order', 'i want to eat',
             "what's on the menu", 'whats on the menu', 'i want to buy',
             'can i get', 'i want to order', 'take my order'],
  BOOKING:  ['i want to book', 'make a booking', 'book a table', 'reserve a table',
             'make a reservation', 'book an appointment', 'i need an appointment',
             'schedule a service', 'set up a booking'],
  CONFIRM:  ['yes do it', 'go ahead', 'sounds good', 'looks good', "that's correct",
             'go for it', 'all good', 'confirm it', 'looks right', 'that is correct'],
  CANCEL:   ['cancel it', 'never mind', 'start over', 'forget it', "not right",
             "that's wrong", 'i changed my mind'],
  GREETING: ['good morning', 'good afternoon', 'good evening', 'good day'],
  SHOW_MENU:['show me the menu', 'what can you do', 'back to menu', 'main menu',
             'show options', 'go back', 'start again'],
  PAYMENT:  ['how about payment', 'about payment', 'how do i pay', 'payment method',
             'how to pay', 'can i pay', 'how much do i pay', 'wave payment',
             'send money', 'send payment', 'make payment'],
};

// ─── Stable button ID map (highest priority — checked BEFORE fuzzy scoring) ───

const BUTTON_ID_MAP = {
  'ORDER':      'ORDER',
  'BOOK':       'BOOKING',
  'CONFIRM':    'CONFIRM',
  'CANCEL':     'CANCEL',
  'SWITCH_YES': 'SWITCH_YES',
  'SWITCH_NO':  'SWITCH_NO',
  'UPSELL_YES': 'UPSELL_YES',
  'UPSELL_NO':  'UPSELL_NO',
  '1':          null,
  '2':          null,
};

// ─── Fuzzy scoring ────────────────────────────────────────────────────────────

const fuzzyScore = (tokens, keywords) => {
  let score = 0;
  for (const token of tokens) {
    for (const word of keywords) {
      if (token === word)                               { score += 4; continue; }
      if (token.includes(word) || word.includes(token)) { score += 2; continue; }
      const dist = levenshtein.get(token, word);
      if (dist === 1) score += 2;
      else if (dist === 2) score += 1;
    }
  }
  return score;
};

const phraseScore = (text, phrases = []) =>
  phrases.reduce((acc, p) => acc + (text.includes(p) ? 6 : 0), 0);

// ─── Merge business NLP keywords ─────────────────────────────────────────────

function buildKeywords(business) {
  const extra = business?.nlp?.keywords || {};
  return {
    ORDER:    [...BASE_KEYWORDS.ORDER,    ...(extra.order   || [])],
    BOOKING:  [...BASE_KEYWORDS.BOOKING,  ...(extra.booking || [])],
    INQUIRY:  [...BASE_KEYWORDS.INQUIRY],
    CONFIRM:  [...BASE_KEYWORDS.CONFIRM],
    CANCEL:   [...BASE_KEYWORDS.CANCEL],
    GREETING: [...BASE_KEYWORDS.GREETING],
    SHOW_MENU:[...BASE_KEYWORDS.SHOW_MENU],
    PAYMENT:  [...BASE_KEYWORDS.PAYMENT],
  };
}

// ─── Intent detection ─────────────────────────────────────────────────────────

function detectIntent(message, session, business) {
  const raw    = String(message || '').trim();
  const text   = normalize(raw);
  const tokens = tokenize(text);
  const KEYWORDS = buildKeywords(business);

  // 1. Stable button IDs — highest priority
  const buttonIntent = BUTTON_ID_MAP[raw.toUpperCase()];
  if (buttonIntent) return { intent: buttonIntent, confidence: 1.0, source: 'button' };

  // 2. "0" always means show menu
  if (raw === '0') return { intent: 'SHOW_MENU', confidence: 1.0, source: 'button' };

  // 3. Numbers outside flow → quick shortcuts (1=Order, 2=Book)
  if (!session?.currentFlow) {
    const num = parseInt(raw, 10);
    const cfg = getModeConfig(business);
    if (num === 1 && cfg.flows.includes('ORDER'))   return { intent: 'ORDER',   confidence: 1.0, source: 'number' };
    if (num === 2 && cfg.flows.includes('BOOKING')) return { intent: 'BOOKING', confidence: 1.0, source: 'number' };
  }

  if (!text || tokens.length === 0) return { intent: 'UNKNOWN', confidence: 0, source: 'empty' };

  // 4. Fuzzy + phrase scoring across all intents
  const scores = {};
  for (const intent in KEYWORDS) {
    scores[intent] =
      fuzzyScore(tokens, KEYWORDS[intent]) +
      phraseScore(text, BASE_PHRASES[intent] || []);
  }

  // Sticky intent: boost active flow
  if (session?.currentFlow && scores[session.currentFlow] !== undefined) {
    scores[session.currentFlow] += 3;
  }

  // Revenue-first: ORDER and BOOKING win on ties
  if (scores.ORDER   > 0) scores.ORDER   += 3;
  if (scores.BOOKING > 0) scores.BOOKING += 3;

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topIntent, rawScore] = sorted[0] || ['UNKNOWN', 0];

  if (rawScore < 2) return { intent: 'UNKNOWN', confidence: 0, source: 'fuzzy' };

  return {
    intent:     topIntent,
    confidence: Math.min(rawScore / 10, 1),
    source:     'fuzzy',
  };
}

// ─── Mode enforcement ─────────────────────────────────────────────────────────

function enforceMode(intent, business) {
  const cfg = getModeConfig(business);
  if (intent === 'ORDER'   && !cfg.flows.includes('ORDER'))   return 'RESTRICT_ORDER';
  if (intent === 'BOOKING' && !cfg.flows.includes('BOOKING')) return 'RESTRICT_BOOKING';
  return intent;
}

// ─── Tone helper ──────────────────────────────────────────────────────────────

function applyTone(business, text) {
  const tone = business?.tone?.style || getModeConfig(business).tone.style || 'PROFESSIONAL';
  if (tone === 'PREMIUM') text = text.replace(/please/gi, 'kindly').replace('How can I', 'How may I');
  return text.trim();
}

// ─── Static welcome text ──────────────────────────────────────────────────────

function buildWelcomeStatic(business) {
  const cfg  = getModeConfig(business);
  const name = business?.name || 'our service';
  const btns = cfg.ui.welcomeButtons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
  const hint = cfg.ui.welcomeButtons.map((b) => `Reply *${b.id}*`).join(' | ');
  return (
    `👋 Welcome to *${name}*!\n\n` +
    `${btns}\n\n${hint}\n\nType *0* anytime to return here.`
  );
}

// ─── Clarification question ──────────────────────────────────────────

function buildClarificationReply(business) {
  const cfg      = getModeConfig(business);
  const canOrder = cfg.flows.includes('ORDER');
  const canBook  = cfg.flows.includes('BOOKING');

  if (canOrder && canBook) return 'What would you like to do — *order*, *book*, or ask a *question*?';
  if (canOrder)            return 'Would you like to place an order?';
  if (canBook)             return 'Would you like to book an appointment?';
  return 'How can I help you?';
}

// ─── PROTECTED STEPS — never interrupt at these steps ────────────────────────

const PROTECTED_STEPS = new Set([
  'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM',
  'QUANTITY', 'SELECT_ITEM', 'SELECT_SERVICE',
  'CONFIRM', 'INTERRUPT',
  'PAYMENT_PROOF',
  'UPSELL',
]);

// ─── REJECTION_PHRASES ────────────────────────────────────────────────────────

const REJECTION_PHRASES = [
  "don't want",  "dont want",
  "do not want", "not interested",
  "no booking",  "no order",
  "don't need",  "dont need",
  "not now",     "maybe later",
  "forget it",   "never mind",
  "nevermind",   "not today",
  "changed my mind", "change my mind",
  "go back",     "start over",
  "i want out",  "get me out",
  "i want to stop",
];

function isRejectionPhrase(text) {
  return REJECTION_PHRASES.some((phrase) => text.includes(phrase));
}

// ─── Payment query detection ─────────────────────────────────────────
// Detects "how about payment", "how do i pay", "wave", etc.

function isPaymentQuery(text) {
  return phraseScore(text, BASE_PHRASES.PAYMENT) > 0 ||
         fuzzyScore(tokenize(text), BASE_KEYWORDS.PAYMENT) >= 4;
}

// ─── Dedup guard: detect if message is a bounce of the bot's last reply
// Only checks short messages (< 80 chars) to avoid false positives

function looksLikeBotEcho(raw, session) {
  const last = session?.lastBotMessage;
  if (!last || !raw || raw.length > 80) return false;
  const rn = normalize(raw);
  const ln = normalize(last).slice(0, 80);
  return rn === ln || ln.startsWith(rn.slice(0, 20));
}

// ─── Main think() ─────────────────────────────────────────────────────────────

export const think = async ({ message, session, business, phone }) => {
  const raw = String(message || '').trim();

  // Dedup guard — ignore if this looks like an echo of the bot's last reply
  if (looksLikeBotEcho(raw, session)) {
    return { action: 'IGNORE' };
  }

  const { intent, confidence, source } = detectIntent(raw, session, business);
  trackUser(phone, raw, intent).catch(() => {});
  const finalIntent = enforceMode(intent, business);

  // Persist last intent in session for AI memory
  if (intent !== 'UNKNOWN' && session) {
    updateSession(session.customerPhone, session.tenantId, { lastIntent: intent }).catch(() => {});
  }

  // ── ACTIVE FLOW ────────────────────────────────────────────────────────────
  if (session?.currentFlow) {

    // SWITCH_YES / SWITCH_NO are handled by flowService INTERRUPT step
    if (finalIntent === 'SWITCH_YES' || finalIntent === 'SWITCH_NO') {
      return { action: 'CONTINUE_FLOW' };
    }

    // UPSELL button responses pass through to flowService
    if (finalIntent === 'UPSELL_YES' || finalIntent === 'UPSELL_NO') {
      return { action: 'CONTINUE_FLOW' };
    }

    // Explicit rejection phrase — exit cleanly regardless of step
    if (isRejectionPhrase(normalize(raw))) {
      return { action: 'REJECT_FLOW' };
    }

    // Protected steps — never interrupt, just continue
    if (PROTECTED_STEPS.has(session.step)) {
      // BUT: if user is asking about payment while at PAYMENT_PROOF step,
      // route to AI payment helper instead of passing to flowService as a raw message
      if (session.step === 'PAYMENT_PROOF' && isPaymentQuery(normalize(raw))) {
        return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
      }
      return { action: 'CONTINUE_FLOW' };
    }

    // "0" mid-flow → SHOW_MENU (global escape)
    if (finalIntent === 'SHOW_MENU') return { action: 'SHOW_MENU' };

    // Payment query mid-flow (any step) → payment help
    if (finalIntent === 'PAYMENT' || isPaymentQuery(normalize(raw))) {
      return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    }

    // Possible flow switch — raised threshold to avoid false triggers
    const INTERRUPT_THRESHOLD = parseFloat(process.env.INTERRUPT_THRESHOLD || '0.70');
    const isNewFlowIntent =
      finalIntent !== 'UNKNOWN' &&
      finalIntent !== session.currentFlow &&
      !['CONFIRM', 'CANCEL', 'GREETING', 'INQUIRY', 'PAYMENT',
        'RESTRICT_ORDER', 'RESTRICT_BOOKING', 'SHOW_MENU'].includes(finalIntent) &&
      confidence >= INTERRUPT_THRESHOLD;

    if (isNewFlowIntent) {
      const uiObj = buildInterruptUI(business, session.currentFlow, finalIntent);
      return {
        action: 'INTERRUPT',
        intent: finalIntent,
        ui:     uiObj,
        reply:  applyTone(business, uiObj.body),
      };
    }

    if (finalIntent === 'CONFIRM' && confidence >= 0.7) return { action: 'CONFIRM' };
    if (finalIntent === 'CANCEL'  && confidence >= 0.6) return { action: 'CANCEL' };

    // In-flow messages that don't match any button/keyword →
    // route to AI fallback so customer gets a smart, context-aware response.
    // The AI is instructed not to confirm orders or modify cart.
    if (finalIntent === 'INQUIRY' || isAboutQuestion(raw)) {
      return { action: 'AI_FALLBACK', intent: 'ABOUT' };
    }

    if (raw.trim().length >= 4) {
      return { action: 'AI_FALLBACK', intent: 'FALLBACK' };
    }

    return { action: 'CONTINUE_FLOW' };
  }

  // ── NO ACTIVE FLOW ─────────────────────────────────────────────────────────

  if (finalIntent === 'ORDER')   return { action: 'START_ORDER' };
  if (finalIntent === 'BOOKING') return { action: 'START_BOOKING' };

  if (finalIntent === 'SHOW_MENU' || finalIntent === 'GREETING') {
    return { action: 'GREET', reply: applyTone(business, buildWelcomeStatic(business)) };
  }

  if (finalIntent === 'RESTRICT_BOOKING') {
    return { action: 'RESTRICT_BOOKING', reply: getModeRestrictionMessage(business, 'BOOKING') };
  }
  if (finalIntent === 'RESTRICT_ORDER') {
    return { action: 'RESTRICT_ORDER', reply: getModeRestrictionMessage(business, 'ORDER') };
  }

  if (finalIntent === 'PAYMENT') {
    return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
  }

  if (finalIntent === 'INQUIRY' || isAboutQuestion(raw)) {
    return { action: 'ABOUT', intent: 'INQUIRY' };
  }

  // Unknown intent → clarify for short messages, AI fallback for longer ones
  if (!raw || raw.trim().length < 4) {
    return {
      action: 'CLARIFY',
      intent: finalIntent,
      reply:  buildClarificationReply(business),
    };
  }

  return {
    action: 'AI_FALLBACK',
    intent: finalIntent,
    reply:  applyTone(business, buildClarificationReply(business)),
  };
};
