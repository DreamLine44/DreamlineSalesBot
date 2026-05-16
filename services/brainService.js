/**
 * services/brainService.js — DreamLine SalesBot (Perfect Merged v11+v7+v12)
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  STRICT DETERMINISTIC INTENT ENGINE  ·  AI STRICTLY LAST RESORT    ║
 * ║                                                                      ║
 * ║  GOLDEN RULES (merged from v7 intentEngine + v11 + v12 fixes):      ║
 * ║  1. Button ID / emoji → instant action, ZERO AI involvement         ║
 * ║  2. Active flow → flow OWNS the message completely                  ║
 * ║     PROTECTED steps: only CANCEL/CONFIRM can escape                 ║
 * ║     Other steps: only CANCEL/CONFIRM/SHOW_MENU/QUESTION/PAYMENT     ║
 * ║     can escape; a different flow intent → INTERRUPT (user decides)  ║
 * ║  3. Greeting always snaps to welcome — even inside active flows     ║
 * ║  4. Strict exact match → triggers flow, no AI ever                  ║
 * ║  5. Levenshtein similarity → SUGGEST only, NEVER execute            ║
 * ║  6. [v12 Fix 1] AI fallback inside active flows ONLY for messages   ║
 * ║     that are ≥10 chars, non-numeric, and multi-word. Short inputs   ║
 * ║     (word-numbers, single words, digits) → CONTINUE_FLOW so        ║
 * ║     flowService parses them natively (e.g. qty "twelve" = 12)      ║
 * ║  7. AI NEVER triggers flows. It answers + shows CTA options.        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import levenshtein   from 'fast-levenshtein';
import { trackUser } from './learningService.js';
import { getModeConfig, getModeRestrictionMessage } from '../config/modes.js';
import { buildInterruptUI, buildOptionsUI } from '../utils/messageBuilders.js';
import { isAboutQuestion }  from './groqService.js';
import { updateSession }    from './sessionService.js';
import logger               from '../config/logger.js';

// ─── Normalisation ────────────────────────────────────────────────────────────

export const normalizeInput = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ─── Emoji intent map ─────────────────────────────────────────────────────────

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
  /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)$/,
];

export function extractCustomerName(raw) {
  for (const pattern of NAME_PATTERNS) {
    const m = raw.match(pattern);
    if (m) {
      const candidate = m[1].trim();
      const badWords = ['want', 'like', 'need', 'have', 'know', 'think', 'going', 'looking'];
      if (badWords.some(w => candidate.toLowerCase().includes(w))) continue;
      if (candidate.length >= 2 && candidate.length <= 40) return candidate;
    }
  }
  return null;
}

// ─── STRICT_INTENTS ───────────────────────────────────────────────────────────
// Merged from v7 intentEngine + v11 brainService (African English, shorthand,
// natural variants). ONLY exact matches (after normalization) trigger flows.

const STRICT_INTENTS = {
  ORDER: [
    'order', 'order now', 'buy', 'i want to order', 'place order', 'i want to buy',
    'purchase', 'i want food', 'get food', 'order food', 'i want to eat',
    'add to cart', 'buy now', 'shop', 'shop now', 'i want to shop', 'i want',
    'i want to get', 'i would like to order', 'can i order',
    'let me order', 'i need food', 'food please', 'give me food',
    'i want something', 'i want to get food', 'buy something',
    'i wan order', 'i wan buy', 'i wan food', 'abeg let me order',
    'pls let me order', 'i dey hungry', 'bring food', 'order pls',
    'i want make order', 'lemme order', 'order make',
    // Fashion specific
    'i want clothes', 'i want to buy clothes', 'shop clothes', 'browse collection',
    'see collection', 'view collection', 'i need an outfit', 'buy outfit',
    'i want a dress', 'i want shoes', 'fashion', 'style', 'i want to shop fashion',
    // Cosmetics / beauty products
    'i want beauty products', 'buy skincare', 'buy makeup', 'shop beauty',
    'i want skincare', 'i need makeup', 'i want cosmetics', 'buy products',
    // Bakery specific
    'i want to pre-order', 'pre-order', 'preorder', 'i want a cake', 'order cake',
    'buy bread', 'i want pastries', 'baked goods', 'i want to buy bread',
    // NOTE: 'food', 'get', 'purchase' removed — too broad, cause false positives
    // on natural questions like "do you have food?" → now routes to ENQUIRY correctly
  ],
  BOOKING: [
    'book', 'book service', 'book now', 'reserve', 'reservation',
    'i want to book', 'make a booking', 'book a table', 'make reservation',
    'book a seat', 'table reservation', 'appointment', 'book appointment',
    'i would like to book', 'can i book', 'schedule',
    'i want an appointment', 'set appointment', 'i need appointment',
    'book for me', 'i want to reserve',
    'i wan book', 'abeg book for me', 'pls book', 'book am',
    'i want schedule', 'make booking', 'booking please',
    // Barbershop / salon specific
    'haircut', 'hair cut', 'i want a haircut', 'i need a haircut',
    'cut my hair', 'get a cut', 'get a trim', 'trim my hair',
    'fade', 'i want a fade', 'low cut', 'low fade', 'skin fade',
    'lining', 'edge up', 'shape up', 'shave', 'beard trim', 'lineup',
    'i want a shave', 'barber', 'i need the barber', 'visit the barber',
    // Salon / beauty
    'hair appointment', 'nail appointment', 'book a treatment',
    'i want a treatment', 'beauty appointment', 'consultation',
    'book consultation', 'i want a consultation', 'beauty consultation',
  ],
  QUESTION: [
    'question', 'ask', 'ask question', 'enquiry', 'enquire',
    'i have a question', 'i want to ask', 'i need help', 'help',
    'what', 'how', 'info', 'about', 'hours', 'location', 'address',
    'contact', 'price', 'cost', 'open', 'close', 'deliver', 'available',
    'do you have', 'is there', 'tell me',
    'i want to know', 'can you tell me', 'please tell me',
    'i have a query', 'i need information', 'can i ask',
    'quick question', 'one question', 'info pls', 'details', 'i wanna know',
  ],
  CONFIRM: [
    'yes', 'ok', 'okay', 'confirm', 'yep', 'sure', 'yup', 'yeah',
    'go ahead', 'sounds good', 'correct', 'proceed',
    'definitely', 'absolutely', 'of course', 'alright', 'agreed',
    'thats correct', 'that is correct', 'yes please', 'confirmed',
    'right', 'exactly', 'perfect', 'great', 'do it',
    'yh', 'ye', 'k', 'kk', 'affirmative', 'aye',
  ],
  CANCEL: [
    'cancel', 'stop', 'exit', 'quit', 'no', 'nope', 'nah',
    'never mind', 'nevermind', 'forget it', 'i changed my mind',
    'i dont want', 'i do not want', 'not interested', 'not now',
    'maybe later', 'not today', 'scratch that',
    'remove', 'clear',
    // Extended natural-language cancel variants
    'cancel it', 'cancel that', 'cancel order', 'cancel booking',
    'i want to cancel', 'please cancel', 'end', 'abort',
    'no thanks', 'no thank you', 'dont bother', 'dont want it',
    'i want out', 'get me out', 'i want to stop', 'leave me',
    'not for me',
    // NOTE: "go back", "start over", "restart", "reset it" removed from CANCEL.
    // These are navigation intent, not cancellation intent. A customer at SELECT_ITEM
    // saying "go back" wants the previous menu, not their entire session wiped.
    // These now only appear in SHOW_MENU and are handled as navigation mid-flow.
  ],
  GREETING: [
    'hi', 'hello', 'hey', 'start', 'begin', 'good morning',
    'good afternoon', 'good evening', 'howdy', 'hiya', 'salaam', 'hola',
    'greetings', 'yo', 'sup', 'wassup', 'watsup', 'what up',
    'morning', 'afternoon', 'evening', 'good day', 'hi there',
    'hello there', 'hey there', 'helo', 'helo there',
    'salam', 'assalam', 'asalamu', 'asalam', 'peace', 'bless up',
  ],
  SHOW_MENU: [
    'menu', 'options', 'home', 'main menu', 'back', '0', 'show menu',
    'show options', 'go back', 'main', 'return to menu',
    'start over', 'beginning', 'go home', 'main page',
    'show me the menu', 'what do you have', 'what can i get',
    'what is available', "what's available", 'see menu',
    'view menu', 'see options', 'list', 'show list',
    'menu pls', 'see all', 'restart',
  ],
  PAYMENT: [
    'payment', 'pay', 'wave', 'how to pay', 'how do i pay',
    'total', 'amount', 'mobile money', 'send payment',
    'how much', 'how much is it', 'what is the total',
    'payment method', 'how can i pay', 'do you accept',
    'transfer', 'bank', 'cash', 'fee', 'pay now', 'make payment',
    'cost', 'charges', 'wave payment',
  ],
  TRACK_ORDER: [
    'track', 'tracking', 'where is my order', 'order status',
    'delivery status', 'my order', 'track order',
    'check order', 'order update', 'where is it', 'status',
    'has my order', 'when will', 'track my order', 'order tracking',
    'is my order ready', 'when is my order',
  ],
  SUPPORT: [
    // Core support triggers
    'support', 'agent', 'human', 'real person', 'live agent',
    'speak to someone', 'talk to someone', 'speak to a human',
    'talk to a human', 'speak to agent', 'connect me to agent',
    'contact support', 'get help', 'need help', 'i need help',
    'help me', 'help please',
    // Complaints and problems
    'complaint', 'complain', 'problem', 'issue', 'something wrong',
    'this is wrong', 'wrong order', 'missing item', 'not happy',
    'unhappy', 'upset', 'frustrated', 'this is bad', 'terrible',
    'awful', 'unacceptable', 'fix this', 'sort this out',
    // Payment problems
    'my payment failed', 'payment rejected', 'payment problem',
    'payment issue', 'i paid already', 'i already paid',
    'wave issue', 'didnt receive', 'not received',
    // Delivery problems
    'my order is late', 'order not arrived', 'where is my food',
    'late delivery', 'delivery problem', 'i want a refund', 'refund',
    // West African / Gambian expressions
    'abeg help me', 'make them call me', 'i want to complain',
    'i wan complain', 'call me', 'call me back', 'someone call me',
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

// ─── Protected steps — flow LOCKS these completely ────────────────────────────
// v7 principle: structured input steps (image, number, date, time, address)
// cannot be interrupted by AI or a mis-fired intent. Only CANCEL/CONFIRM escape.

const PROTECTED_STEPS = new Set([
  'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM',
  'QUANTITY', 'SELECT_ITEM', 'SELECT_SERVICE',
  'CONFIRM', 'INTERRUPT', 'PAYMENT_PROOF', 'UPSELL',
]);

// ─── Greeting regex (fast path, mirrors v7) ───────────────────────────────────

const GREETING_REGEX =
  /^(hi|hello|hey|good morning|good evening|good afternoon|salaam|salam|hola|start|begin|greetings|yo|sup|wassup|watsup|hiya|helo)\b/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function strictMatch(normalized) {
  for (const [intent, phrases] of Object.entries(STRICT_INTENTS)) {
    if (phrases.includes(normalized)) return intent;
  }
  return null;
}

function isRejection(normalized) {
  return REJECTION_PHRASES.some(p =>
    p.length <= 4 ? normalized === p : normalized.includes(p)
  );
}

function isPaymentQuery(normalized) {
  return STRICT_INTENTS.PAYMENT.some(p => normalized.includes(p));
}

function buildSuggestion(normalized) {
  if (normalized.length < 3) return null;
  let bestIntent = null, bestPhrase = null, bestDist = Infinity;

  for (const [intent, phrases] of Object.entries(STRICT_INTENTS)) {
    if (['CONFIRM', 'CANCEL', 'GREETING', 'SHOW_MENU'].includes(intent)) continue;
    for (const phrase of phrases) {
      const dist    = levenshtein.get(normalized, phrase);
      const maxDist = phrase.length <= 5 ? 1 : phrase.length <= 10 ? 2 : 3;
      if (dist <= maxDist && dist < bestDist) {
        bestDist = dist; bestIntent = intent; bestPhrase = phrase;
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
    SUPPORT:      'Contact Support',
  }[bestIntent] || bestPhrase;

  return { intent: bestIntent, phrase: displayPhrase, distance: bestDist };
}

function enforceMode(intent, business) {
  const cfg = getModeConfig(business);
  if (intent === 'ORDER'   && !cfg.flows.includes('ORDER'))   return 'RESTRICT_ORDER';
  if (intent === 'BOOKING' && !cfg.flows.includes('BOOKING')) return 'RESTRICT_BOOKING';
  return intent;
}

function looksLikeBotEcho(raw, session) {
  const last = session?.lastBotMessage;
  if (!last || !raw || raw.length > 80) return false;
  const rn = normalizeInput(raw);
  const ln = normalizeInput(last).slice(0, 80);
  return rn === ln || ln.startsWith(rn.slice(0, 20));
}

function logDecision({ raw, normalized, intent, flowTriggered, suggestion, aiUsed, action, source }) {
  logger.info('[Brain] Decision', {
    raw, normalized,
    intent:        intent  || 'null',
    action,
    flowTriggered: !!flowTriggered,
    suggestion:    suggestion ? `"${suggestion.phrase}" (${suggestion.intent})` : null,
    aiUsed:        !!aiUsed,
    source:        source  || 'unknown',
  });
}

// ─── Main think() ─────────────────────────────────────────────────────────────
//
// Returns a decision object. NEVER calls AI directly.
//
// Decision shapes:
//   { action: 'IGNORE' }
//   { action: 'GREET' }
//   { action: 'SHOW_MENU' }
//   { action: 'START_ORDER' }
//   { action: 'START_BOOKING' }
//   { action: 'CONFIRM' }
//   { action: 'CANCEL' }
//   { action: 'ENQUIRY', intent }
//   { action: 'SUPPORT', intent }
//   { action: 'TRACK_ORDER', intent }
//   { action: 'REPEAT_ORDER', intent }
//   { action: 'AI_PAYMENT_HELP', intent }
//   { action: 'RESTRICT_ORDER' | 'RESTRICT_BOOKING', reply }
//   { action: 'CONTINUE_FLOW' }
//   { action: 'INTERRUPT', intent, ui, reply }
//   { action: 'REJECT_FLOW' }
//   { action: 'CLARIFY', ui? }
//   { action: 'SUGGEST', suggestion, reply }
//   { action: 'ABOUT', intent }
//   { action: 'AI_FALLBACK', intent, ui? }

export const think = async ({ message, session, business, phone }) => {
  const raw        = String(message || '').trim();
  const normalized = normalizeInput(raw);

  // 0. Echo guard — ignore bot-echoed messages
  if (looksLikeBotEcho(raw, session)) {
    logDecision({ raw, normalized, intent: 'IGNORE', action: 'IGNORE', source: 'echo' });
    return { action: 'IGNORE' };
  }

  // 0b. Name capture (async, non-blocking)
  const extractedName = extractCustomerName(raw);
  if (extractedName && session && !session.customerName) {
    updateSession(session.customerPhone, session.tenantId, { customerName: extractedName }).catch(() => {});
    logger.info('[Brain] Customer name captured', { name: extractedName, phone });
  }

  // 0c. Message count / lastSeen (async, non-blocking)
  if (session) {
    updateSession(session.customerPhone, session.tenantId, {
      messageCount: (session.messageCount || 0) + 1,
      lastSeen: new Date(),
    }).catch(() => {});
  }

  // 1. Button ID — highest priority, no AI ever
  const buttonIntentRaw = BUTTON_ID_MAP[raw.toUpperCase()];
  if (buttonIntentRaw) {
    const finalBtn = enforceMode(buttonIntentRaw, business);
    logDecision({ raw, normalized, intent: finalBtn, action: finalBtn, flowTriggered: true, source: 'button' });
    trackUser(phone, raw, finalBtn).catch(() => {});

    if (['SWITCH_YES', 'SWITCH_NO', 'UPSELL_YES', 'UPSELL_NO'].includes(finalBtn)) return { action: 'CONTINUE_FLOW' };
    if (session?.currentFlow && !['CANCEL', 'CONFIRM', 'SHOW_MENU'].includes(finalBtn)) return { action: 'CONTINUE_FLOW' };

    if (finalBtn === 'ORDER')        return { action: 'START_ORDER' };
    if (finalBtn === 'BOOKING')      return { action: 'START_BOOKING' };
    if (finalBtn === 'CONFIRM')      return { action: 'CONFIRM' };
    if (finalBtn === 'CANCEL')       return { action: 'CANCEL' };
    if (finalBtn === 'QUESTION')     return { action: 'ENQUIRY', intent: 'QUESTION' };
    if (finalBtn === 'TRACK_ORDER')  return { action: 'TRACK_ORDER', intent: 'TRACK_ORDER' };
    if (finalBtn === 'REPEAT_ORDER') return { action: 'REPEAT_ORDER', intent: 'REPEAT_ORDER' };
    return { action: 'CONTINUE_FLOW' };
  }

  // 2. "0" shortcut → always show menu
  if (raw === '0') {
    logDecision({ raw, normalized, intent: 'SHOW_MENU', action: 'SHOW_MENU', source: 'shortcut' });
    return { action: 'SHOW_MENU' };
  }

  // 3. Greeting — snaps to welcome ONLY when no flow is active.
  //    Mid-flow greetings (e.g. "hi thanks", "ok hello") are treated as
  //    CONTINUE_FLOW so the customer never loses their order/booking by saying "hi".
  if (GREETING_REGEX.test(raw)) {
    if (session?.currentFlow) {
      // Mid-flow greeting — pass to flow unchanged (e.g. "hi" at QUANTITY is noise)
      logDecision({ raw, normalized, intent: 'GREETING', action: 'CONTINUE_FLOW', source: 'greeting-mid-flow' });
      return { action: 'CONTINUE_FLOW' };
    }
    logDecision({ raw, normalized, intent: 'GREETING', action: 'GREET', source: 'greeting-regex' });
    return { action: 'GREET' };
  }

  // 4. Emoji intent (only outside flows to avoid polluting flow state)
  const emojiIntent = detectEmojiIntent(raw);
  if (emojiIntent && !session?.currentFlow) {
    const finalEmoji = enforceMode(emojiIntent, business);
    logDecision({ raw, normalized, intent: finalEmoji, action: finalEmoji, flowTriggered: true, source: 'emoji' });
    if (finalEmoji === 'ORDER')     return { action: 'START_ORDER' };
    if (finalEmoji === 'BOOKING')   return { action: 'START_BOOKING' };
    if (finalEmoji === 'QUESTION')  return { action: 'ENQUIRY', intent: 'QUESTION' };
    if (finalEmoji === 'PAYMENT')   return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    if (finalEmoji === 'SHOW_MENU') return { action: 'SHOW_MENU' };
  }

  // 5. Number shortcuts (context-aware per mode, only outside flows)
  if (!session?.currentFlow) {
    // Accept both digits ("1") and word-numbers ("one", "two", "three")
    const _MENU_WORD_NUMS = { one:1,wan:1,wun:1, two:2,tow:2,tu:2, three:3,tree:3, four:4,fore:4, five:5,fiv:5 };
    const num = parseInt(raw, 10);
    const numFromWord = _MENU_WORD_NUMS[raw.trim().toLowerCase()];
    const resolvedNum = !isNaN(num) ? num : (numFromWord !== undefined ? numFromWord : NaN);
    const cfg      = getModeConfig(business);
    const canOrder = cfg.flows.includes('ORDER');
    const canBook  = cfg.flows.includes('BOOKING');

    if (canOrder && canBook) {
      if (resolvedNum === 1) return { action: 'START_ORDER' };
      if (resolvedNum === 2) return { action: 'START_BOOKING' };
      if (resolvedNum === 3) return { action: 'ENQUIRY', intent: 'QUESTION' };
    } else if (canOrder) {
      if (resolvedNum === 1) return { action: 'START_ORDER' };
      if (resolvedNum === 2) return { action: 'ENQUIRY', intent: 'QUESTION' };
    } else if (canBook) {
      if (resolvedNum === 1) return { action: 'START_BOOKING' };
      if (resolvedNum === 2) return { action: 'ENQUIRY', intent: 'QUESTION' };
    }
  }

  // 6. Rejection
  if (isRejection(normalized)) {
    logDecision({ raw, normalized, intent: 'REJECTED', action: 'CLARIFY', source: 'rejection' });
    if (session?.currentFlow) return { action: 'REJECT_FLOW' };
    return { action: 'CLARIFY', ui: buildOptionsUI(business) };
  }

  // 7. Active flow — flow owns this message
  if (session?.currentFlow) {

    // Internal flow signals pass straight through
    if (['SWITCH_YES','SWITCH_NO','UPSELL_YES','UPSELL_NO'].includes(normalized.toUpperCase())) {
      return { action: 'CONTINUE_FLOW' };
    }

    // PROTECTED steps — only CANCEL/CONFIRM escape; everything else is owned by the flow
    if (PROTECTED_STEPS.has(session.step)) {
      // Exception: payment queries in PAYMENT_PROOF step can get AI help
      if (session.step === 'PAYMENT_PROOF' && isPaymentQuery(normalized)) {
        logDecision({ raw, normalized, intent: 'PAYMENT', action: 'AI_PAYMENT_HELP', aiUsed: true, source: 'payment-in-proof' });
        return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
      }
      const strictHere = strictMatch(normalized);
      if (strictHere === 'CANCEL')    return { action: 'CANCEL' };
      if (strictHere === 'CONFIRM')   return { action: 'CONFIRM' };
      // FIX: "menu"/"go back" at a protected step → CANCEL (triggers confirm-cancel UI)
      if (strictHere === 'SHOW_MENU') return { action: 'CANCEL' };
      // Everything else — flow owns it, no AI
      logDecision({ raw, normalized, intent: null, action: 'CONTINUE_FLOW', source: 'protected-step' });
      return { action: 'CONTINUE_FLOW' };
    }

    // Non-protected flow steps — limited safe exits
    const strictInFlow = strictMatch(normalized);

    if (strictInFlow === 'CANCEL')      return { action: 'CANCEL' };
    if (strictInFlow === 'CONFIRM')     return { action: 'CONFIRM' };
    // FIX: SHOW_MENU mid-flow → ask to confirm cancel rather than immediately wiping session.
    // "menu", "go back", "start over" etc. mid-order now prompt the customer to confirm
    // they want to leave before destroying their cart/booking state.
    if (strictInFlow === 'SHOW_MENU')   return { action: 'CANCEL' };
    if (strictInFlow === 'QUESTION')    return { action: 'ENQUIRY', intent: 'QUESTION' };
    if (strictInFlow === 'SUPPORT')     return { action: 'SUPPORT', intent: 'SUPPORT' };
    if (strictInFlow === 'PAYMENT')     return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    if (strictInFlow === 'TRACK_ORDER') return { action: 'TRACK_ORDER', intent: 'TRACK_ORDER' };

    // Different flow intent → ask user to confirm switch (never auto-switch)
    if (
      strictInFlow &&
      !['CONFIRM','CANCEL','GREETING','SHOW_MENU','PAYMENT','TRACK_ORDER','REPEAT_ORDER'].includes(strictInFlow)
    ) {
      const enforced = enforceMode(strictInFlow, business);
      if (!['RESTRICT_ORDER','RESTRICT_BOOKING'].includes(enforced)) {
        const uiObj = buildInterruptUI(business, session.currentFlow, enforced);
        logDecision({ raw, normalized, intent: enforced, action: 'INTERRUPT', source: 'flow-switch' });
        return { action: 'INTERRUPT', intent: enforced, ui: uiObj, reply: uiObj.body };
      }
    }

    // Payment query anywhere in flow → AI payment help (non-destructive)
    if (isPaymentQuery(normalized)) {
      logDecision({ raw, normalized, intent: 'PAYMENT', action: 'AI_PAYMENT_HELP', aiUsed: true, source: 'payment-in-flow' });
      return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    }

    // About/info question in flow → AI info only, flow resumes after
    // [v12 Fix 1] Only for genuinely about-business questions (not short/garbled inputs)
    if (raw.trim().length >= 10 && isAboutQuestion(raw)) {
      logDecision({ raw, normalized, intent: 'ABOUT', action: 'AI_FALLBACK', aiUsed: true, source: 'about-in-flow' });
      return { action: 'AI_FALLBACK', intent: 'ABOUT' };
    }

    // [v12 Fix 1] Unknown free text in flow → AI fallback ONLY when clearly conversational.
    // Short messages, numbers, word-numbers ("twelve", "four"), and single-word inputs
    // route to CONTINUE_FLOW so flowService can parse them natively (e.g. as quantities).
    // Threshold: >= 10 chars AND not a pure digit AND not a single word (<=6 chars).
    if (
      raw.trim().length >= 10 &&
      !/^\d+$/.test(raw.trim()) &&
      !/^\w{1,6}$/.test(raw.trim())
    ) {
      logDecision({ raw, normalized, intent: null, action: 'AI_FALLBACK', aiUsed: true, source: 'unknown-in-flow' });
      return { action: 'AI_FALLBACK', intent: 'FALLBACK' };
    }

    // Short / single-word / numeric unknown → flow owns it (quantity, item name, etc.)
    return { action: 'CONTINUE_FLOW' };
  }

  // 8. No active flow — strict exact match
  const strictIntent = strictMatch(normalized);

  if (strictIntent) {
    const finalIntent = enforceMode(strictIntent, business);
    trackUser(phone, raw, finalIntent).catch(() => {});
    logDecision({ raw, normalized, intent: finalIntent, action: finalIntent, source: 'strict' });

    if (finalIntent === 'ORDER')          return { action: 'START_ORDER' };
    if (finalIntent === 'BOOKING')        return { action: 'START_BOOKING' };
    if (finalIntent === 'QUESTION') {
      if (session) updateSession(session.customerPhone, session.tenantId, { lastIntent: 'QUESTION' }).catch(() => {});
      return { action: 'ENQUIRY', intent: 'QUESTION' };
    }
    if (finalIntent === 'GREETING' || finalIntent === 'SHOW_MENU') return { action: 'GREET' };
    if (finalIntent === 'PAYMENT')        return { action: 'AI_PAYMENT_HELP', intent: 'PAYMENT' };
    if (finalIntent === 'TRACK_ORDER')    return { action: 'TRACK_ORDER', intent: 'TRACK_ORDER' };
    if (finalIntent === 'REPEAT_ORDER')   return { action: 'REPEAT_ORDER', intent: 'REPEAT_ORDER' };
    if (finalIntent === 'SUPPORT')        return { action: 'SUPPORT', intent: 'SUPPORT' };
    if (finalIntent === 'CONFIRM' || finalIntent === 'CANCEL') return { action: 'SHOW_MENU' };

    if (finalIntent === 'RESTRICT_ORDER')   return { action: 'RESTRICT_ORDER',   reply: getModeRestrictionMessage(business, 'ORDER') };
    if (finalIntent === 'RESTRICT_BOOKING') return { action: 'RESTRICT_BOOKING', reply: getModeRestrictionMessage(business, 'BOOKING') };
  }

  // 9. Similarity suggestion — SUGGEST only, NEVER execute
  const suggestion = buildSuggestion(normalized);
  if (suggestion) {
    logDecision({ raw, normalized, intent: null, action: 'SUGGEST', source: 'similarity', suggestion });
    return { action: 'SUGGEST', suggestion, reply: `Did you mean *${suggestion.phrase}*?` };
  }

  // 10. About-question → AI answers, then shows options (no flow trigger)
  if (raw.trim().length >= 4 && isAboutQuestion(raw)) {
    logDecision({ raw, normalized, intent: 'ABOUT', action: 'ABOUT', aiUsed: true, source: 'about-question' });
    return { action: 'ABOUT', intent: 'INQUIRY' };
  }

  // 11. Long unknown → AI fallback (info only + CTA options, no flow trigger)
  if (raw.trim().length >= 4) {
    logDecision({ raw, normalized, intent: null, action: 'AI_FALLBACK', aiUsed: true, source: 'unknown-long' });
    return { action: 'AI_FALLBACK', intent: null, ui: buildOptionsUI(business) };
  }

  // 12. Short unknown → clarify with options
  logDecision({ raw, normalized, intent: null, action: 'CLARIFY', source: 'short-unknown' });
  return { action: 'CLARIFY', ui: buildOptionsUI(business) };
};
