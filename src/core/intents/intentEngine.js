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

// ── Core detect ───────────────────────────────────────────────────────────────

// ── Direct ORDER / BOOKING phrase detection ────────────────────────────────────
// [UPGRADE-DIRECT-INTENT] Step 4 below only fires on a whole-message EXACT match
// against the literal strings in INTENT_PATTERNS.ORDER / .BOOKING ("order food",
// "i want to order", "book a table"...). Real customers phrase things with extra
// words around those cores ("I want to order food please", "can I book a table
// for tonight", "I'd like to order 2 pizzas") which don't match step 4 at all —
// they used to fall through to Levenshtein (too far in edit-distance for a full
// sentence) → AI classify (may be unavailable) → FALLBACK, which shows the
// generic 3-button welcome menu (Order / Book / Question) instead of taking the
// customer straight into the flow they clearly asked for.
//
// Per product requirement: a message that unambiguously asks to order or book
// must skip that menu entirely, the same way a literal "order food" already does.
// This is intentionally narrow — a plain "contains the word order/book" check —
// guarded against cancellation/negation and order-tracking phrasing so it never
// hijacks CANCEL_ORDER, TRACK_ORDER, or a genuine "no thanks" reply. It only runs
// pre-flow (session.currentFlow is empty), matching the scope of step 4.
// [AUDIT-FIX-DIRECT-INTENT-3] "don'?t" alone never matches here. normalise() turns
// apostrophes into SPACES, not nothing, so "don't" becomes "don t" (two words) by
// the time it reaches this regex — "don'?t" (which requires "don" and "t" adjacent)
// silently fails to match it. This is the exact same issue "where s" already exists
// in this list to solve for "where's" → "where s"; "don't" just never got the same
// treatment. Net effect before this fix: "I don't want to order anymore" was NOT
// excluded, and since it still contains the literal word "order", it incorrectly
// fired START_ORDER — starting the very flow the customer was declining.
// [FIX-FSI-EXPORT] Exported (additive only — no behavior change to existing callers)
// so the mid-flow order/booking switch intercept in webhookController.js can reuse
// the exact same matching rules instead of maintaining a second, drift-prone copy.
export const DIRECT_INTENT_EXCLUDE_RE = new RegExp(
  '\\b(' + [
    'cancel', 'cancle', "don'?t", 'don t', 'do not', 'dont', 'stop',
    'no longer', 'nevermind', 'never mind', 'nvm', 'not interested',
    'track', 'status', 'where is', 'where s', 'when is', 'update',
    'how long', 'refund', 'reject', 'decline',
  ].join('|') + ')\\b'
  // [AUDIT-DIRECT-INTENT] "check my order" / "checking on my booking" ask about an
  // EXISTING order or booking (→ TRACK_ORDER), not a request to place a new one —
  // without this, they'd match ORDER_DIRECT_RE/BOOKING_DIRECT_RE on "order"/"book"
  // and incorrectly launch a brand-new flow. \bcheck\w*\b (not \bcheck\b) so it also
  // catches "checking"/"checked", not just the bare word "check".
  + '|\\bcheck\\w*\\b'
);
// [UPGRADE-DIRECT-INTENT-2] Widened vocabulary — covers common ways customers ask
// for something without using the literal words "order"/"book". Still a plain
// word/phrase list, so it's fast and free (no AI call), but catches a lot more
// of the real-world phrasing than the v1 list did. New entries were chosen to be
// requests specifically ("i want X", "can i get X", "i'll have X"), not just any
// mention of food/tables, to keep false-positive risk low.
// NOTE: `clean` has already gone through normalise(), which strips apostrophes
// entirely (replaced with a space, not removed) — "i'll have" becomes "i ll have"
// and "i'd like" becomes "i d like". Patterns must match the POST-normalisation
// form, not the raw contraction, or they silently never match.
// [FIX-FSI-EXPORT] Exported for the same reason as DIRECT_INTENT_EXCLUDE_RE above.
export const ORDER_DIRECT_RE   = /\b(order|buy|purchase|shopping|can i get|can i have|i ll have|i ll take|give me|get me|i want|i d like|craving)\b/;
export const BOOKING_DIRECT_RE = /\b(book|reserve|reservation|appointment|table for|party of|table at|table tonight|come in|slot for|availability for)\b/;

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

  // ── 4.5. Direct ORDER / BOOKING phrase match (see constants above) ────────
  // Only pre-flow — an active flow already owns free text via CONTINUE_FLOW
  // before detectIntent() is ever reached for it, but this guard keeps intent
  // identical to step 4's scope regardless of caller.
  // [AUDIT-FIX-DIRECT-INTENT-4] BOOKING checked BEFORE ORDER here. The widened
  // ORDER_DIRECT_RE now includes generic phrases ("i want", "i d like") that also
  // appear naturally in booking requests ("I want to book a table"). Since those
  // generic phrases carry no order-specific meaning on their own, checking BOOKING
  // first (whose word list is more specific: book/reserve/table for/etc.) means a
  // genuine booking request is never misrouted to START_ORDER just because it also
  // happens to contain "i want". Confirmed regression before this fix: "I want to
  // book a table" → START_ORDER (wrong). After: → START_BOOKING (correct).
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

  // ── 6. Short non-AI inputs → FALLBACK or CONTINUE_FLOW ───────────────────
  // [UPGRADE-DIRECT-INTENT-2] Threshold lowered from 8 to 4. Below 4 chars
  // (single words like "hi", "ok", digits) AI classification adds noise more
  // often than value, so those are still routed without a Groq call. Between
  // 4–7 chars there are genuine short requests ("buy 2", "book pls", "table?")
  // that were previously skipped straight to CLARIFY/FALLBACK with no chance
  // of AI catching them — this only applies pre-flow (session.currentFlow is
  // empty), since in-flow short replies are already handled as CONTINUE_FLOW
  // by the numeric/short-circuit checks above and never reach this branch.
  if (raw.length < 4) {
    if (session?.currentFlow) {
      return { action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH', source: 'short' };
    }
    if (suggestion) {
      return {
        action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'levenshtein',
        suggestion: suggIntent,
      };
    }
    logger.info('[IntentEngine] miss', { raw, path: 'short-fallback' });
    return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'fallback' };
  }
  if (raw.length < 8 && session?.currentFlow) {
    return { action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH', source: 'short' };
  }

  // ── 7. AI classify (last resort — multi-word, non-numeric messages only) ──
  // [FIX-INTENT-AI] Skip AI classify when session is already in an active flow
  // that owns the input (e.g. ENQUIRY:AWAITING_QUESTION). The flow engine handles
  // it at step 13/15 of webhookController — running the classifier here wastes a
  // Groq API call and risks overriding the flow handler with an incorrect intent.
  if (!session?.currentFlow) {
    try {
      const aiIntent = await classifyWithAI({ message: raw, business });
      if (aiIntent && aiIntent !== 'UNKNOWN') {
        const action = intentToAction(aiIntent, business);
        return { action, intent: aiIntent, confidence: 'AI', source: 'ai' };
      }
    } catch (err) {
      logger.warn('[IntentEngine] AI classify failed', { err: err.message });
    }
  }

  // ── 8. Final fallback ──────────────────────────────────────────────────────
  // [UPGRADE-DIRECT-INTENT-2] Every message that reaches here got past keyword,
  // direct-phrase regex, AND AI classify without a confident match. Logging the
  // raw text (not just "FALLBACK happened") is what makes the audit-and-fix loop
  // possible — without it, a real missed phrasing is invisible until a customer
  // complains. This is the single source to review when deciding what to add to
  // ORDER_DIRECT_RE/BOOKING_DIRECT_RE or INTENT_PATTERNS next.
  if (suggestion) {
    logger.info('[IntentEngine] miss', { raw, path: 'clarify', suggestion: suggIntent });
    return {
      action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'levenshtein',
      suggestion: suggIntent,
    };
  }

  logger.info('[IntentEngine] miss', { raw, path: 'final-fallback' });
  return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'fallback' };
}

// ── AI intent classifier ──────────────────────────────────────────────────────
async function classifyWithAI({ message, business }) {
  const mode         = (business?.businessMode || 'RETAIL').toUpperCase();
  const validIntents = getValidIntents(mode);

  // [FIX-AI-1] Sanitise customer input before embedding it in the prompt.
  const sanitisedMsg = message
    .slice(0, 200)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[<>]/g, '')
    .trim();

  // [FIX-CLASSIFY] Use groqProvider.classifyIntent() — a lean two-message prompt
  // that sends ONLY the classification instruction, without the customer-service
  // persona system prompt that groq.getReply() always prepends. The old approach
  // (calling groq.getReply() with business:null + a crafted user message) still
  // received "You are a helpful business assistant. Reply in 1–2 short sentences..."
  // as its system context, which conflicted with the classification instruction and
  // caused the model to return prose explanations instead of bare intent words.
  try {
    const { classifyIntent } = await import('../ai/providers/groqProvider.js').catch(() => ({ classifyIntent: null }));
    if (classifyIntent && process.env.GROQ_API_KEY) {
      return await classifyIntent({ message: sanitisedMsg, validIntents, mode });
    }
    // Groq not available — return UNKNOWN so caller falls back
    return 'UNKNOWN';
  } catch (err) {
    logger.warn('[IntentEngine] classifyWithAI failed', { err: err.message });
    return 'UNKNOWN';
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
