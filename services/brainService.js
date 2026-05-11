/**
 * services/brainService.js — v11.0
 *
 * UPGRADES:
 * - Expanded STRICT_INTENTS: more natural language, African English variants,
 *   typos, and shorthand (e.g. "pls", "lemme", "i wan", "dey", "abeg")
 * - TRACK_ORDER intent: customers can check their order status mid-flow
 * - REPEAT_ORDER intent: "same as last time" / "the usual"
 * - Greeting detection handles "watsup", "salam", "greetings", "yo", "sup"
 * - Number shortcuts extended: context-aware for SALON (only Book/Question)
 * - customerName extraction: "my name is X" / "i am X" captured and saved
 * - Emoji intent detection: 🍔→ORDER, 📅→BOOK, ❓→QUESTION
 * - Improved rejection phrases — fewer false positives on "not sure" type input
 * - PAYMENT intent extended: more natural phrases
 * - SHOW_MENU extended: "start over", "reset", "beginning"
 */

import levenshtein   from 'fast-levenshtein';
import { trackUser } from './learningService.js';
import { getModeConfig, getModeRestrictionMessage } from '../config/modes.js';
import { buildInterruptUI } from '../utils/messageBuilders.js';
import { isAboutQuestion }  from './groqService.js';
import { updateSession }    from './sessionService.js';
import logger               from '../config/logger.js';

// ─── Normalization ────────────────────────────────────────────────────────────

export const normalizeInput = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ─── Emoji → intent map ───────────────────────────────────────────────────────

const EMOJI_INTENT_MAP = {
  '🍔': 'ORDER', '🛍': 'ORDER', '🛒': 'ORDER', '🍕': 'ORDER', '🥘': 'ORDER',
  '📅': 'BOOKING', '📆': 'BOOKING', '🗓': 'BOOKING', '💇': 'BOOKING',
  '❓': 'QUESTION', '🤔': 'QUESTION', '💬': 'QUESTION', '📞': 'QUESTION',
  '💳': 'PAYMENT', '💰': 'PAYMENT', '💵': 'PAYMENT',
  '🏠': 'SHOW_MENU', '🔄': 'SHOW_MENU',
};

function detectEmojiIntent(raw) {
  for (const [emoji, intent] of Object.entries(EMOJI_INTENT_MAP)) {
    if (raw.includes(emoji)) return intent;
  }
  return null;
}

// ─── Customer name extraction ─────────────────────────────────────────────────

const NAME_PATTERNS = [
  /(?:my name is|i am|i'm|call me|name's|its|it's)\s+([a-z][a-z\s]{1,30})/i,
  /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)$/, // Proper cased name on its own
];

export function extractCustomerName(raw) {
  for (const pattern of NAME_PATTERNS) {
    const m = raw.match(pattern);
    if (m) {
      const candidate = m[1].trim();
      // Reject if it looks like a sentence (contains common words)
      const badWords = ['want', 'like', 'need', 'have', 'know', 'think', 'going', 'looking'];
      if (badWords.some(w => candidate.toLowerCase().includes(w))) continue;
      if (candidate.length >= 2 && candidate.length <= 40) return candidate;
    }
  }
  return null;
}

// ─── STRICT_INTENTS ───────────────────────────────────────────────────────────

const STRICT_INTENTS = {
  ORDER: [
    'order', 'order now', 'buy', 'i want to order', 'place order',
    'i want food', 'get food', 'order food', 'i want to buy',
    // Natural variants
    'i want to get', 'i would like to order', 'can i order',
    'let me order', 'i need food', 'food please', 'give me food',
    'i want something', 'i want to get food', 'buy something',
    // African English / shorthand
    'i wan order', 'i wan buy', 'i wan food', 'abeg let me order',
    'pls let me order', 'i dey hungry', 'bring food', 'order pls',
    'i want make order', 'lemme order', 'order make',
    // Short triggers
    'food', 'buy now', 'shop', 'get', 'purchase',
  ],
  BOOKING: [
    'book', 'book service', 'book now', 'reserve', 'appointment',
    'i want to book', 'make a booking', 'book a table', 'make appointment',
    // Natural variants
    'i would like to book', 'can i book', 'schedule', 'reservation',
    'i want an appointment', 'set appointment', 'i need appointment',
    'book for me', 'make reservation', 'i want to reserve',
    // African English / shorthand
    'i wan book', 'abeg book for me', 'pls book', 'book am',
    'i want schedule', 'make booking', 'booking please',
  ],
  QUESTION: [
    'question', 'ask', 'ask question', 'enquiry', 'enquire',
    'i have a question', 'i want to ask', 'i need help', 'help',
    'what', 'how', 'info', 'about', 'hours', 'location', 'address',
    'contact', 'price', 'cost', 'open', 'close',
    // Natural variants
    'i want to know', 'can you tell me', 'please tell me',
    'i have a query', 'do you have', 'i need information',
    'can i ask', 'quick question', 'one question',
    // Shorthand
    'info pls', 'details', 'tell me', 'i wanna know',
  ],
  CONFIRM: [
    'yes', 'ok', 'okay', 'confirm', 'yep', 'sure', 'yup', 'yeah',
    'go ahead', 'sounds good', 'correct', 'proceed',
    // Natural variants
    'definitely', 'absolutely', 'of course', 'alright', 'agreed',
    'thats correct', 'that is correct', 'yes please', 'confirmed',
    'right', 'exactly', 'perfect', 'great', 'do it',
    // Shorthand
    'yh', 'ye', 'k', 'kk', 'affirmative', 'aye',
  ],
  CANCEL: [
    'cancel', 'stop', 'exit', 'quit', 'no', 'nope', 'nah',
    'never mind', 'nevermind', 'forget it', 'i changed my mind',
    // Natural variants
    'i dont want', 'i do not want', 'not interested', 'not now',
    'maybe later', 'not today', 'start over', 'scratch that',
    'remove', 'clear', 'reset it',
  ],
  GREETING: [
    'hi', 'hello', 'hey', 'start', 'begin', 'good morning',
    'good afternoon', 'good evening', 'howdy',
    // More greetings
    'greetings', 'hiya', 'yo', 'sup', 'wassup', 'watsup', 'what up',
    'morning', 'afternoon', 'evening', 'good day', 'hi there',
    'hello there', 'hey there', 'helo', 'helo there',
    // African / Islamic greetings
    'salam', 'salaam', 'assalam', 'asalamu', 'asalam',
    'peace', 'bless up',
  ],
  SHOW_MENU: [
    'menu', 'options', 'home', 'main menu', 'back', '0', 'restart',
    'show menu', 'show options', 'go back', 'main',
    // Additional
    'start over', 'beginning', 'go home', 'main page',
    'show me the menu', 'what do you have', 'what can i get',
    'what is available', "what's available", 'see menu',
    'view menu', 'see options', 'list', 'show list',
    // Shorthand
    'menu pls', 'see all',
  ],
  PAYMENT: [
    'payment', 'pay', 'wave', 'how to pay', 'how do i pay',
    'total', 'amount', 'wave payment', 'send payment',
    // Natural variants
    'how much', 'price', 'how much is it', 'what is the total',
    'payment method', 'how can i pay', 'do you accept',
    'mobile money', 'transfer', 'bank', 'cash', 'fee',
    // Shorthand
    'pay now', 'make payment', 'cost', 'charges',
  ],
  TRACK_ORDER: [
    'track', 'track order', 'where is my order', 'order status',
    'my order', 'check order', 'order update',
    'where is it', 'status', 'has my order', 'when will',
    'track my order', 'order tracking', 'delivery status',
    'is my order ready', 'when is my order',
  ],
  REPEAT_ORDER: [
    'same as before', 'same again', 'the usual', 'same as last time',
    'order the same', 'repeat my order', 'same thing',
    'last order', 'my usual', 'order same',
    'i want the same', 'same thing as before',
  ],
};

// ─── Rejection phrases ────────────────────────────────────────────────────────

const REJECTION_PHRASES = [
  "don't want", "dont want", "do not want", "not interested",
  "no booking", "no order", "don't need", "dont need",
  "not now", "maybe later", "forget it", "never mind",
  "nevermind", "not today", "changed my mind",
  "i want out", "get me out", "i want to stop",
  "leave me", "not for me", "dont bother",
];

// ─── Button ID map ────────────────────────────────────────────────────────────

const BUTTON_ID_MAP = {
  'ORDER':        'ORDER',
  'BOOK':         'BOOKING',
  'QUESTION':     'QUESTION',
  'CONFIRM':      'CONFIRM',
  'CANCEL':       'CANCEL',
  'SWITCH_YES':   'SWITCH_YES',
  'SWITCH_NO':    'SWITCH_NO',
  'UPSELL_YES':   'UPSELL_YES',
  'UPSELL_NO':    'UPSELL_NO',
  'DATE_BACK':    'DATE_BACK',
  'TIME_BACK':    'TIME_BACK',
  'TRACK_ORDER':  'TRACK_ORDER',
  'REPEAT_ORDER': 'REPEAT_ORDER',
};

// ─── Strict exact match ───────────────────────────────────────────────────────

function strictMatch(normalized) {
  for (const [intent, phrases] of Object.entries(STRICT_INTENTS)) {
    if (phrases.includes(normalized)) return intent;
  }
  return null;
}

// ─── Similarity suggestion (Levenshtein) ─────────────────────────────────────

function buildSuggestion(normalized) {
  if (normalized.length < 3) return null;

  let bestIntent = null;
  let bestPhrase = null;
  let bestDist   = Infinity;

  for (const [intent, phrases] of Object.entries(STRICT_INTENTS)) {
    if (['CONFIRM', 'CANCEL', 'GREETING', 'SHOW_MENU'].includes(intent)) continue;
    for (const phrase of phrases) {
      const dist = levenshtein.get(normalized, phrase);
      const maxDist = phrase.length <= 5 ? 1 : phrase.length <= 10 ? 2 : 3;
      if (dist <= maxDist && dist < bestDist) {
        bestDist   = dist;
        bestIntent = intent;
        bestPhrase = phrase;
      }
    }
  }

  if (!bestIntent) return null;

  const displayPhrase = {
    ORDER:        'Order Now',
    BOOKING:      'Book Service',
    QUESTION:     'Ask a Question',
    PAYMENT:      'Payment Info',
    TRACK_ORDER:  'Track My Order',
    REPEAT_ORDER: 'Repeat Last Order',
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

// ─── Options UI ───────────────────────────────────────────────────────────────

function buildOptionsUI(business) {
  const cfg     = getModeConfig(business);
  const buttons = cfg.ui.welcomeButtons;
  const body    = `How can we help you today? Please choose an option below 👇`;

  if (buttons && buttons.length >= 2) {
    return { type: 'buttons', body, buttons: buttons.slice(0, 3) };
  }

  const cfg2     = getModeConfig(business);
  const canOrder = cfg2.flows.includes('ORDER');
  const canBook  = cfg2.flows.includes('BOOKING');
  const fallbackLines = [];
  if (canOrder) fallbackLines.push('• *Order* — place an order');
  if (canBook)  fallbackLines.push('• *Book* — make a reservation');
  fallbackLines.push('• *Question* — ask us anything');
  return { type: 'text', body: `How can we help?\n\n${fallbackLines.join('\n')}` };
}

// ─── Protected steps ──────────────────────────────────────────────────────────

const PROTECTED_STEPS = new Set([
  'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM',
  'QUANTITY', 'SELECT_ITEM', 'SELECT_SERVICE',
  'CONFIRM', 'INTERRUPT', 'PAYMENT_PROOF', 'UPSELL',
]);

// ─── Decision logger ──────────────────────────────────────────────────────────

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

  // ── [v11] Customer name capture ────────────────────────────────────────────
  const extractedName = extractCustomerName(raw);
  if (extractedName && session && !session.customerName) {
    updateSession(session.customerPhone, session.tenantId, { customerName: extractedName }).catch(() => {});
    logger.info('[Brain] Customer name captured', { name: extractedName, phone });
  }

  // ── [v11] Increment message count ─────────────────────────────────────────
  if (session) {
    updateSession(session.customerPhone, session.tenantId, {
      messageCount: (session.messageCount || 0) + 1,
      lastSeen: new Date(),
    }).catch(() => {});
  }

  // ── STEP 1: Button ID (highest priority) ───────────────────────────────────
  const buttonIntentRaw = BUTTON_ID_MAP[raw.toUpperCase()];
  if (buttonIntentRaw) {
    const finalBtn = enforceMode(buttonIntentRaw, business);
    logDecision({ raw, normalized, intent: finalBtn, action: finalBtn, flowTriggered: true, source: 'button' });
    trackUser(phone, raw, finalBtn).catch(() => {});
    if (session?.currentFlow) return { action: 'CONTINUE_FLOW' };
    if (finalBtn === 'ORDER')         return { action: 'START_ORDER' };
    if (finalBtn === 'BOOKING')       return { action: 'START_BOOKING' };
    if (finalBtn === 'CONFIRM')       return { action: 'CONFIRM' };
    if (finalBtn === 'CANCEL')        return { action: 'CANCEL' };
    if (finalBtn === 'SWITCH_YES' || finalBtn === 'SWITCH_NO') return { action: 'CONTINUE_FLOW' };
    if (finalBtn === 'UPSELL_YES' || finalBtn === 'UPSELL_NO') return { action: 'CONTINUE_FLOW' };
    if (finalBtn === 'QUESTION')      return { action: 'ENQUIRY', intent: 'QUESTION' };
    if (finalBtn === 'TRACK_ORDER')   return { action: 'TRACK_ORDER', intent: 'TRACK_ORDER' };
    if (finalBtn === 'REPEAT_ORDER')  return { action: 'REPEAT_ORDER', intent: 'REPEAT_ORDER' };
    return { action: 'CONTINUE_FLOW' };
  }

  // ── STEP 2: "0" → always show menu ─────────────────────────────────────────
  if (raw === '0') {
    logDecision({ raw, normalized, intent: 'SHOW_MENU', action: 'SHOW_MENU', flowTriggered: false, source: 'shortcut' });
    return { action: 'SHOW_MENU' };
  }

  // ── STEP 3: Emoji intent detection ────────────────────────────────────────
  const emojiIntent = detectEmojiIntent(raw);
  if (emojiIntent && !session?.currentFlow) {
    const finalEmoji = enforceMode(emojiIntent, business);
    logDecision({ raw, normalized, intent: finalEmoji, action: finalEmoji, flowTriggered: true, source: 'emoji' });
    if (finalEmoji === 'ORDER')   return { action: 'START_ORDER' };
    if (finalEmoji === 'BOOKING') return { action: 'START_BOOKING' };
    if (finalEmoji === 'QUESTION') return { action: 'ENQUIRY', intent: 'QUESTION' };
    if (finalEmoji === 'PAYMENT') return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    if (finalEmoji === 'SHOW_MENU') return { action: 'SHOW_MENU' };
  }

  // ── STEP 4: Number shortcuts (context-aware per mode) ─────────────────────
  if (!session?.currentFlow) {
    const num = parseInt(raw, 10);
    const cfg = getModeConfig(business);
    const canOrder = cfg.flows.includes('ORDER');
    const canBook  = cfg.flows.includes('BOOKING');

    if (canOrder && canBook) {
      if (num === 1) { logDecision({ raw, normalized, intent: 'ORDER', action: 'START_ORDER', flowTriggered: true, source: 'number' }); return { action: 'START_ORDER' }; }
      if (num === 2) { logDecision({ raw, normalized, intent: 'BOOKING', action: 'START_BOOKING', flowTriggered: true, source: 'number' }); return { action: 'START_BOOKING' }; }
      if (num === 3) { logDecision({ raw, normalized, intent: 'QUESTION', action: 'ENQUIRY', flowTriggered: false, source: 'number' }); return { action: 'ENQUIRY', intent: 'QUESTION' }; }
    } else if (canOrder) {
      if (num === 1) { logDecision({ raw, normalized, intent: 'ORDER', action: 'START_ORDER', flowTriggered: true, source: 'number' }); return { action: 'START_ORDER' }; }
      if (num === 2) { logDecision({ raw, normalized, intent: 'QUESTION', action: 'ENQUIRY', flowTriggered: false, source: 'number' }); return { action: 'ENQUIRY', intent: 'QUESTION' }; }
    } else if (canBook) {
      if (num === 1) { logDecision({ raw, normalized, intent: 'BOOKING', action: 'START_BOOKING', flowTriggered: true, source: 'number' }); return { action: 'START_BOOKING' }; }
      if (num === 2) { logDecision({ raw, normalized, intent: 'QUESTION', action: 'ENQUIRY', flowTriggered: false, source: 'number' }); return { action: 'ENQUIRY', intent: 'QUESTION' }; }
    }
  }

  // ── STEP 5: Rejection check ───────────────────────────────────────────────
  if (isRejection(normalized)) {
    logDecision({ raw, normalized, intent: 'REJECTED', action: 'CLARIFY', flowTriggered: false, source: 'rejection' });
    if (session?.currentFlow) return { action: 'REJECT_FLOW' };
    return { action: 'CLARIFY', ui: buildOptionsUI(business) };
  }

  // ── STEP 6: Active flow ───────────────────────────────────────────────────
  if (session?.currentFlow) {

    if (['SWITCH_YES','SWITCH_NO','UPSELL_YES','UPSELL_NO'].includes(normalized.toUpperCase())) {
      return { action: 'CONTINUE_FLOW' };
    }

    if (PROTECTED_STEPS.has(session.step)) {
      if (session.step === 'PAYMENT_PROOF' && isPaymentQuery(normalized)) {
        return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
      }
      const strictHere = strictMatch(normalized);
      if (strictHere === 'QUESTION') {
        return { action: 'ENQUIRY', intent: 'QUESTION' };
      }
      if (strictHere === 'TRACK_ORDER') {
        return { action: 'TRACK_ORDER', intent: 'TRACK_ORDER' };
      }
      return { action: 'CONTINUE_FLOW' };
    }

    const strictInFlow = strictMatch(normalized);

    if (strictInFlow === 'CANCEL')     return { action: 'CANCEL' };
    if (strictInFlow === 'CONFIRM')    return { action: 'CONFIRM' };
    if (strictInFlow === 'SHOW_MENU')  return { action: 'SHOW_MENU' };
    if (strictInFlow === 'QUESTION')   return { action: 'ENQUIRY', intent: 'QUESTION' };
    if (strictInFlow === 'PAYMENT')    return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    if (strictInFlow === 'TRACK_ORDER') return { action: 'TRACK_ORDER', intent: 'TRACK_ORDER' };

    if (strictInFlow && strictInFlow !== session.currentFlow &&
        !['CONFIRM','CANCEL','GREETING','SHOW_MENU','PAYMENT','TRACK_ORDER','REPEAT_ORDER'].includes(strictInFlow)) {
      const enforced = enforceMode(strictInFlow, business);
      if (!['RESTRICT_ORDER','RESTRICT_BOOKING'].includes(enforced)) {
        const uiObj = buildInterruptUI(business, session.currentFlow, enforced);
        return { action: 'INTERRUPT', intent: enforced, ui: uiObj, reply: uiObj.body };
      }
    }

    if (isPaymentQuery(normalized))  return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    if (isAboutQuestion(raw))        return { action: 'AI_FALLBACK', intent: 'ABOUT' };
    if (raw.trim().length >= 4)      return { action: 'AI_FALLBACK', intent: 'FALLBACK' };

    return { action: 'CONTINUE_FLOW' };
  }

  // ── STEP 7: No active flow — strict match ─────────────────────────────────
  const strictIntent = strictMatch(normalized);

  if (strictIntent) {
    const finalIntent = enforceMode(strictIntent, business);
    trackUser(phone, raw, finalIntent).catch(() => {});

    if (finalIntent === 'ORDER')   return { action: 'START_ORDER' };
    if (finalIntent === 'BOOKING') return { action: 'START_BOOKING' };
    if (finalIntent === 'QUESTION') {
      if (session) updateSession(session.customerPhone, session.tenantId, { lastIntent: 'QUESTION' }).catch(() => {});
      return { action: 'ENQUIRY', intent: 'QUESTION' };
    }
    if (finalIntent === 'GREETING' || finalIntent === 'SHOW_MENU') return { action: 'GREET' };
    if (finalIntent === 'PAYMENT')      return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    if (finalIntent === 'TRACK_ORDER')  return { action: 'TRACK_ORDER', intent: 'TRACK_ORDER' };
    if (finalIntent === 'REPEAT_ORDER') return { action: 'REPEAT_ORDER', intent: 'REPEAT_ORDER' };
    if (finalIntent === 'CONFIRM' || finalIntent === 'CANCEL') return { action: 'SHOW_MENU' };
    if (finalIntent === 'RESTRICT_ORDER')   return { action: 'RESTRICT_ORDER', reply: getModeRestrictionMessage(business, 'ORDER') };
    if (finalIntent === 'RESTRICT_BOOKING') return { action: 'RESTRICT_BOOKING', reply: getModeRestrictionMessage(business, 'BOOKING') };
  }

  // ── STEP 8: Similarity suggestion ────────────────────────────────────────
  const suggestion = buildSuggestion(normalized);
  if (suggestion) {
    return {
      action:     'SUGGEST',
      suggestion,
      reply:      `Did you mean *${suggestion.phrase}*?`,
    };
  }

  // ── STEP 9: Groq AI fallback ───────────────────────────────────────────────
  if (raw.trim().length >= 4 && isAboutQuestion(raw)) {
    return { action: 'ABOUT', intent: 'INQUIRY' };
  }

  if (raw.trim().length >= 4) {
    return { action: 'AI_FALLBACK', intent: null, ui: buildOptionsUI(business) };
  }

  return { action: 'CLARIFY', ui: buildOptionsUI(business) };
};
