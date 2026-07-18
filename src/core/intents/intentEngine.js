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
 *   4.2 Complaint guard         → instant, any time (see negationGuard.js)
 *   4.5 Cancellation guard      → instant, any time (see negationGuard.js)
 *   4.6 Correction guard        → instant, in-flow only (see negationGuard.js)
 *   5. Levenshtein suggestion   → "did you mean?" only, never auto-execute
 *   6. AI classify              → ONLY if message ≥8 chars & non-numeric
 *   7. FALLBACK                 → default catch-all
 *
 * GOLDEN RULES:
 *   - Buttons always win. If it came from a button tap, trust the ID.
 *   - AI never triggers flows directly. It returns a structured decision object
 *     (see [FEAT-STRUCTURED-AI-4]); intentEngine applies the confidence policy
 *     and is the only thing that decides the final action.
 *   - Short/numeric inputs (qty, date digits) → CONTINUE_FLOW always.
 *   - Active flows own their messages. Only CANCEL/CONFIRM/complaint (and now
 *     corrections, see [FEAT-NEGATION-1]) can escape. Complaint and
 *     cancellation guards deliberately run BEFORE the correction guard — a
 *     message like "actually, cancel it" or "actually my order was wrong"
 *     starts with a correction cue but must still escape, not be swallowed
 *     as a mere correction (see [FEAT-NEGATION-2]).
 */

import levenshtein from 'fast-levenshtein';
import { INTENT_PATTERNS, BUTTON_ID_MAP, EMOJI_MAP } from './patterns.js';
import { getAIReply } from '../ai/providers/aiRouter.js';
import { analyzeMessage } from './negationGuard.js';
import logger from '../../config/logger.js';

// ── Normalise ─────────────────────────────────────────────────────────────────
export const normalise = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Direct ORDER / BOOKING phrase match ─────────────────────────────────────
// [UPGRADE-DIRECT-INTENT] / [UPGRADE-DIRECT-INTENT-2] / [AUDIT-FIX-DIRECT-INTENT-3]
// A customer who unambiguously asks to order or book must skip the generic
// 3-button welcome menu and go straight into that flow. See
// tests/directIntentUpgrade.test.mjs and tests/directIntentUpgradeV2.test.mjs
// for the full rationale and phrase inventory this is kept in sync with.
//
// Exclude list guards against cancellation/negation/tracking phrasing that
// happens to contain "order"/"book" ("cancel my order", "where is my
// order", "I don't want to book"). normalise() strips apostrophes, turning
// "don't" into "don t" — both the bare "don'?t" form (pre-normalise safety)
// and the space-separated "don t" form (post-normalise, the one that
// actually matters) are listed so the negation is never missed.
export const DIRECT_INTENT_EXCLUDE_RE = new RegExp(
  '\\b(' + [
    'cancel', 'cancle', "don'?t", 'don t', 'do not', 'dont', 'stop',
    'no longer', 'nevermind', 'never mind', 'nvm', 'not interested',
    'track', 'status', 'where is', 'where s', 'when is', 'update',
    'how long', 'refund', 'reject', 'decline',
  ].join('|') + ')\\b' + '|\\bcheck\\w*\\b'
);
export const ORDER_DIRECT_RE   = /\b(order|buy|purchase|shopping|can i get|can i have|i ll have|i ll take|give me|get me|i want|i d like|craving)\b/;
export const BOOKING_DIRECT_RE = /\b(book|reserve|reservation|appointment|table for|party of|table at|table tonight|come in|slot for|availability for)\b/;

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

  // [FEAT-NEGATION-1] Single pass over the deterministic negation/cancellation/
  // correction/rejection/complaint guard — reused across steps 4.2-4.6 below.
  const guard = analyzeMessage(raw);

  // ── 4. Exact keyword match ────────────────────────────────────────────────
  for (const [intent, keywords] of Object.entries(INTENT_PATTERNS)) {
    if (keywords.includes(clean)) {
      const action = intentToAction(intent, business);
      return { action, intent, confidence: 'HIGH', source: 'keyword' };
    }
  }

  // ── 4.2 Deterministic complaint guard ──────────────────────────────────────
  // Runs regardless of whether a flow is active — Part A's Complaint Handling
  // rule is explicit: complaints always escalate to support and must never be
  // treated as an FAQ, a flow answer, or (critically) mistaken for a correction
  // just because it happens to start with "actually"/"sorry" (see [FEAT-NEGATION-2]
  // below — this MUST run before the correction guard). Free-form complement to
  // the existing bare-word SUPPORT keyword entries, which only match when they
  // are the entire message.
  if (guard.complaint) {
    return { action: 'SUPPORT', intent: 'SUPPORT', confidence: 'HIGH', source: 'complaint-guard' };
  }

  // ── 4.5 Deterministic cancellation guard ───────────────────────────────────
  // Runs regardless of whether a flow is active (mirrors the file's own golden
  // rule: "Only CANCEL/CONFIRM can escape" a flow) and regardless of AI
  // availability. Catches free-form cancellation phrasing that doesn't
  // literally equal a CANCEL/SUPPORT keyword entry — see negationGuard.js for
  // the full rationale. Only reached for messages that didn't already exact-
  // match a keyword above (a literal "cancel" keyword match already returned).
  // MUST run before the correction guard — "actually, cancel it" starts with
  // "actually" and must still cancel, not be swallowed as a correction.
  if (guard.cancelled) {
    return { action: 'CANCEL', intent: 'CANCEL_ORDER', confidence: 'HIGH', source: 'negation-guard' };
  }

  // ── 4.6 Confirmation / correction detection inside an active flow ─────────
  // [FEAT-NEGATION-2] "Actually, make that three." / "Sorry, I meant medium."
  // AND free-form confirmations like "yeah sure that sounds good" (which don't
  // exactly equal a bare CONFIRM keyword — there is in fact no typed CONFIRM
  // keyword list at all; CONFIRM is otherwise reachable only via button taps)
  // must stay owned by the active flow's own handler rather than falling
  // through this pipeline to the generic FALLBACK/CLARIFY card at step 8 —
  // which would show an unrelated AI reply plus the welcome buttons, silently
  // derailing the flow. Only reached here (i.e. AFTER the complaint and
  // cancellation guards above) so a complaint or cancellation that happens to
  // start with "actually"/"sorry", or contain "yes", is never misread as a
  // mere correction/confirmation. Never fires when there's no active flow to
  // hand the message to.
  if (session?.currentFlow && (guard.correction || guard.confirmed)) {
    return {
      action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH',
      source: guard.correction ? 'correction-guard' : 'confirmation-guard',
    };
  }

  // ── 4.5. Direct ORDER / BOOKING phrase match ──────────────────────────────
  // [UPGRADE-DIRECT-INTENT] Natural phrasing ("I want to order food please",
  // "can I book a table for tonight") falls too far outside Levenshtein's
  // edit-distance tolerance to match step 4's exact keywords. Checked here,
  // pre-flow only (an active flow owns its own short replies), booking before
  // ordering since some phrases ("I want to book a table") match both.
  // intentToAction('BOOKING', ...) → START_BOOKING; intentToAction('ORDER', ...) → START_ORDER.
  if (!session?.currentFlow) {
    const excluded = DIRECT_INTENT_EXCLUDE_RE.test(clean);
    if (!excluded) {
      if (BOOKING_DIRECT_RE.test(clean)) {
        const action = intentToAction('BOOKING', business);
        return { action, intent: 'BOOKING', confidence: 'HIGH', source: 'direct-phrase' };
      }
      if (ORDER_DIRECT_RE.test(clean)) {
        const action = intentToAction('ORDER', business);
        return { action, intent: 'ORDER', confidence: 'HIGH', source: 'direct-phrase' };
      }
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

  // ── 6. Short inputs inside an active flow → always CONTINUE_FLOW ─────────
  // Mid-flow, a short message is virtually always quantity/qty/size input —
  // never worth an AI call. Unaffected by [UPGRADE-DIRECT-INTENT-2] below —
  // in-flow short replies (4-7 chars) still short-circuit here.
  if (raw.length < 8 && session?.currentFlow) {
    return { action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH', source: 'short' };
  }

  // [FEAT-TYPO-1] Outside an active flow, a short message with an existing
  // Levenshtein hit is still resolved right here (cheap, deterministic, no AI
  // needed) — but a short message with NO Levenshtein hit is no longer forced
  // straight to a bare FALLBACK. Previously ANY message under 8 chars skipped
  // the AI-classify step entirely regardless of flow state, so a fresh, short,
  // non-numeric message like "bok tbl" or "delivry" that also missed the
  // Levenshtein distance/length tolerance (see fast-levenshtein call below —
  // dist<=2 and length-diff<=4 doesn't cover every heavily-abbreviated typo in
  // the spec's own Typo & Informal Language Tolerance examples) got ZERO
  // classification attempt. It now falls through to step 7 like any longer
  // message would, since there's no active flow here to justify skipping the AI.
  if (!session?.currentFlow && raw.length < 8 && suggestion) {
    logger.info('[IntentEngine] miss', { path: 'clarify', raw, suggestion: suggIntent });
    return {
      action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'levenshtein',
      suggestion: suggIntent,
    };
  }

  // [UPGRADE-DIRECT-INTENT-2] Pre-flow AI-classify skip threshold lowered from
  // <8 to <4 chars. Messages this short outside an active flow, with no
  // Levenshtein hit, carry essentially no signal — logged and routed straight
  // to FALLBACK. 4-7 char pre-flow messages ("buy 2", "book pls") now fall
  // through to step 7 and get a real shot at Groq classification instead.
  if (!session?.currentFlow && raw.length < 4 && !suggestion) {
    logger.info('[IntentEngine] miss', { path: 'short-fallback', raw });
    return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'short-fallback', hesitant: guard.hesitant };
  }

  // ── 7. AI classify (last resort — multi-word, non-numeric messages only) ──
  // [FEAT-STRUCTURED-AI-4] Upgraded from a bare intent word to the full
  // structured decision object (confidence, negation, emotion, urgency,
  // correction, multi-intent) per the WhatSales Conversational Intelligence
  // spec. Confidence policy (spec Part A, "Confidence Policy"):
  //   >= 0.92        → route immediately, no clarification
  //   0.70 - 0.91    → ask exactly one clarification question (never guess)
  //   <  0.70        → do not switch workflows; fall through to step 8 unchanged
  // [FIX-INTENT-AI] (carried over) Skipped entirely when session is already in
  // an active flow — the flow engine owns those messages, same as before.
  if (!session?.currentFlow) {
    try {
      const decision = await classifyWithStructuredAI({ message: raw, business });

      // Negation/rejection always wins over whatever intent the model guessed —
      // never start a workflow the customer just said they don't want.
      if (decision.negated || decision.rejected) {
        return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'ai-negated' };
      }
      if (decision.cancelled) {
        return { action: 'CANCEL', intent: 'CANCEL_ORDER', confidence: 'HIGH', source: 'ai-cancel' };
      }
      if (decision.requiresHuman) {
        return { action: 'SUPPORT', intent: 'SUPPORT', confidence: 'HIGH', source: 'ai-escalate' };
      }
      if (decision.primaryIntent && decision.primaryIntent !== 'UNKNOWN') {
        if (decision.confidence >= 0.92) {
          const action = intentToAction(decision.primaryIntent, business);
          return {
            action, intent: decision.primaryIntent, confidence: 'AI', source: 'ai',
            emotion: decision.emotion, urgency: decision.urgency,
            secondaryIntents: decision.secondaryIntents,
            businessInformationRequested: decision.businessInformationRequested,
          };
        }
        if (decision.confidence >= 0.70 || decision.needsClarification) {
          return {
            action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'ai-clarify',
            clarification: decision.clarificationQuestion
              || 'What can I help you with today — ordering, booking, or something else?',
            emotion: decision.emotion,
          };
        }
        // < 0.70 and no clarification requested → deliberately fall through to
        // step 8 unchanged, per the spec's conservative confidence policy.
      }
    } catch (err) {
      logger.warn('[IntentEngine] AI classify failed', { err: err.message });
    }
  }

  // ── 8. Final fallback ──────────────────────────────────────────────────────
  // [FEAT-NEGATION-3] guard.hesitant ("maybe", "just browsing", "not sure yet")
  // was previously computed by negationGuard.js but never read anywhere — pure
  // dead code. Per the spec's Hesitation Detection rule ("don't push the sale —
  // offer helpful information instead"), it's surfaced here as a `hesitant` flag
  // so moduleRouter's FALLBACK/CLARIFY case can ask the AI reply for a softer,
  // informational tone instead of a pushy one. Never changes the action itself —
  // hesitation shapes tone only, exactly like emotion/urgency above.
  if (suggestion) {
    logger.info('[IntentEngine] miss', { path: 'clarify', raw, suggestion: suggIntent });
    return {
      action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'levenshtein',
      suggestion: suggIntent, hesitant: guard.hesitant,
    };
  }

  logger.info('[IntentEngine] miss', { path: 'final-fallback', raw });
  return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'fallback', hesitant: guard.hesitant };
}

// ── AI structured classifier ──────────────────────────────────────────────────
// [FEAT-STRUCTURED-AI-5] Replaces the old bare-word classifyWithAI. Still lazy-
// imports groqProvider.js so a missing/broken AI provider module can never
// break module load for the deterministic layers above (same defensive pattern
// as the code it replaces).
async function classifyWithStructuredAI({ message, business }) {
  const mode         = (business?.businessMode || 'RETAIL').toUpperCase();
  const validIntents = getValidIntents(mode);

  // [FIX-AI-1] (carried over) Sanitise customer input before embedding it in the prompt.
  const sanitisedMsg = message
    .slice(0, 200)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[<>]/g, '')
    .trim();

  const fallback = {
    primaryIntent: 'UNKNOWN', confidence: 0, negated: false, cancelled: false,
    rejected: false, confirmed: false, correction: false, urgency: 'normal',
    emotion: 'neutral', needsClarification: false, clarificationQuestion: null,
    requiresHuman: false, secondaryIntents: [], businessInformationRequested: [],
  };

  try {
    const { classifyMessageStructured } = await import('../ai/providers/groqProvider.js')
      .catch(() => ({ classifyMessageStructured: null }));
    if (classifyMessageStructured && process.env.GROQ_API_KEY) {
      return await classifyMessageStructured({ message: sanitisedMsg, validIntents, mode });
    }
    return fallback;
  } catch (err) {
    logger.warn('[IntentEngine] classifyWithStructuredAI failed', { err: err.message });
    return fallback;
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
