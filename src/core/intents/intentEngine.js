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
 *   4.4 Cancellation guard      → instant, any time (see negationGuard.js)
 *   4.5 Direct order/booking phrase (pre-flow only, see UPGRADE-DIRECT-INTENT)
 *   4.6 Correction/confirm guard → instant, in-flow only (see negationGuard.js)
 *   5. Levenshtein suggestion   → "did you mean?" only, never auto-execute
 *   6. AI classify              → ONLY if message ≥8 chars & non-numeric
 *   7. FALLBACK                 → default catch-all
 *
 * GOLDEN RULES:
 *   - Buttons always win. If it came from a button tap, trust the ID.
 *   - AI never triggers flows directly. It returns an intent, human confirms.
 *   - Short/numeric inputs (qty, date digits) → CONTINUE_FLOW always.
 *   - Active flows own their messages. Only CANCEL/CONFIRM (and now complaint/
 *     correction, see [MERGE-NEGATION-1]) can escape. Complaint and
 *     cancellation guards deliberately run BEFORE the correction guard — a
 *     message like "actually, cancel it" or "actually my order was wrong"
 *     starts with a correction cue but must still escape, not be swallowed
 *     as a mere correction.
 */

import levenshtein from 'fast-levenshtein';
import { INTENT_PATTERNS, BUTTON_ID_MAP, EMOJI_MAP } from './patterns.js';
import { getAIReply } from '../ai/providers/aiRouter.js';
import { analyzeMessage } from './negationGuard.js';
import { isMenuBrowsingIntent } from './menuIntentDetector.js';
import { getModeConfig } from '../../config/modes.js';
import { sanitiseNluMessage } from '../nlu/nluContext.js';
import logger from '../../config/logger.js';

// ── Normalise ─────────────────────────────────────────────────────────────────
export const normalise = (text = '') =>
  text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ── [UPGRADE-DIRECT-INTENT] / [UPGRADE-DIRECT-INTENT-2] ─────────────────────────
// Natural-language order/booking requests ("I want to order food please", "give me
// 2 burgers", "table for tonight") don't literally equal a hardcoded keyword string
// and are too far in edit distance for Levenshtein — they used to fall all the way
// through to AI classify (may be unavailable/UNKNOWN) → FALLBACK, showing the
// generic welcome menu instead of acting on the customer's actual request. This
// step catches them BEFORE Levenshtein, pre-flow only, while still refusing to
// hijack cancel/track/status/refund phrasing via the exclude list below.
//
// [AUDIT-FIX-DIRECT-INTENT-3] normalise() turns apostrophes into spaces, so a bare
// "don'?t" pattern never matched "don't" once normalised to "don t" — the
// space-separated form must be listed explicitly.
// [FSI] Exported so controllers/webhookController.js's mid-flow switch
// intercept (_detectMidFlowSwitchRequest) shares this exact same source of
// truth instead of re-implementing/drifting from it.
export const DIRECT_INTENT_EXCLUDE_RE = new RegExp(
  '\\b(' + [
    'cancel', 'cancle', "don'?t", 'don t', 'do not', 'dont', 'stop',
    'no longer', 'nevermind', 'never mind', 'nvm', 'not interested',
    'track', 'status', 'where is', 'where s', 'when is', 'update',
    'how long', 'refund', 'reject', 'decline',
  ].join('|') + ')\\b' + '|\\bcheck\\w*\\b'
);
// [UPGRADE-DIRECT-INTENT-2] Widened beyond the literal words "order"/"book" to
// catch phrasing that never uses them at all ("give me 2 burgers", "table for
// tonight").
export const ORDER_DIRECT_RE   = /\b(order|buy|purchase|shopping|can i get|can i have|i ll have|i ll take|give me|get me|i want|i d like|craving|hungry|starving|peckish|place an order)\b/;
export const BOOKING_DIRECT_RE = /\b(book|reserve|reservation|appointment|table for|party of|table at|table tonight|come in|slot for|availability for)\b/;
// [FIX-CATALOG-QUESTION-DIRECT] "What do you have in your menu?" / "Can I see
// your catalog?" / "What's on the menu?" never equal a bare VIEW_MENU keyword
// (step 4's exact-match-only comparison), and don't contain any ORDER_DIRECT_RE
// word either — so they fell all the way through to AI classify. If Groq is
// unavailable, disabled, or just returns LOW confidence for a phrasing it
// wasn't primed for, the customer gets the generic "I'm not sure I understood
// that" fallback with no recovery path, even though the intent — "show me
// what you sell" — is completely unambiguous. This is a deterministic catch
// for the common natural phrasings, so viewing the menu/catalog never depends
// on AI being configured or confident.
// [FIX-VIEWMENU-WHATCANIEAT] "what can I eat" / "what could I eat" (and the
// "we/they" variants) were previously unmatched — fell through to AI/fallback
// even though the intent is exactly the same as "what do you have" just
// above. Added as its own alternative rather than folded into the existing
// "what (do|does) you have" branch since the verb ("eat") and pronoun shape
// differ enough that squeezing it in there would have made that branch's
// pronoun/verb groups ambiguous.
// [FIX-PIDGIN-VIEWMENU] The phrasings above are all Standard-English shapes.
// West-African Pidgin/Krio menu requests — very common in this platform's
// actual Gambian customer base — never contain "what do you have", "can I
// see", etc., so they fell straight past this deterministic layer to Groq,
// which (per groqProvider.js's un-localized prompt) often returned MEDIUM/LOW
// confidence for them, landing the customer on a generic CLARIFY instead of
// the catalog. Added as its own alternative group rather than folded into the
// Standard-English branches above, since pidgin word order ("wetin una get",
// subject-final "get") doesn't fit those groups' pronoun/verb slots.
export const VIEW_MENU_DIRECT_RE = /\b(what (?:do|does) (?:you|yall|you all) (?:have|sell|offer|serve|carry)|what (?:food\s+options?|food|foods|items?|products?|dishes|options?) (?:do|does) (?:you|yall|you all) (?:have|sell|offer|serve|carry)|what (?:can|could) (?:i|we|they) (?:eat|order|get)|what'?s on (?:the|your) menu|(?:can|could) i see (?:all\s+)?(?:the|your) (?:food|foods|items?|products?|dishes|options?|menu|catalog|catalogue)|(?:i\s+)?(?:want|would like|would love|need) to (?:see|view|browse) (?:all\s+)?(?:the|your)?\s*(?:food|foods|items?|products?|dishes|options?|menu|catalog|catalogue)|show me (?:all\s+)?(?:the|your) (?:food|foods|items?|products?|dishes|options?|menu|catalog|catalogue)|see (?:all\s+)?(?:the|your) (?:food|foods|items?|products?|dishes|options?|menu|catalog|catalogue)|view (?:all\s+)?(?:the|your) (?:food|foods|items?|products?|dishes|options?|menu|catalog|catalogue)|browse (?:all\s+)?(?:the|your)? ?(?:food|foods|items?|products?|dishes|options?|menu|catalog|catalogue)|wetin (?:una|you|unu|you all|yall) (?:get|dey sell|dey get|get for sell|get to sell|de sell)|una get wetin|wetin dey (?:for|inside|on) (?:menu|catalog|catalogue)|make (?:i|we|una) see (?:the |una )?(?:menu|catalog|catalogue|wetin (?:una|you) get)|show (?:me|us) wetin (?:una|you|unu) (?:get|dey sell)|wetin (?:you|una) get (?:for|to) (?:chop|eat|order))\b/;

// [FIX-QUESTION-VS-ORDER] ORDER_DIRECT_RE matches the bare word "i want" —
// but "I want to know the prices of your food items" / "I'd like to know
// your hours" also contain "i want"/"i d like" and are genuine information
// requests, not orders. Without this guard, step 4.5 below deterministically
// returned START_ORDER for any "I want to know/ask ..." phrasing, and the
// order flow then tried to parse "know the prices of your food items" as a
// product name, missed, and told the customer "I couldn't find ... in our
// current products" — even though the exact answer (a price) was sitting in
// the business's own menu data one layer away in questionAnswerService.js.
// This regex catches the "asking", not "ordering", framing so those messages
// fall through to QUESTION detection (keyword/AI classify) instead of being
// deterministically hijacked into START_ORDER/START_BOOKING. Used both here
// and by webhookController.js's mid-flow switch detector, which shares
// ORDER_DIRECT_RE/BOOKING_DIRECT_RE as its source of truth.
export const QUESTION_LEADIN_RE = /\b(i want to know|i wanted to know|i would like to know|i d like to know|want to know|wanted to know|like to know|i want to ask|want to ask|i have a question|i ve got a question|just wondering|wondering if|wondering about|curious about|curious if|want to find out|wanted to find out|can you tell me|could you tell me|do you know|ask a question|question mode|just a question)\b/;

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
 *   confidence: 'HIGH'|'MEDIUM'|'LOW',
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
      // [FIX-CATALOG-BTN-INTENT] BUTTON_ID_MAP values are *actions* (START_ORDER),
      // but downstream catalog logic (shouldOfferCatalog) expects semantic *intents*
      // (ORDER). Returning action as intent made every ORDER-button tap skip WA
      // Catalog under AI_DECIDES and fall through to the text menu instead.
      const intent = actionToIntent(mapped);
      return { action: mapped, intent, confidence: 'HIGH', source: 'button' };
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

  // [MERGE-NEGATION-1] Single pass over the deterministic negation/cancellation/
  // correction/rejection/complaint guard — reused across steps 4.2/4.4/4.6 below.
  const guard = analyzeMessage(raw);

  // ── 4.2 Deterministic complaint guard ──────────────────────────────────────
  // Runs regardless of whether a flow is active — complaints always escalate
  // to support and must never be treated as an FAQ, a flow answer, or
  // (critically) mistaken for a correction just because it happens to start
  // with "actually"/"sorry" (this MUST run before the correction guard).
  // Free-form complement to the existing bare-word SUPPORT keyword entries,
  // which only match when they are the entire message.
  if (guard.complaint) {
    return { action: 'SUPPORT', intent: 'SUPPORT', confidence: 'HIGH', source: 'complaint-guard' };
  }

  // ── 4.4 Deterministic cancellation guard ───────────────────────────────────
  // Runs regardless of whether a flow is active (mirrors the file's own golden
  // rule: "Only CANCEL/CONFIRM can escape" a flow) and regardless of AI
  // availability. Catches free-form cancellation phrasing that doesn't
  // literally equal a CANCEL/SUPPORT keyword entry — see negationGuard.js for
  // the full rationale. MUST run before the correction guard — "actually,
  // cancel it" starts with "actually" and must still cancel, not be
  // swallowed as a correction.
  if (guard.cancelled) {
    return { action: 'CANCEL', intent: 'CANCEL_ORDER', confidence: 'HIGH', source: 'negation-guard' };
  }

  // ── 4.5. Direct ORDER / BOOKING phrase match ──────────────────────────────
  // [UPGRADE-DIRECT-INTENT] / [UPGRADE-DIRECT-INTENT-2] Pre-flow only — an active
  // flow owns its own input and must not be hijacked by a phrase match here.
  // Booking is checked before order: "i want" (order) also appears inside
  // "I want to book a table", so booking-first avoids misrouting a booking
  // request that happens to contain an order-ish lead-in phrase.
  // [FIX-DIRECT-ORDER-AI] This block used to return immediately and
  // deterministically the instant ORDER_DIRECT_RE/BOOKING_DIRECT_RE matched —
  // which is EVERY natural-language order phrase ("I want to order X", "give
  // me 2 Y", "I want food"), since those are exactly the phrases the regex is
  // built to catch. Because detectIntent() returned right here, step 7 (Groq
  // AI classify, see classifyWithAI below) was UNREACHABLE for this entire
  // class of message — `nlu.entities.products` was always empty, so
  // moduleRegistry.js's AI-seeded cart bypass (session.data._nluPending.products)
  // never had anything to consume, and every order fell back to the much
  // weaker local regex parser (parseMultiItemMessage/parseNaturalOrderMessage),
  // which has no fuzzy matching and no conversation context. Any miss there
  // either silently looped (no feedback) or mis-parsed leftover filler words
  // ("to order", "to see the menu") as a failed product lookup.
  //
  // Fix: keep the deterministic ORDER/BOOKING routing — a message that
  // matches these patterns must always resolve to START_ORDER/START_BOOKING,
  // never get downgraded to UNKNOWN/CLARIFY by the AI — but before returning,
  // ask Groq (via the same classifyWithAI/enhanced-NLU path step 7 uses) to
  // extract structured product entities from the message, using full menu +
  // conversation history context. Those entities ride along on `nlu` exactly
  // like a step-7 AI result does, so webhookController.js's existing
  // `_nluPending` wiring (line ~3076) picks them up and moduleRegistry.js's
  // START_ORDER handler gets a real, context-aware line-item match instead of
  // falling back to brittle regex stripping. If Groq is unavailable, disabled,
  // or extracts nothing, this degrades gracefully to the old deterministic
  // behavior — the order/booking intent itself never depends on AI succeeding.
  // [FIX-MENU-QUESTION-GUARD] Menu-browsing requests must NOT be gated behind
  // QUESTION_LEADIN_RE. That guard exists to stop "I want to know the price"
  // from being misread as an ORDER (a purchase-risk action) — it was never
  // meant to also block "I want to know what's on the menu" from reaching the
  // catalog. Browsing the menu carries none of ORDER's/BOOKING's risk (nothing
  // is purchased or reserved), so it's checked in its own unguarded block,
  // ahead of the ORDER/BOOKING phrase match below. Still respects
  // DIRECT_INTENT_EXCLUDE_RE (cancel/track/status phrasing) and the no-active-
  // flow rule like every other step-4.5 check.
  //
  // [FIX-MENU-CAPABILITY-GATE] Mirrors the [FIX-FSI-2] capability gate
  // webhookController.js's _detectMidFlowSwitchRequest already applies before
  // offering a flow switch. SERVICES/GENERAL businesses declare
  // flows: ['ENQUIRY', 'BOOKING'] — no ORDER/catalog flow exists for them at
  // all (they're pure quote/consultation businesses with nothing to
  // "browse"). The welcome-menu "🛍 Browse Catalog" button is already hidden
  // for them via shouldShowCatalogButton(), but a typed phrase had no
  // equivalent gate — "what do you offer" variants that don't exact-match
  // the QUESTION keyword list would otherwise be deterministically routed
  // into BROWSE_CATALOG → browseCatalogExplicit() → a fallback
  // startFlow('ORDER') that has no registered ORDER handler for their mode,
  // producing a broken/empty response instead of the text answer their
  // QUESTION flow would have given. Gating on cfg.flows.includes('ORDER')
  // lets the message fall through to QUESTION/AI classify instead, which is
  // what these modes are actually built to answer.
  const _menuCapableMode = (getModeConfig(business).flows || []).includes('ORDER');
  if (_menuCapableMode && !session?.currentFlow && !DIRECT_INTENT_EXCLUDE_RE.test(clean) && isMenuBrowsingIntent(clean)) {
    // Natural browsing requests use the same explicit catalog action as the
    // "View items" button, so they cannot be diverted into a generic menu
    // renderer before the native WhatsApp catalog path is reached.
    return { action: 'BROWSE_CATALOG', intent: 'BROWSE_CATALOG', confidence: 'HIGH', source: 'direct-phrase' };
  }

  if (!session?.currentFlow && !DIRECT_INTENT_EXCLUDE_RE.test(clean) && !QUESTION_LEADIN_RE.test(clean)) {
    if (BOOKING_DIRECT_RE.test(clean)) {
      return { action: 'START_BOOKING', intent: 'BOOKING', confidence: 'HIGH', source: 'direct-phrase' };
    }
    if (ORDER_DIRECT_RE.test(clean)) {
      let nlu = null;
      try {
        const nluResult = await classifyWithAI({ message: raw, business, session });
        if (nluResult?.entities?.products?.length || nluResult?.entities?.questions?.length) {
          nlu = {
            entities: nluResult.entities,
            secondaryIntents: nluResult.secondaryIntents || [],
            clarification: nluResult.clarification || null,
            nluSource: nluResult.source,
          };
        }
      } catch (err) {
        logger.warn('[IntentEngine] direct-order AI entity extraction failed', { err: err.message });
      }
      return {
        action: 'START_ORDER', intent: 'ORDER', confidence: 'HIGH', source: 'direct-phrase',
        ...(nlu ? { nlu } : {}),
      };
    }
  }

  // ── 4.6 Confirmation / correction detection inside an active flow ─────────
  // "Actually, make that three." / "Sorry, I meant medium." AND free-form
  // confirmations like "yeah sure that sounds good" (which don't exactly
  // equal a bare CONFIRM keyword) must stay owned by the active flow's own
  // handler rather than falling through this pipeline to the generic
  // FALLBACK/CLARIFY card — which would show an unrelated AI reply plus the
  // welcome buttons, silently derailing the flow. Only reached here (i.e.
  // AFTER the complaint and cancellation guards above) so a complaint or
  // cancellation that happens to start with "actually"/"sorry", or contain
  // "yes", is never misread as a mere correction/confirmation. Never fires
  // when there's no active flow to hand the message to.
  if (session?.currentFlow && (guard.correction || guard.confirmed)) {
    return {
      action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH',
      source: guard.correction ? 'correction-guard' : 'confirmation-guard',
    };
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
  // [UPGRADE-DIRECT-INTENT-2] In-flow short replies (4-7 chars) still short-circuit
  // to CONTINUE_FLOW without ever reaching AI classify — a mid-flow reply that
  // short is virtually always a quantity/confirmation, not a fresh intent.
  if (raw.length < 8 && session?.currentFlow) {
    return { action: 'CONTINUE_FLOW', intent: 'CONTINUE_FLOW', confidence: 'HIGH', source: 'short' };
  }
  // [UPGRADE-DIRECT-INTENT-2] Threshold lowered from 8 to 4, pre-flow only — this
  // used to bounce short-but-real requests ("buy 2", "book pls") straight to
  // CLARIFY/FALLBACK without ever giving them a chance at Groq classification.
  if (raw.length < 4) {
    if (suggestion) {
      logger.info('[IntentEngine] miss', { path: 'short-fallback', raw, suggestion: suggIntent });
      return {
        action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'levenshtein',
        suggestion: suggIntent,
      };
    }
    logger.info('[IntentEngine] miss', { path: 'short-fallback', raw });
    return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'fallback' };
  }

  // ── 7. AI classify (last resort — multi-word, non-numeric messages only) ──
  // [FIX-INTENT-AI] Skip AI classify when session is already in an active flow
  // that owns the input (e.g. ENQUIRY:AWAITING_QUESTION). The flow engine handles
  // it at step 13/15 of webhookController — running the classifier here wastes a
  // Groq API call and risks overriding the flow handler with an incorrect intent.
  if (!session?.currentFlow) {
    try {
      const nluResult = await classifyWithAI({ message: raw, business, session });
      const { intent: aiIntent, confidence: aiConfidence, entities, secondaryIntents, clarification } = nluResult;

      if (aiIntent && aiIntent !== 'UNKNOWN') {
        if (aiConfidence === 'HIGH') {
          const action = intentToAction(aiIntent, business);
          return {
            action, intent: aiIntent, confidence: 'HIGH', source: 'ai',
            nlu: { entities, secondaryIntents, clarification, nluSource: nluResult.source },
          };
        }
        logger.info('[IntentEngine] miss', { path: 'clarify', raw, aiIntent, aiConfidence });
        return {
          action: 'CLARIFY', intent: 'CLARIFY', confidence: aiConfidence, source: 'ai',
          nlu: { entities, secondaryIntents, clarification, nluSource: nluResult.source },
        };
      }
    } catch (err) {
      logger.warn('[IntentEngine] AI classify failed', { err: err.message });
    }
  }

  // ── 8. Final fallback ──────────────────────────────────────────────────────
  if (suggestion) {
    logger.info('[IntentEngine] miss', { path: 'clarify', raw, suggestion: suggIntent });
    return {
      action: 'CLARIFY', intent: 'CLARIFY', confidence: 'LOW', source: 'levenshtein',
      suggestion: suggIntent,
    };
  }

  logger.info('[IntentEngine] miss', { path: 'final-fallback', raw });
  return { action: 'FALLBACK', intent: 'FALLBACK', confidence: 'LOW', source: 'fallback' };
}

// ── AI intent classifier ──────────────────────────────────────────────────────
async function classifyWithAI({ message, business, session }) {
  const mode         = (business?.businessMode || 'RETAIL').toUpperCase();
  const validIntents = getValidIntents(mode);

  try {
    const { classifyMessageEnhanced, isEnhancedNluEnabled } = await import('../nlu/enhancedNlu.js');
    if (isEnhancedNluEnabled()) {
      return classifyMessageEnhanced({ message, business, session, validIntents });
    }
  } catch (err) {
    logger.warn('[IntentEngine] enhanced NLU unavailable', { err: err.message });
  }

  // Legacy fallback — original lean classifier
  const sanitisedMsg = sanitiseNluMessage(message, 200);

  try {
    const { classifyIntent } = await import('../ai/providers/groqProvider.js').catch(() => ({ classifyIntent: null }));
    if (classifyIntent && process.env.GROQ_API_KEY) {
      const result = await classifyIntent({ message: sanitisedMsg, validIntents, mode });
      return {
        ...result,
        entities: { products: [], questions: [] },
        secondaryIntents: [],
        clarification: null,
        source: 'legacy-fallback',
      };
    }
    return { intent: 'UNKNOWN', confidence: 'LOW', entities: { products: [], questions: [] }, source: 'legacy-fallback' };
  } catch (err) {
    logger.warn('[IntentEngine] classifyWithAI failed', { err: err.message });
    return { intent: 'UNKNOWN', confidence: 'LOW', entities: { products: [], questions: [] }, source: 'legacy-fallback' };
  }
}

function getValidIntents(mode) {
  // [FIX-VALID-INTENTS] Added ACKNOWLEDGEMENT so AI can classify longer ack phrases
  // (e.g. "I really appreciated that", "much appreciated, thank you") that bypass the
  // keyword matcher (< 8 char threshold or not in the exact ACKNOWLEDGEMENT list).
  // Without this, the model could never return ACKNOWLEDGEMENT and would default to
  // QUESTION or SUPPORT for expressions of gratitude.
  const base = ['ORDER', 'BOOKING', 'WALKIN', 'QUESTION', 'SUPPORT', 'GREETING', 'PAYMENT', 'TRACK_ORDER', 'ACKNOWLEDGEMENT', 'VIEW_MENU', 'UNKNOWN'];
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

/** Map action strings from BUTTON_ID_MAP back to semantic intents for catalog/routing. */
function actionToIntent(action) {
  const map = {
    START_ORDER:   'ORDER',
    START_BOOKING: 'BOOKING',
  };
  return map[action] || action;
}

// ── Map intent → action ───────────────────────────────────────────────────────
function intentToAction(intent, business) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();

  // [FIX-MENU-CAPABILITY-GATE] VIEW_MENU can reach this function from three
  // places — the step-4 exact-keyword match, the direct-phrase detector
  // (menuIntentDetector.js), and the AI classifier (getValidIntents() lists
  // VIEW_MENU for every mode unconditionally) — so the gate belongs here,
  // centrally, rather than duplicated at each call site. SERVICES/GENERAL
  // businesses have no ORDER/catalog flow (flows: ['ENQUIRY', 'BOOKING']);
  // mapping VIEW_MENU → BROWSE_CATALOG for them would route into
  // browseCatalogExplicit()'s fallback startFlow('ORDER'), which for these
  // modes only ever finds the generic ORDER handler operating on a business
  // with no menuItems — a broken/empty response instead of the text answer
  // their QUESTION flow is actually built to give. Downgrading to QUESTION
  // here reuses the exact same mode-specific Q&A handler "what do you offer"
  // already resolves to when it hits the QUESTION keyword list directly.
  if (intent === 'VIEW_MENU') {
    const cfg = getModeConfig(business);
    if (!(cfg.flows || []).includes('ORDER')) {
      return 'QUESTION';
    }
  }

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
    // [AUDIT-FIX-VIEWMENU] Companion to the SHOW_MENU split in patterns.js —
    // typed "menu" / "view menu" / "show menu" etc. now map to their own
    // action instead of silently reusing the reset-to-top-level SHOW_MENU
    // action, which never rendered any menu content.
    // Typed menu/catalog browsing uses the explicit native-catalog action.
    // Tenants without a ready catalog still receive the existing ORDER-menu
    // fallback from browseCatalogExplicit().
    VIEW_MENU:          'BROWSE_CATALOG',
    // [AUDIT-FIX-MAINMENU-COLLISION] Companion to the patterns.js keyword move —
    // typed "main menu" now reaches the same action as the "🏠 Main Menu" button tap.
    MAIN_MENU:          'MAIN_MENU',
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
