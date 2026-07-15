/**
 * core/intents/intentEngine.js
 *
 * DEDICATED INTENT ENGINE — the single decision brain.
 *
 * Detection order (strict):
 *   1. Button / list reply ID   → instant, zero AI
 *   2. Emoji shortcuts          → instant
 *   3. Greeting patterns        → instant
 *   4. Exact keyword map        → instant
 *   5. Levenshtein suggestion   → "did you mean?" only, never auto-execute
 *   6. AI classify              → ONLY if message ≥8 chars & non-numeric
 *   7. FALLBACK                 → default catch-all
 *
 * GOLDEN RULES:
 *   - Buttons always win. If it came from a button tap, trust the ID.
 *   - AI never triggers flows directly. It returns an intent, human confirms.
 *   - Short/numeric inputs (qty, date digits) → CONTINUE_FLOW always.
 *   - Active flows own their messages. Only CANCEL/CONFIRM can escape.
 */

import levenshtein from 'fast-levenshtein';
import { INTENT_PATTERNS, BUTTON_ID_MAP, EMOJI_MAP } from './patterns.js';
import { getAIReply } from '../ai/providers/aiRouter.js';
import logger from '../../config/logger.js';

// [GROQ-STRUCT-1 / PHASE-2] Confidence-tier policy for the AI classify step.
// Mirrors the "Confidence Policy" in the merged conversational-intelligence spec:
//   >= AI_EXECUTE_CONFIDENCE  -> execute the mapped action immediately
//   >= AI_CLARIFY_CONFIDENCE  -> ask exactly one clarification question (CLARIFY)
//   below that                -> don't change workflow, fall through to fallback
export const AI_EXECUTE_CONFIDENCE = 0.92;
export const AI_CLARIFY_CONFIDENCE = 0.70;

// [UPGRADE-DIRECT-INTENT / UPGRADE-DIRECT-INTENT-2] Step 4.5 — natural phrasing
// that unambiguously asks to order or book ("I want to order food please", "can
// I book a table for tonight") falls too far outside Levenshtein's edit-distance
// window to match the step-4 whole-message keyword list, so it used to fall
// through to AI classify (may be UNKNOWN) → FALLBACK, showing the generic
// welcome menu instead of the customer's actual request.
//
// DIRECT_INTENT_EXCLUDE_RE guards against hijacking cancellation, tracking,
// status-check, or negated phrasing ("cancel my order", "where is my order",
// "I don't want to book") — checked BEFORE the order/booking regexes.
// [AUDIT-FIX-DIRECT-INTENT-3] normalise() turns apostrophes into spaces, so
// "don't" becomes "don t" — both the bare "don'?t" form (pre-normalisation
// safety) and the space-separated "don t" form (actual post-normalisation
// shape) are listed so negation is never missed.
export const DIRECT_INTENT_EXCLUDE_RE = new RegExp(
  '\\b(' + [
    'cancel', 'cancle', "don'?t", 'don t', 'do not', 'dont', 'stop',
    'no longer', 'nevermind', 'never mind', 'nvm', 'not interested',
    'track', 'status', 'where is', 'where s', 'when is', 'update',
    'how long', 'refund', 'reject', 'decline',
  ].join('|') + ')\\b' + '|\\bcheck\\w*\\b'
);
// Widened v2 vocabulary — catches requests that don't contain the literal
// word "order"/"book" (e.g. "give me 2 burgers", "table for tonight").
export const ORDER_DIRECT_RE   = /\b(order|buy|purchase|shopping|can i get|can i have|i ll have|i ll take|give me|get me|i want|i d like|craving)\b/;
export const BOOKING_DIRECT_RE = /\b(book|reserve|reservation|appointment|table for|party of|table at|table tonight|come in|slot for|availability for)\b/;

// ── Normalise ─────────────────────────────────────────────────────────────────
export const normalise = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Name extraction ───────────────────────────────────────────────────────────
// [FIX-NAME-6] Explicit-declaration-only approach.
//
// ROOT CAUSE of "You're welcome, Hi!" bug:
//   "i am hi" matched the old pattern /(?:i am|i'm)\s+.../i → candidate "hi"
//   "hi" was NOT in BAD_NAME_WORDS → stored as customerName in DB/session
//   On next message the DISPLAY guard (NOISE set) filtered it out inconsistently.
//
// THE FIX — three changes:
//   1. Remove "i am" and "i'm" entirely from NAME_PATTERNS.
//      In English these express STATE ("i am here", "i am hungry", "i am hi"),
//      NOT identity. They are not reliable name signals under any circumstances.
//   2. Remove the implicit bare-capitalised-word pattern entirely.
//      A bare "Hi", "Ok", "Sure" would match it and greetings are capitalised
//      in WhatsApp. Far too many false positives.
//   3. Only "my name is X", "call me X", "name's X" remain — these unambiguously
//      express identity. Every extracted candidate still goes through per-word
//      quality guards (min 3 chars, must have vowel, no repeated chars, not in
//      the expanded blocklist).
//
// The bot now ONLY learns a customer's name when they explicitly say
// "my name is Lamin" / "call me Fatou" / "name's Binta".
// It never guesses from greetings, status messages, or short replies.
const NAME_PATTERNS = [
  /(?:my name is|call me|name[''']?s)\s+([a-zA-Z][a-zA-Z\s]{2,29})/i,
];

// Expanded blocklist — covers every word that "i am X" used to extract as a name.
// Also covers bare-caps false positives and common WhatsApp filler.
const BAD_NAME_WORDS = new Set([
  // Greetings (were stored via "i am hi", bare-caps "Hi", etc.)
  'hi','hey','hello','hiya','howdy','yo','sup','greetings','salaam','salam',
  // State / status ("i am here", "i am ready", etc.)
  'here','home','work','ready','waiting','coming','hungry','busy','free',
  'available','late','early','soon','now','out','away','back','around',
  'outside','inside','upstairs','downstairs','online','offline','present',
  // Common acknowledgements and filler
  'fine','done','okay','ok','sure','alright','well','good','great','nice',
  'yes','no','yep','yah','nope','thanks','thank','please','sorry','noted',
  'received','understood','cheers','cool','brilliant','wonderful','awesome',
  // Commerce / order words
  'want','like','need','have','know','going','looking','order','book',
  'start','over','first','time','help','menu','cancel','show','more',
  'next','send','check','new','buy','get','food','table','question',
  'support','delivery','pickup','price','today','tomorrow','morning',
  'evening','night','this','that','just','also','still','again',
  'already','always','never','maybe','really','very','much','little','only',
  // Keyboard noise
  'hhhh','hihi','hehe','lol','haha','aaaa','oooo','test',
]);

// Repeated-character guard: rejects "Hhhh", "Aaaa", "Hiiii".
// A real name must not have a single character dominating more than 50% of its letters.
function hasRepeatedChars(word) {
  const lower = word.toLowerCase();
  const freq  = {};
  for (const c of lower) freq[c] = (freq[c] || 0) + 1;
  return Object.values(freq).some(n => n / lower.length > 0.5);
}

// Vowel guard: every word in a real name must contain at least one vowel.
// Rejects keyboard spam like "Hdkl", "Zxcv", "Brtns".
function hasVowel(word) {
  return /[aeiou]/i.test(word);
}

export function extractCustomerName(raw = '') {
  for (const pattern of NAME_PATTERNS) {
    const m = raw.match(pattern);
    if (!m) continue;
    const candidate = m[1].trim();

    // Must be letters and spaces only — no digits, punctuation, or emoji
    if (!/^[a-zA-Z\s]+$/.test(candidate)) continue;

    // Whole-candidate blocklist check (case-insensitive)
    if (BAD_NAME_WORDS.has(candidate.toLowerCase())) continue;

    // Per-word quality guards — applied to BOTH tiers now
    const words = candidate.split(/\s+/);
    const allWordsValid = words.every(w =>
      w.length >= 3 &&        // min 3 chars per word — blocks "hi", "ok", "yo"
      hasVowel(w) &&          // must have a vowel — blocks "Hdkl", "Zxcv"
      !hasRepeatedChars(w) && // no char dominance — blocks "Hhhh", "Aaaa"
      !BAD_NAME_WORDS.has(w.toLowerCase()) // each individual word also checked
    );
    if (!allWordsValid) continue;

    // Final length guard: 3–40 chars total
    if (candidate.length >= 3 && candidate.length <= 40) return candidate;
  }
  return null;
}

// [PHASE-3] Intents that ask for business information rather than starting/continuing
// a transactional flow. Used by webhookController.js to detect the "order + also asked
// about delivery" multi-intent case: primary action starts/continues a flow, and if the
// AI also flagged one of these as a secondary intent, that question gets answered too
// instead of silently dropped. Exported (additive only) — a plain lookup, no behavior
// change to detectIntent()'s own routing.
const INFORMATIONAL_INTENTS = new Set([
  'QUESTION', 'PAYMENT', 'SPEC_REQUEST', 'SKINCARE_ADVICE', 'WARRANTY_INFO',
  'AVAILABILITY_CHECK', 'AFTERCARE', 'PRODUCT_INQUIRY', 'COMPATIBILITY_CHECK',
  'SIZE_GUIDE', 'RECOMMENDATION',
]);

export function isInformationalIntent(intent) {
  return INFORMATIONAL_INTENTS.has(intent);
}

// ── Core detect ───────────────────────────────────────────────────────────────

/**
 * detectIntent({ message, isInteractive, session, business })
 *
 * @returns {
 *   action: string,        // 'START_ORDER' | 'START_BOOKING' | 'GREET' | etc.
 *   intent: string,        // same or more specific
 *   confidence: 'HIGH'|'LOW'|'AI',
 *   source: string,        // 'button'|'emoji'|'keyword'|'ai'|'fallback'
 *   suggestion?: string,   // for Levenshtein "did you mean" only
 * }
 */
export async function detectIntent({ message, isInteractive = false, session, business }) {
  const raw    = String(message || '').trim();
  const clean  = normalise(raw);
  const upper  = raw.trim().toUpperCase();

  // ── 1. Button / interactive reply ID ──────────────────────────────────────
  if (isInteractive && raw) {
    const mapped = BUTTON_ID_MAP[upper] || BUTTON_ID_MAP[raw];
    if (mapped) {
      return { action: mapped, intent: mapped, confidence: 'HIGH', source: 'button' };
    }
    // Interactive but unmapped ID — treat as CONTINUE_FLOW
    return { action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH', source: 'button' };
  }

  // ── 2. Emoji shortcut ──────────────────────────────────────────────────────
  // [FIX] EMOJI_MAP values are raw intent strings (ORDER, BOOKING, QUESTION etc.)
  // but route() and ACTION_REGISTRY expect action strings (START_ORDER, START_BOOKING,
  // ENQUIRY etc.). Previously emoji taps silently fell to FALLBACK because route()
  // has no case for ORDER or BOOKING. Now runs through intentToAction().
  for (const [emoji, intent] of Object.entries(EMOJI_MAP)) {
    if (raw.includes(emoji)) {
      const action = intentToAction(intent, business);
      return { action, intent, confidence: 'HIGH', source: 'emoji' };
    }
  }

  // ── 3. Digit / very short (likely quantity or noise) ──────────────────────
  if (/^\d+$/.test(raw) || raw.length <= 1) {
    return { action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH', source: 'numeric' };
  }

  // ── 4. Exact keyword match ────────────────────────────────────────────────
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    if (keywords.includes(clean)) {
      const action = intentToAction(intent, business);
      return { action, intent, confidence: 'HIGH', source: 'keyword' };
    }
  }

  // ── 4.5. Direct ORDER / BOOKING phrase match [UPGRADE-DIRECT-INTENT] ──────
  // Pre-flow only — active flows own their own messages (GOLDEN RULES). Booking
  // is checked before order: widened ORDER_DIRECT_RE includes phrases like
  // "i d like" (post-normalise "I'd like") that also appear inside genuine
  // booking requests ("I'd like to book a table"), so booking must win first.
  if (!session?.currentFlow && !DIRECT_INTENT_EXCLUDE_RE.test(clean)) {
    if (BOOKING_DIRECT_RE.test(clean)) {
      return { action: 'START_BOOKING', intent: 'BOOKING', confidence: 'HIGH', source: 'direct-phrase' };
    }
    if (ORDER_DIRECT_RE.test(clean)) {
      return { action: 'START_ORDER', intent: 'ORDER', confidence: 'HIGH', source: 'direct-phrase' };
    }
  }

  // ── 5. Partial match with Levenshtein (suggest only, never auto-execute) ──
  let suggestion = null;
  let suggIntent = null;
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    for (const kw of keywords) {
      if (Math.abs(kw.length - clean.length) > 4) continue;
      const dist = levenshtein.get(clean, kw);
      if (dist <= 2 && dist < (suggestion?.dist ?? Infinity)) {
        suggestion = { kw, dist, intent };
        suggIntent = intent;
      }
    }
  }

  // ── 6. Short inputs → FALLBACK/CLARIFY or CONTINUE_FLOW ──────────────────
  // In-flow short replies (<8 chars) still short-circuit to CONTINUE_FLOW without
  // reaching AI classify — active flows own their own messages (GOLDEN RULES).
  if (raw.length < 8 && session?.currentFlow) {
    return { action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH', source: 'short' };
  }
  // [UPGRADE-DIRECT-INTENT-2] Pre-flow threshold lowered from <8 to <4 chars —
  // short-but-real requests ("buy 2", "book pls") now get a chance at step 7 AI
  // classification instead of going straight to CLARIFY/FALLBACK. Only messages
  // under 4 chars pre-flow (almost always a typo or accidental send) skip AI.
  if (!session?.currentFlow && raw.length < 4) {
    if (suggestion) {
      logger.info('[IntentEngine] miss', { path: 'short-fallback', message: raw, suggestion: suggIntent });
      return {
        action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'levenshtein',
        suggestion: suggIntent,
      };
    }
    logger.info('[IntentEngine] miss', { path: 'short-fallback', message: raw });
    return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'fallback' };
  }

  // ── 7. AI classify (last resort — multi-word, non-numeric messages only) ──
  // [FIX-INTENT-AI] Skip AI classify when session is already in an active flow
  // that owns the input (e.g. ENQUIRY:AWAITING_QUESTION). The flow engine handles
  // it at step 13/15 of webhookController — running the classifier here wastes a
  // Groq API call and risks overriding the flow handler with an incorrect intent.
  if (!session?.currentFlow) {
    try {
      const decision = await classifyWithAI({ message: raw, business });

      // [PHASE-2] Defense in depth: never execute a workflow action on a message
      // the AI flagged as negated or a cancellation, even if primaryIntent looks
      // confident — the confidence score reflects intent-word certainty, not
      // polarity. "I don't want food" must never fire START_ORDER.
      const blocked = decision.negated || decision.cancellation;

      if (!blocked && decision.primaryIntent !== 'UNKNOWN' && decision.confidence >= AI_EXECUTE_CONFIDENCE) {
        const action = intentToAction(decision.primaryIntent, business);
        return { action, intent: decision.primaryIntent, confidence: 'AI', source: 'ai', aiSignals: decision };
      }

      if (!blocked && decision.primaryIntent !== 'UNKNOWN' && decision.confidence >= AI_CLARIFY_CONFIDENCE) {
        // Probable, not certain — ask exactly one clarification question rather
        // than guessing. Reuses the existing CLARIFY/suggestion path so downstream
        // handling (moduleRouter's FALLBACK/CLARIFY case) is unchanged.
        logger.info('[IntentEngine] AI classify below execute threshold — asking for clarification', {
          messagePreview: raw.slice(0, 60), primaryIntent: decision.primaryIntent, confidence: decision.confidence,
        });
        return {
          action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'ai-clarify',
          suggestion: decision.primaryIntent, aiSignals: decision,
        };
      }

      if (blocked || decision.primaryIntent !== 'UNKNOWN') {
        // Miss-logging: negated/cancelled/low-confidence AI reads are useful audit
        // signal even though we deliberately don't act on them here.
        logger.info('[IntentEngine] AI classify did not clear confidence/negation gate', {
          messagePreview: raw.slice(0, 60), primaryIntent: decision.primaryIntent,
          confidence: decision.confidence, negated: decision.negated, cancellation: decision.cancellation,
        });
      }
    } catch (err) {
      logger.warn('[IntentEngine] AI classify failed', { err: err.message });
    }
  }

  // ── 8. Final fallback ──────────────────────────────────────────────────────
  if (suggestion) {
    logger.info('[IntentEngine] miss', { path: 'clarify', message: raw, suggestion: suggIntent });
    return {
      action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'levenshtein',
      suggestion: suggIntent,
    };
  }

  logger.info('[IntentEngine] miss', { path: 'final-fallback', message: raw });
  return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'fallback' };
}

// ── AI intent classifier ──────────────────────────────────────────────────────
// [PHASE-2] Upgraded from groqProvider.classifyIntent() (bare intent word) to
// groqProvider.classifyIntentStructured() (intent + confidence/negation/emotion/
// cancellation/correction signals). classifyIntent() itself is untouched — it's
// still used as-is by postFlowHandler.js for sentiment tiebreaking. Only this
// private, intentEngine-internal call site is upgraded, so nothing outside this
// file is affected.
//
// Always returns a fully-shaped decision object — never throws, never returns
// a bare string — so callers don't need their own null/shape checks.
async function classifyWithAI({ message, business }) {
  const mode         = (business?.businessMode || 'RETAIL').toUpperCase();
  const validIntents = getValidIntents(mode);

  // [FIX-AI-1] Sanitise customer input before embedding it in the prompt.
  const sanitisedMsg = message
    .slice(0, 200)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[<>]/g, '')
    .trim();

  const SAFE_DEFAULT = {
    primaryIntent: 'UNKNOWN', secondaryIntents: [], confidence: 0, emotion: 'neutral',
    urgency: 'normal', negated: false, confirmation: false, correction: false,
    cancellation: false, needsClarification: false, requiresHuman: false, reason: 'unavailable',
  };

  try {
    const { classifyIntentStructured } = await import('../ai/providers/groqProvider.js').catch(() => ({ classifyIntentStructured: null }));
    if (classifyIntentStructured && process.env.GROQ_API_KEY) {
      return await classifyIntentStructured({ message: sanitisedMsg, validIntents, mode });
    }
    // Groq not available — safe default so caller's fallback path runs.
    return SAFE_DEFAULT;
  } catch (err) {
    logger.warn('[IntentEngine] classifyWithAI failed', { err: err.message });
    return SAFE_DEFAULT;
  }
}

function getValidIntents(mode) {
  // [FIX-VALID-INTENTS] Added ACKNOWLEDGEMENT so AI can classify longer ack phrases
  // (e.g. "I really appreciated that", "much appreciated, thank you") that bypass the
  // keyword matcher (< 8 char threshold or not in the exact ACKNOWLEDGEMENT list).
  // Without this, the model could never return ACKNOWLEDGEMENT and would default to
  // QUESTION or SUPPORT for expressions of gratitude.
  const base = ['ORDER', 'BOOKING', 'WALKIN', 'QUESTION', 'SUPPORT', 'GREETING', 'PAYMENT', 'TRACK_ORDER', 'ACKNOWLEDGEMENT', 'UNKNOWN'];
  const extra = {
    RESTAURANT:  ['ADD_TO_CART', 'REMOVE_FROM_CART', 'CHECKOUT', 'RECOMMENDATION'],
    SALON:       ['AVAILABILITY_CHECK', 'AFTERCARE'],  // [FIX-AFTERCARE]
    // [FIX-BB-1] BARBERSHOP was absent from the extra intents map — the same
    // AVAILABILITY_CHECK intent that salon uses (to ask if a barber is free) was
    // completely unavailable to AI classification for barbershop tenants.
    BARBERSHOP:  ['AVAILABILITY_CHECK', 'AFTERCARE'],  // [FIX-AFTERCARE]
    BAKERY:      ['CAKE_CUSTOMIZATION', 'COLLECTION_SCHEDULE'],
    FASHION:     ['SIZE_GUIDE', 'PRODUCT_INQUIRY'],
    COSMETICS:   ['SKINCARE_ADVICE', 'RECOMMENDATION'],
    ELECTRONICS: ['SPEC_REQUEST', 'WARRANTY_INFO', 'COMPATIBILITY_CHECK'],
  };
  return [...base, ...(extra[mode] || [])];
}

// ── Map intent → action ───────────────────────────────────────────────────────
function intentToAction(intent, business) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const map = {
    ACKNOWLEDGEMENT:    'ACKNOWLEDGE',
    CANCEL_ALL:         'CANCEL_ALL',  // [FIX-CANCEL-ALL] bulk cancel all active orders
    // [FIX-CANCEL-TYPED] CANCEL_ORDER keyword intent (typed "cancel order") maps to
    // the same CANCEL action as the button tap. Previously 'cancel order' was in SUPPORT
    // and triggered a human escalation instead of the cancel handler.
    CANCEL_ORDER:       'CANCEL',
    ORDER:              'START_ORDER',
    BOOKING:            'START_BOOKING',
    SALON_BOOKING:      'START_BOOKING',
    CAKE_CUSTOMIZATION: 'CAKE_CUSTOMIZATION', // [FIX] was 'START_BOOKING' — launches booking, not cake builder
    // [FIX-INTENT-Q] QUESTION intent must map to 'QUESTION' action, not 'ENQUIRY'.
    // When a customer types "I have a question" or "opening hours", intent detection
    // fires QUESTION → intentToAction → ENQUIRY → startFlow('ENQUIRY') which for
    // SERVICES mode launches the quote-capture flow, and for GENERAL launches the
    // structured enquiry form — NOT the AI question handler the customer wanted.
    // Changing to 'QUESTION' ensures the typed path matches the button-tap path
    // (BUTTON_ID_MAP 'QUESTION' → 'QUESTION') and reaches the mode-specific
    // QUESTION flow handler via ACTION_REGISTRY in all modes.
    QUESTION:           'QUESTION',
    SUPPORT:            'SUPPORT',
    GREETING:           'GREET',
    PAYMENT:            'PAYMENT',
    TRACK_ORDER:        'TRACK_ORDER',
    REPEAT_ORDER:       'REPEAT_ORDER',
    SHOW_MENU:          'SHOW_MENU',
    ADD_TO_CART:        'START_ORDER',
    CHECKOUT:           'START_ORDER',
    REMOVE_FROM_CART:   'START_ORDER',       // re-enter order flow to adjust
    RECOMMENDATION:     'ENQUIRY',
    // [FIX] SPEC_REQUEST and SKINCARE_ADVICE were mapped to generic ENQUIRY.
    // That bypassed their dedicated flow handlers entirely — AI got the raw question
    // with zero product/skin context. Now they route to their registered actions.
    SPEC_REQUEST:       'SPEC_REQUEST',
    WARRANTY_INFO:      'WARRANTY',
    // [FIX-SALON-AVAIL] AVAILABILITY_CHECK for SALON/BARBERSHOP must reach the
    // mode-specific QUESTION flow (handleSalonQuestion) which has AI context about
    // services, staff, and hours. Previously routed to generic 'ENQUIRY' which for
    // salon had no registered flow — it fell back to the plain ENQUIRY path with zero
    // salon context. "Are you available Friday?" or "Is Maria free?" now reaches the
    // AI-powered salon Q&A handler which can answer with proper business context.
    AVAILABILITY_CHECK: 'QUESTION',
    // [AUDIT-FIX-2] AFTERCARE is listed in getValidIntents()'s SALON/BARBERSHOP extra
    // set, so the AI classifier is explicitly allowed to return it — but it was absent
    // from this map, so intentToAction() fell through to 'FALLBACK'. A customer asking
    // "how do I maintain my new hair colour?" on a fresh conversation (no currentFlow)
    // would get the generic fallback menu instead of being routed to the salon/barbershop
    // QUESTION handler, which already has its own aftercare-detection regex and AI context.
    // Mapped to 'QUESTION' for the same reason AVAILABILITY_CHECK is above.
    AFTERCARE:          'QUESTION',
    SKINCARE_ADVICE:    'SKINCARE_ADVICE',
    SIZE_GUIDE:         'ENQUIRY',
    // [FIX-5] These were listed as valid AI intents but absent from this map —
    // intentToAction returned 'FALLBACK' for all of them. Now correctly routed.
    PRODUCT_INQUIRY:    'ENQUIRY',           // FASHION: question about a specific product
    COMPATIBILITY_CHECK:'ENQUIRY',           // ELECTRONICS: "does X work with Y"
    COLLECTION_SCHEDULE:'START_BOOKING',     // BAKERY: schedule a collection/pickup
    WALKIN:             'WALKIN',            // SALON/BARBERSHOP: walk-in queue entry
  };
  return map[intent] || 'FALLBACK';
}
