/**
 * services/flowService.js — Dreamline Sales Bot v20.0 (definitive)
 *
 * LAYER 2 — FLOW LOGIC ONLY.
 *
 * ── v18.0 fixes (this release) ───────────────────────────────────────────────
 * [FIX-STALE-SPREAD] CRITICAL: Stale session.data spread in all three
 *   recommendedThisSession updateSession calls (recoA/B/C) wiped data.item
 *   from the DB immediately after it was saved. Any quantity typed after a
 *   smart recommendation fired (e.g. "15" after seeing a Tapalapa pairing)
 *   found data.item === undefined and reset the flow back to the menu.
 *   Fix: include item/selected/name in each spread so the write is always safe.
 *
 * [FIX-WORDS-TO-NUMBER] Full multi-word number parser (wordsToNumber) injected
 *   as step 3 in parseQuantity, covering arbitrary word-number phrases that
 *   PHRASE_NUMBERS and WORD_NUMBERS don't catch: "thousand" → 1000,
 *   "five hundred" → 500, "one thousand two hundred" → 1200, etc.
 *
 * [FIX-SELECT-ITEM] After AI answers an off-topic message at SELECT_ITEM step,
 *   the interactive menu is also returned so the customer always has a next action.
 *
 * [FIX-UPSELL-LEAK] UPSELL_COOLDOWN_MAX evicts oldest entry when map reaches
 *   5000 entries, preventing unbounded memory growth on long-running processes.
 *
 * ── v17.0 features ───────────────────────────────────────────────────────────
 * [LARGE-QTY] Large-order confirmation prompt for qty > 20 with YES/CHANGE buttons.
 *   QTY_LARGE_CONFIRM / QTY_LARGE_CHANGE interactive button handlers.
 *
 * ── v13.0 features ───────────────────────────────────────────────────────────
 * [FLOW-1] Word-number selection: SELECT_ITEM / SELECT_SERVICE accept "one"/"two"/etc.
 * [FLOW-2] Cancel detection: exact-match phrases with startsWith guard (no substring false-positives).
 *          buildCancelUI() returns warm, professional acknowledgement with business name.
 * [FLOW-3] Partial service match: SELECT_SERVICE shows "Did you mean X?" on LOW-confidence matches.
 * [FLOW-4] buildOrderSummaryText() used for all order summaries — currency-aware, locale-formatted.
 * [FLOW-5] Rotating upsell copy — 4 natural prompts, randomly selected per session.
 * [FLOW-6] conversationMemoryService anchor written at PAYMENT_PROOF entry point (PAY-F3 support).
 * [SES-1]  _stepHint: 'PAYMENT_PROOF' passed to sessionService → 4h TTL for payment sessions.
 * [LEARN]  Smart recommendation tracking (recommendedThisSession) preserved.
 * [LEAD]   lastItem read from UserProfile.favoriteItems (persists across session resets).
 *
 *
 * BUG FIXES (from v2.6):\n * loadBusiness: session.tenantId stored as String but BusinessConfig.tenantId
 *         is ObjectId in MongoDB — plain string query never matches. Cast to ObjectId.
 * handleFinalize: added null-guard on business._id (ORDER + BOOKING paths).
 *         Null business from FIX-1 failure crashes Order.create(); now returns
 *         graceful retry UI instead of unhandled TypeError.
 * CANCEL at CONFIRM step goes through flowService (not brain short-circuit).
 *         See webhookController .
 *
 * v3.0 UX improvements preserved:
 * - buildSmartFallbackUI / buildLoopFallbackUI replace dead-end text fallbacks
 * - Loop recovery shows mode-appropriate action buttons
 * - DATE_CONFIRM / TIME_CONFIRM use CONFIRM/CANCEL buttons (not typed YES/NO)
 * - SELECT_ITEM low-confidence suggestion uses buttons
 * - RETAIL mode supported via getModeConfig()
 */

import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import BusinessConfig from '../models/BusinessConfig.js';
import mongoose       from 'mongoose';
import levenshtein    from 'fast-levenshtein';

import { updateSession, clearSession, getSession }                             from './sessionService.js';
import { trackOrderAnalytics, trackBookingAnalytics, trackFailedInteraction } from './analyticsService.js';
import { trackUser }                                                          from './learningService.js';
import { getAIReply }                                                         from './groqService.js';
import { dispatch }                                                           from './messageService.js';
import { recordOrderRevenue }                                                 from './revenueEngineService.js';
import logger                                                                 from '../config/logger.js';

import {
  getModeConfig,
  getLabel,
} from '../config/modes.js';

import {
  buildMenuUI,
  buildServicesUI,
  buildWelcomeUI,
  buildConfirmUI,
  buildInterruptUI,
  buildOrderSuccessUI,
  buildBookingSuccessUI,
  buildCancelUI,
  buildSmartFallbackUI,
  buildLoopFallbackUI,
  buildUpsellUI,
  buildPaymentInstructionsUI,
  buildAdminOrderAlert,
  buildAdminBookingAlert,
  buildEnquiryUI,
  buildAskQuestionPromptUI,
  buildOrderSummaryText,
} from '../utils/messageBuilders.js';

import { findBestMatch } from '../utils/matchEngine.js';
import { resolveFaq } from './faqService.js';
import { initiatePayment } from './paymentService.js';
import { getSmartRecommendation } from './smartRecommendationService.js';

// ─── Normalisation ────────────────────────────────────────────────────────────

const normalize = (text) =>
  String(text || '').toLowerCase().replace(/[^\w\s]/g, '').trim();

const getName = (item) => (typeof item === 'string' ? item : item.name);

// ─── Local intent helpers ─────────────────────────────────────────────────────

const isConfirm = (msg) =>
  ['yes', 'ok', 'okay', 'y', 'confirm', 'yep', 'sure', 'yup', 'yeah'].includes(msg);

const isReject = (msg) =>
  ['no', 'nope', 'nah', 'n'].includes(msg);

const isCancel = (msg) => {
  if (['cancel', 'stop', 'exit', 'quit', 'reset'].includes(msg)) return true;
  // Exact-match phrases — short enough to be ambiguous substrings if used with .includes()
  const exactCancelPhrases = [
    'never mind', 'nevermind', 'forget it', 'i changed my mind',
    'not now', 'maybe later', 'not today', 'start over', 'scratch that',
    'i dont want', 'i do not want', 'dont want', 'do not want',
    'cancel it', 'cancel that', 'cancel order', 'cancel booking',
    'i want to cancel', 'no thanks', 'no thank you',
    'abort', 'i want out', 'get me out', 'not for me', 'dont bother',
  ];
  if (exactCancelPhrases.includes(msg)) return true;
  // Substring-safe phrases — only used as prefix/suffix anchored checks
  // 'please cancel' — safe substring (unlikely inside normal sentence start)
  if (msg.startsWith('please cancel')) return true;
  return false;
};

const isBtnConfirm = (raw) => raw === 'CONFIRM' || isConfirm(normalize(raw));
const isBtnCancel  = (raw) => raw === 'CANCEL'  || isCancel(normalize(raw));
const isBtnReject  = (raw) => raw === 'CANCEL'  || isReject(normalize(raw));
const isSwitchYes  = (raw) => raw === 'SWITCH_YES' || isConfirm(normalize(raw));
const isSwitchNo   = (raw) => raw === 'SWITCH_NO'  || isReject(normalize(raw));

// ─── Upsell cooldown (per-phone, 30-min window) ───────────────────────────────
// Prevents the upsell from firing again if the customer just declined it within
// the last 30 minutes, even if the session was cleared between orders.
const _upsellCooldown = new Map(); // key: tenantId:phone → expiry timestamp
const UPSELL_COOLDOWN_MS  = 30 * 60 * 1000; // 30 minutes
const UPSELL_COOLDOWN_MAX = 5000; // Max entries before eviction (prevents memory leak on long-running processes)
function _hasUpsellCooldown(phone, tenantId) {
  const key = tenantId + ':' + phone;
  const expiry = _upsellCooldown.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) { _upsellCooldown.delete(key); return false; }
  return true;
}
function _setUpsellCooldown(phone, tenantId) {
  // Evict oldest entry when map is at capacity
  if (_upsellCooldown.size >= UPSELL_COOLDOWN_MAX) {
    _upsellCooldown.delete(_upsellCooldown.keys().next().value);
  }
  _upsellCooldown.set(tenantId + ':' + phone, Date.now() + UPSELL_COOLDOWN_MS);
}

// ─── Word-to-number ───────────────────────────────────────────────────────────

const WORD_NUMBERS = {
  // 1–19
  one:1, two:2, three:3, four:4, five:5,
  six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
  sixteen:16, seventeen:17, eighteen:18, nineteen:19,
  // tens
  twenty:20, thirty:30, forty:40, fifty:50,
  sixty:60, seventy:70, eighty:80, ninety:90,
  // common compounds (twenty-one … ninety-nine)
  ...Object.fromEntries(
    ['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'].flatMap((tens, ti) => {
      const tensVal = (ti + 2) * 10;
      return ['one','two','three','four','five','six','seven','eight','nine'].flatMap((unit, ui) => {
        const unitVal = ui + 1;
        const val     = tensVal + unitVal;
        return [
          [`${tens}-${unit}`, val],          // "twenty-one"
          [`${tens} ${unit}`, val],           // "twenty one"
          [`${tens}${unit}`,  val],           // "twentyone"
        ];
      });
    })
  ),
  // 100 as a special case
  hundred:100, 'one hundred':100,

  // ── Common misspellings & alternate spellings ─────────────────────────────
  // These are real inputs from WhatsApp customers — especially mobile autocorrect
  // and West African English phonetic spelling. Without these, the bot asks again
  // instead of resolving an obvious quantity.
  //
  // teens / low numbers
  'wan':1, 'wun':1, 'onne':1,                       // "one"
  'tow':2, 'tu':2, 'too':2,                          // "two"
  'fore':4, 'for':4,                                  // "four"
  'fife':5, 'fiv':5,                                  // "five"
  'sex':6, 'siks':6,                                  // "six"
  'sevn':7, 'sevan':7, 'seben':7,                    // "seven"
  'eght':8, 'eigth':8, 'eit':8,                      // "eight"
  'nien':9, 'nein':9,                                 // "nine"
  'ten':10,                                            // already canonical, kept for clarity
  'elevan':11, 'elever':11, 'elvn':11,               // "eleven"
  'twelv':12, 'twelf':12, 'twleve':12,               // "twelve"
  'thirten':13, 'thirtteen':13,                       // "thirteen"
  'forteen':14, 'fourten':14, 'forten':14,           // "fourteen"
  'fiften':15, 'fiveteen':15,                         // "fifteen"
  'sixten':16, 'sixteen':16,                          // "sixteen" (canonical + alt)
  'seventen':17, 'seventeeen':17,                    // "seventeen"
  'eighten':18, 'eightteen':18,                      // "eighteen"
  'ninten':19, 'nineteen':19,                         // "nineteen"
  // tens
  'twentey':20, 'tweny':20, 'twenti':20,             // "twenty"
  'thirthy':30, 'thiry':30,                           // "thirty"
  'fourty':40, 'foty':40,                             // "forty" (very common misspelling)
  'fity':50, 'fifthy':50, 'fiffty':50,               // "fifty"
  'sixthy':60, 'sixy':60,                             // "sixty"
  'seventy':70,                                        // canonical, already above
  'sevnty':70, 'sevanty':70,                         // "seventy"
  'eighty':80,                                         // canonical, already above
  'eightey':80, 'eighthy':80, 'eigthy':80,            // "eighty"
  // ninety — the bug that triggered this fix
  'ninty':90, 'niety':90,
  'ninety':90, 'ninnty':90, 'ninity':90, 'ninite':90,
};

// Negation patterns that indicate the client does NOT want a quantity
// e.g. "i don't want 4", "not 4", "maybe 4", "not interested in 4", "no 4"
const NEGATION_PATTERN = /\b(don'?t|do not|not|no|nope|never|cancel|stop|skip|none|neither|nor|without|except|refuse|reject|not interested|maybe|perhaps|unsure|idk|i don'?t know)\b/i;

// ─── Phrase-to-number map ─────────────────────────────────────────────────────
// Handles natural English quantity phrases customers actually type.
// Must be checked BEFORE single-word and digit extraction (longest-match first).
const PHRASE_NUMBERS = {
  'a dozen':      12, 'one dozen':    12, 'two dozen':    24, 'three dozen':  36,
  'half dozen':    6, 'half a dozen':  6,
  'a couple':      2, 'a pair':        2, 'a few':         3, 'several':       4,
  'a score':      20, 'a gross':     144,
  // Common compound numbers customers type as two words (without hyphen)
  'twenty one':   21, 'twenty two':   22, 'twenty three': 23, 'twenty four':  24,
  'twenty five':  25, 'twenty six':   26, 'twenty seven': 27, 'twenty eight': 28,
  'twenty nine':  29,
  'thirty one':   31, 'thirty two':   32, 'thirty three': 33, 'thirty four':  34,
  'thirty five':  35, 'thirty six':   36, 'thirty seven': 37, 'thirty eight': 38,
  'thirty nine':  39,
  'forty one':    41, 'forty two':    42, 'forty three':  43, 'forty four':   44,
  'forty five':   45, 'forty six':    46, 'forty seven':  47, 'forty eight':  48,
  'forty nine':   49,
  'fifty one':    51, 'fifty five':   55, 'sixty five':   65, 'seventy five':  75,
};
// Pre-sorted longest-first so "a dozen" matches before "a"
const PHRASE_NUMBERS_SORTED = Object.entries(PHRASE_NUMBERS).sort((a, b) => b[0].length - a[0].length);

// ─── Full multi-word number parser ─────────────────────────────────────────────
// Handles arbitrary word-number phrases PHRASE_NUMBERS doesn't cover:
// "thousand" → 1000, "five hundred" → 500, "one thousand two hundred" → 1200,
// "five hundred thousand" → 500000, "a dozen" → 12, "half a dozen" → 6, etc.
// Used as a fallback inside parseQuantity after PHRASE_NUMBERS and WORD_NUMBERS.

const _WN_ONES = {
  zero:0, oh:0, nought:0, nil:0, naught:0,
  one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
  sixteen:16, seventeen:17, eighteen:18, nineteen:19,
  wan:1, wun:1, onne:1, tow:2, tu:2, too:2, fore:4, 'for':4, foru:4,
  fife:5, fiv:5, fiev:5, sex:6, siks:6, sik:6,
  sevn:7, sevan:7, seben:7, eght:8, eigth:8, eit:8, nien:9, nein:9, nin:9,
  elevan:11, elever:11, elvn:11, leven:11, twelv:12, twelf:12, twleve:12, tweleve:12,
  thirten:13, thirtteen:13, forteen:14, fourten:14, forten:14,
  fiften:15, fiveteen:15, sixten:16, seventen:17, seventeeen:17,
  eighten:18, eightteen:18, ninten:19, nineteene:19,
  a:1, an:1,
};
const _WN_TENS = {
  twenty:20, tweny:20, twety:20, twenti:20, twentey:20, tweenty:20, twnety:20,
  thirty:30, thrity:30, thirthy:30, thiry:30, thrty:30,
  forty:40, fourty:40, forthy:40, foty:40, froty:40,
  fifty:50, fify:50, fifthy:50, fiffty:50, fity:50,
  sixty:60, sixy:60, sixthy:60, sikty:60,
  seventy:70, sevnty:70, sevanty:70,
  eighty:80, eightty:80, eighthy:80, eigthy:80, eightey:80,
  ninety:90, ninty:90, ninity:90, niety:90, ninnty:90, ninite:90, nineti:90, nienty:90,
};
const _WN_MULT = {
  hundred:100, hundreds:100, hunderd:100, hundered:100, hunded:100,
  thousand:1000, thousands:1000, thousend:1000, thousan:1000, thousnad:1000,
  million:1e6, millions:1e6, milion:1e6, millon:1e6,
  billion:1e9, billions:1e9,
};
const _WN_SPECIAL = { dozen:12, dozens:12, couple:2, pair:2, score:20 };

function _stripOrdinal(w) {
  return w
    .replace(/^(\d+)(st|nd|rd|th)$/i, '$1')
    .replace(/^first$/i,'one').replace(/^second$/i,'two').replace(/^third$/i,'three')
    .replace(/^fourth$/i,'four').replace(/^fifth$/i,'five').replace(/^sixth$/i,'six')
    .replace(/^seventh$/i,'seven').replace(/^eighth$/i,'eight').replace(/^ninth$/i,'nine')
    .replace(/^tenth$/i,'ten').replace(/^eleventh$/i,'eleven').replace(/^twelfth$/i,'twelve')
    .replace(/^(\w+)teenth$/i,'$1teen')
    .replace(/^twentieth$/i,'twenty').replace(/^thirtieth$/i,'thirty')
    .replace(/^fortieth$/i,'forty').replace(/^fiftieth$/i,'fifty')
    .replace(/^sixtieth$/i,'sixty').replace(/^seventieth$/i,'seventy')
    .replace(/^eightieth$/i,'eighty').replace(/^ninetieth$/i,'ninety');
}

function wordsToNumber(input) {
  if (!input) return null;
  if (/half[\s-]+a[\s-]+dozen/i.test(input)) return 6;
  const tokens = String(input).trim().toLowerCase()
    .replace(/-/g,' ').replace(/\band\b/gi,' ').replace(/\bof\b/gi,' ')
    .split(/[\s,]+/).filter(Boolean).map(_stripOrdinal);
  let total = 0, current = 0, found = false;
  for (const tok of tokens) {
    if (/^\d[\d,]*$/.test(tok)) { current += parseInt(tok.replace(/,/g,''),10); found=true; continue; }
    if (_WN_ONES[tok] !== undefined)      { current += _WN_ONES[tok]; found=true; }
    else if (_WN_TENS[tok] !== undefined)   { current += _WN_TENS[tok]; found=true; }
    else if (_WN_SPECIAL[tok] !== undefined){ current = (current||1)*_WN_SPECIAL[tok]; found=true; }
    else if (_WN_MULT[tok] !== undefined) {
      const m = _WN_MULT[tok];
      if (m===100) { current=(current||1)*100; } else { total+=(current||1)*m; current=0; }
      found=true;
    }
  }
  return found ? total+current : null;
}

const parseQuantity = (raw) => {
  const trimmed = raw.trim();

  // 0. Negation guard — if the message contains a negation word/phrase,
  //    do NOT extract a number from it. Return null so the bot asks again.
  if (NEGATION_PATTERN.test(trimmed)) return null;

  // 1. Plain integer — "4", "  2 "
  const direct = parseInt(trimmed, 10);
  if (!isNaN(direct) && String(direct) === trimmed.replace(/\s/g, '')) return direct;

  // 1b. Phrase numbers — "a dozen", "half dozen", "a couple", "twenty five"…
  //     Checked BEFORE single word-number so "a few" → 3, not null.
  const lower0 = trimmed.toLowerCase();
  for (const [phrase, num] of PHRASE_NUMBERS_SORTED) {
    if (lower0.includes(phrase)) return num;
  }

  // 2. Single word-number — "four", "two"
  const wordNum = WORD_NUMBERS[trimmed.toLowerCase()];
  if (wordNum !== undefined) return wordNum;

  // 3. Full multi-word number parse — "thousand" → 1000, "five hundred" → 500,
  //    "one thousand two hundred" → 1200, "I want ninty please" → 90, etc.
  //    Covers anything PHRASE_NUMBERS and WORD_NUMBERS don't already handle.
  const multiWord = wordsToNumber(trimmed);
  if (multiWord !== null) return multiWord;

  // 4. Natural-language phrases — "I want 4", "give me 3", "just 2 please", "x2"
  // Extract the first digit sequence from anywhere in the string.
  // Match digit sequence anywhere — handles "x2", "×3", "qty:4", "I want 4"
  const phraseMatch = trimmed.match(/(?:^|[^\d])(\d+)(?:[^\d]|$)/);
  if (phraseMatch) {
    const n = parseInt(phraseMatch[1], 10);
    if (!isNaN(n)) return n;
  }

  // 5. Word-number embedded in phrase — "I want four", "just twenty one"
  // Sort entries by key length descending so compound phrases ("twenty-one") are
  // tested before their constituent parts ("twenty", "one"), preventing partial matches.
  const lower = trimmed.toLowerCase();
  const sortedEntries = Object.entries(WORD_NUMBERS).sort((a, b) => b[0].length - a[0].length);
  for (const [word, num] of sortedEntries) {
    // Escape hyphens in the key so the regex stays valid for "twenty-one" etc.
    const escaped = word.replace(/-/g, '[\\s\\-]');
    // Use word-boundary anchors only around pure-word chars; space/hyphen variants
    // are handled by the escaped pattern above.
    if (new RegExp(`(?:^|\\s)${escaped}(?:\\s|$|[^a-z])`, 'i').test(lower)) return num;
  }

  // 6. Fuzzy match for single-word misspellings of word-numbers (e.g. "ninty" → 90).
  // Only attempt when the input is a single word (no spaces) of reasonable length.
  // We compare against only the simple canonical word-numbers (no compounds) to avoid
  // false positives. Levenshtein distance ≤ 2 is used so "ninty"→"ninety" (dist=1)
  // and "fourty"→"forty" (dist=1) both resolve, but "three"→"tree" (dist=1) is safe
  // because we only check words >= 4 chars (short words risk too many false positives).
  if (/^\w+$/.test(lower) && lower.length >= 4) {
    const SIMPLE_NUMS = [
      'one','two','three','four','five','six','seven','eight','nine','ten',
      'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen',
      'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety','hundred',
    ];
    let bestWord = null, bestDist = Infinity;
    for (const canon of SIMPLE_NUMS) {
      const dist = levenshtein.get(lower, canon);
      if (dist < bestDist) { bestDist = dist; bestWord = canon; }
    }
    // Accept if within edit distance 2, and the input is long enough that a distance-2
    // change isn't likely to be a totally different word.
    if (bestDist <= 2 && lower.length >= 5 && bestWord) {
      return WORD_NUMBERS[bestWord];
    }
    // For very close matches (dist=1) on shorter words (4 chars), still accept.
    if (bestDist === 1 && lower.length >= 4 && bestWord) {
      return WORD_NUMBERS[bestWord];
    }
  }

  return null;
};

// ─── Date / Time validators ───────────────────────────────────────────────────

const looksLikeDate = (input) => {
  const s = input.trim().toLowerCase();
  if (s.length < 2) return false;
  if (['today','tomorrow','yesterday','next','this','coming','following'].some(p => s.startsWith(p))) return true;
  if (['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].some(m => s.includes(m))) return true;
  if (['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].some(d => s.includes(d))) return true;
  if (/^\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?$/.test(s)) return true;
  if (/\d+\s+\w+/.test(s) || /\w+\s+\d+/.test(s)) return true;
  // Ordinal numbers: "6th", "1st", "2nd", "3rd", "6th of this month", etc.
  if (/^\d{1,2}(st|nd|rd|th)(\s+.*)?$/.test(s)) return true;
  return false;
};

const looksLikeTime = (input) => {
  const s = input.trim().toLowerCase();
  if (s.length < 2) return false;
  if (['morning','afternoon','evening','night','noon','midnight','midday'].some(p => s.includes(p))) return true;
  if (/am|pm/i.test(s)) return true;
  if (/:\d{2}/.test(s)) return true;
  if (/(in the|past|to|half|quarter)\s+\w+/.test(s)) return true;
  return false;
};

// ─── DB-persisted loop prevention ────────────────────────────────────────────

const LOOP_THRESHOLD = 3;

async function checkLoop(session, raw) {
  if (session.lastLoopMessage === raw && session.lastLoopStep === session.step) {
    const newCount = (session.loopCount || 0) + 1;
    await updateSession(session.customerPhone, session.tenantId, { loopCount: newCount });
    return newCount;
  }
  await updateSession(session.customerPhone, session.tenantId, {
    loopCount: 1,
    lastLoopMessage: raw,
    lastLoopStep:    session.step,
  });
  return 1;
}

// ─── Load business ────────────────────────────────────────────────────────────

async function loadBusiness(session) {
  // phoneNumberId is the most reliable lookup path
  if (session.phoneNumberId) {
    const b = await BusinessConfig.findOne({ phoneNumberId: session.phoneNumberId }).catch(() => null);
    if (b) return b;
  }
  // session.tenantId is a String (sessionService uses String(tenantId)).
  // BusinessConfig.tenantId is an ObjectId in Mongo — string query never matches.
  // Cast to ObjectId before querying.
  if (session.tenantId) {
    let tid = session.tenantId;
    try { tid = new mongoose.Types.ObjectId(session.tenantId); } catch { /* keep string as fallback */ }
    return BusinessConfig.findOne({ tenantId: tid }).catch(() => null);
  }
  return null;
}

// ─── Step history ─────────────────────────────────────────────────────────────
//
// [FIX-10] Always read stepHistory from the DB before appending.
// handleFlow receives `session` at call time. Multiple updateSession() calls
// between receiving the session and calling pushStep() change DB state but
// never refresh the in-memory object — so spreading session.stepHistory
// could miss intermediate pushes. Re-fetching the latest document ensures
// the history is always accurate before we write the new step.

async function pushStep(session, step) {
  const fresh   = await getSession(session.customerPhone, session.tenantId);
  const history = [...((fresh || session).stepHistory || []), step].slice(-5);
  await updateSession(session.customerPhone, session.tenantId, { stepHistory: history });
}

// ─── Step re-prompt builder (exported for webhookController AI_FALLBACK path) ─
// Returns a minimal, contextual re-prompt for the current step.
// Called when webhookController sends '' (empty string) to re-anchor the customer
// after an AI side-answer, so they always know exactly what to do next.

export function handleStepReprompt(session) {
  return _buildStepReprompt(session);
}

function _buildStepReprompt(session) {
  const data = session.data || {};
  const step = session.step;
  const flow = session.currentFlow;

  if (flow === 'ORDER') {
    if (step === 'SELECT_ITEM') {
      return { type: 'text', body: '👆 Please choose an item from the menu above, or type its name.' };
    }
    if (step === 'QUANTITY') {
      const itemName = data.item || 'your item';
      return {
        type: 'buttons',
        body: `How many *${itemName}* would you like? 🛒\n\n(Type a number or word — e.g. *1*, *2*, *five*)`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
      };
    }
    if (step === 'CONFIRM') {
      const summaryLine = data.item
        ? `🍽️ *${data.item}* × ${data.quantity || '?'}${data.totalPrice ? ` — D${data.totalPrice}` : ''}`
        : 'Your order';
      return {
        type: 'buttons',
        body: `${summaryLine}\n\nShall we go ahead? ✅`,
        buttons: [
          { id: 'CONFIRM', title: '✅ Confirm Order' },
          { id: 'CANCEL',  title: '❌ Cancel'        },
        ],
      };
    }
    if (step === 'PAYMENT_PROOF') {
      return { type: 'text', body: '📸 Please send your *Wave payment screenshot* to complete your order.' };
    }
  }

  if (flow === 'BOOKING') {
    if (step === 'SELECT_SERVICE') {
      return { type: 'text', body: '👆 Please choose a service from the list above, or type its name.' };
    }
    if (step === 'DATE') {
      return { type: 'text', body: '📅 What *date* would you like?\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)' };
    }
    if (step === 'DATE_CONFIRM') {
      return {
        type: 'buttons',
        body: `Just to confirm — did you mean *${data.date || '?'}*? 📅`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
      };
    }
    if (step === 'TIME') {
      return { type: 'text', body: '⏰ What *time* would you prefer?\n\n(e.g. *2pm*, *14:00*, *morning*)' };
    }
    if (step === 'TIME_CONFIRM') {
      return {
        type: 'buttons',
        body: `Just to confirm — did you mean *${data.time || '?'}*? ⏰`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ No, re-enter' }],
      };
    }
    if (step === 'CONFIRM') {
      const summaryLine = data.service
        ? `💅 *${data.service}* — ${data.date || '?'}${data.time ? ` at ${data.time}` : ''}`
        : `📅 ${data.date || '?'}${data.time ? ` at ${data.time}` : ''}`;
      return {
        type: 'buttons',
        body: `${summaryLine}\n\nShall we confirm your booking? ✅`,
        buttons: [
          { id: 'CONFIRM', title: '✅ Confirm Booking' },
          { id: 'CANCEL',  title: '❌ Cancel'           },
        ],
      };
    }
  }

  // Generic fallback — shouldn't be reached in normal flow
  return { type: 'text', body: '😊 What would you like to do next? Type *cancel* to stop or continue with your response.' };
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY
// ═════════════════════════════════════════════════════════════════════════════

export const handleFlow = async (session, message, tenant = null, isInteractive = false) => {
  if (!session) return { type: 'text', body: '⚠️ Something went wrong. Please type *Hi* to start fresh.' };

  const raw   = String(message || '').trim();
  const clean = normalize(raw);

  // FIX-EMPTY-REPROMPT: When webhookController sends '' (empty string) to re-prompt
  // the current step after an AI answer, return a step-appropriate prompt instead
  // of falling through to the default case which shows an unhelpful menu.
  if (!raw && session.currentFlow) {
    return _buildStepReprompt(session);
  }

  await updateSession(session.customerPhone, session.tenantId, {
    lastMessage: raw,
    // FIX-TTL: Touch expiresAt on every message so a customer who takes time
    // between steps (reading menu, deciding) never hits an expired session.
    // updateSession already does this when `step` is provided; this explicit
    // touch covers messages that don't change the step (e.g. invalid inputs).
    expiresAt: new Date(Date.now() + (30 * 60 * 1000)),
  });

  const business = await loadBusiness(session);
  if (!business) return 'Business configuration not found. Please contact support.';

  if (!session.currentFlow) return null;

  // ── Loop detection ────────────────────────────────────────────────────────
  const loopCount = await checkLoop(session, raw);
  if (loopCount >= LOOP_THRESHOLD) {
    await updateSession(session.customerPhone, session.tenantId, { loopCount: 0 });
    trackFailedInteraction(
      session.customerPhone || session.phone?.split('_')[0],
      raw, 'REPEAT', session.phoneNumberId,
    ).catch(() => {});
    const aiReply = await getAIReply(raw, business, session, 'REPEAT');
    if (aiReply) return { type: 'text', body: aiReply };
    return buildLoopFallbackUI(business);
  }

  // ── Global: cancel ────────────────────────────────────────────────────────
  // Excludes steps that have their own "No" handling. DATE_CONFIRM / TIME_CONFIRM
  // use DATE_BACK / TIME_BACK buttons, not CANCEL. UPSELL has its own decline path.
  const _cancelExcludedSteps = new Set(['UPSELL', 'DATE_CONFIRM', 'TIME_CONFIRM']);
  if (isBtnCancel(raw) && !_cancelExcludedSteps.has(session.step)) {
    await clearSession(session.customerPhone, session.tenantId);
    return buildCancelUI(business);
  }

  // FIX-4: "0" mid-flow is treated as CANCEL (with graceful cancel UI) rather
  // than an immediate session wipe with no explanation. A customer whose keyboard
  // sends a stray "0" while typing their quantity no longer loses their entire order.
  // "0" with no active flow (handled by brainService SHOW_MENU) is unaffected.
  if (raw === '0') {
    await clearSession(session.customerPhone, session.tenantId);
    return buildCancelUI(business);
  }

  // ── INTERRUPT step ────────────────────────────────────────────────────────
  if (session.step === 'INTERRUPT') {
    return handleInterrupt(session, raw, business, tenant);
  }

  // ── UPSELL step ───────────────────────────────────────────────────────────
  // One-shot add-on suggestion shown after ORDER confirmation.
  // UPSELL_YES / UPSELL_NO button taps arrive here with isInteractive=true.
  if (session.step === 'UPSELL') {
    const { item, quantity, totalPrice } = session.data || {};
    const pendingAddOn = session.pendingAddOn;
    const addOnAccepted = raw === 'UPSELL_YES' || isBtnConfirm(raw);
    // Treat as declined: explicit NO, reject/cancel phrases, OR any interactive
    // list-reply that is not UPSELL_YES (user picked a menu item mid-upsell).
    const addOnDeclined = raw === 'UPSELL_NO' || isBtnReject(raw) || isBtnCancel(raw)
      || (isInteractive && raw !== 'UPSELL_YES');

    // Quantity never changes on upsell — add-ons don't affect item count
    const updatedQty   = quantity;
    // Guard: if totalPrice is null (item had no price), treat as 0 when
    // calculating upsell total so payment instructions never show "null".
    const updatedTotal = addOnAccepted && pendingAddOn
      ? (totalPrice || 0) + pendingAddOn.price
      : totalPrice;
    const updatedItem  = addOnAccepted && pendingAddOn
      ? `${item} + ${pendingAddOn.name}`
      : item;

    if (addOnAccepted && pendingAddOn) {
      logger.info('[flowService] Upsell accepted', { addOn: pendingAddOn.name, customerPhone: session.customerPhone });
    } else if (addOnDeclined) {
      // Declined — set cooldown so upsell won't fire again within 30 min
      _setUpsellCooldown(session.customerPhone, session.tenantId);
    } else {
      // Unclear input — re-show upsell prompt
      return pendingAddOn
        ? {
            type: 'buttons',
            body: `Would you like to add a *${pendingAddOn.name}* for *D${pendingAddOn.price}*? 🥤`,
            buttons: [
              { id: 'UPSELL_YES', title: '✅ Yes, add it' },
              { id: 'UPSELL_NO',  title: '❌ No thanks'   },
            ],
          }
        : buildSmartFallbackUI(business);
    }

    // [FLOW-UPSELL SPEC]:
    // IF YES → show updated summary → then show confirm buttons
    // IF NO  → go directly to confirm buttons
    const finalTotal = addOnAccepted && pendingAddOn ? updatedTotal : totalPrice;
    const finalItem  = addOnAccepted && pendingAddOn ? updatedItem  : item;
    const finalQty   = updatedQty;

    await updateSession(session.customerPhone, session.tenantId, {
      step:         'CONFIRM',
      pendingAddOn: null,
      data: { item: finalItem, quantity: finalQty, totalPrice: finalTotal },
    });
    await pushStep(session, 'CONFIRM');

    if (addOnAccepted && pendingAddOn) {
      // STEP 3: Updated summary + confirm
      const updatedSummary =
        `🧾 *Updated Order*\n\n` +
        `🍽️ ${item} × ${quantity}\n` +
        `🥤 ${pendingAddOn.name} × 1\n` +
        `💰 Total: *D${finalTotal}*`;

      return buildConfirmUI(business, updatedSummary);
    }

    // STEP 4: Straight to confirm (upsell declined)
    const confirmText =
      getLabel(business, 'confirmOrder', finalItem, finalQty, finalTotal) ||
      `🧾 *Order Summary*\n\n🍽️ Item: *${finalItem}*\n🔢 Quantity: *${finalQty}*` +
      (finalTotal ? `\n💰 Total: *D${finalTotal}*` : '');

    return buildConfirmUI(business, confirmText);
  }


  // CANCEL at CONFIRM also goes through here — no brain short-circuit.
  if (session.step === 'CONFIRM') {
    if (isBtnConfirm(raw)) return handleFinalize(session, business, tenant);
    if (isBtnReject(raw)) {
      await clearSession(session.customerPhone, session.tenantId);
      return buildCancelUI(business);
    }
    // FIX-7: Any unrecognised input at CONFIRM (mis-tap, stray text, button replay)
    // re-renders the full confirm UI so the customer always sees their options clearly.
    // Never silently ignore input at this critical step.
    const fallbackSummary = session.currentFlow === 'ORDER'
      ? `🧾 *Order Summary*\n\n🍽️ Item: *${session.data?.item || '?'}*\n🔢 Quantity: *${session.data?.quantity || '?'}*` +
        (session.data?.totalPrice ? `\n💰 Total: *D${session.data.totalPrice}*` : '')
      : session.data?.service
        ? `📋 *Appointment Summary*\n\n💅 Service: *${session.data.service}*\n📅 Date: *${session.data?.date || '?'}*` +
          (session.data?.time ? `\n⏰ Time: *${session.data.time}*` : '')
        : `📋 *Booking Summary*\n\n📅 Date: *${session.data?.date || '?'}*` +
          (session.data?.time ? `\n⏰ Time: *${session.data.time}*` : '');

    return buildConfirmUI(
      business,
      session.currentFlow === 'ORDER'
        ? (getLabel(business, 'confirmOrder', session.data?.item, session.data?.quantity, session.data?.totalPrice) || fallbackSummary)
        : session.data?.service
            ? (getLabel(business, 'confirmBooking', session.data.service, session.data.date, session.data.time) || fallbackSummary)
            : (getLabel(business, 'confirmBooking', session.data?.date, session.data?.time) || fallbackSummary),
    );
  }

  switch (session.currentFlow) {
    case 'ORDER':   return handleOrder(session, raw, clean, business, isInteractive, tenant);
    case 'BOOKING': return handleBooking(session, raw, clean, business);
    default:
      await clearSession(session.customerPhone, session.tenantId);
      return buildWelcomeUI(business);
  }
};


// ─── Item image side-effect ────────────────────────────────────────────────────
//
// Called after an item is confirmed by the customer. Sends a single image
// (if the item has one and showImageOnSelect is not false) BEFORE the
// quantity prompt. Uses dispatch() as a non-blocking side-effect so the
// normal text reply still flows through webhookController unchanged.
//
// Rules enforced here (mirrors spec):
//   - Only 1 image max, only when user selects an item
//   - Never when listing menus, greeting, or navigating
//   - Falls back to text-only silently on any failure
//   - Never throws — image is optional enhancement only

async function _maybeSendItemImage(session, menuItem, tenant) {
  try {
    if (!menuItem?.image?.url)                 return; // no image configured
    if (menuItem.showImageOnSelect === false)   return; // owner opted out
    if (!tenant)                               return; // no tenant (shouldn't happen)

    const caption = [
      menuItem.name,
      menuItem.description ? menuItem.description : null,
      menuItem.price > 0   ? `Price: D${menuItem.price}` : null,
    ].filter(Boolean).join('\n');

    const to = session.customerPhone;
    await dispatch(to, { type: 'image', url: menuItem.image.url, caption }, tenant);
  } catch (_) {
    // Silent fail — image is decorative, never block the flow
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ORDER FLOW
// ═════════════════════════════════════════════════════════════════════════════

async function handleOrder(session, raw, clean, business, isInteractive = false, tenant = null) {
  const menu = (business?.menu || []).filter((i) => i.available !== false);

  if (session.suggestion) {
    if (isBtnConfirm(raw)) {
      const selected = session.suggestion;
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, item: selected }, step: 'QUANTITY', suggestion: null, expectedInputType: 'quantity',
      });
      await pushStep(session, 'QUANTITY');
      // Send item image if available (side-effect — non-blocking)
      const suggestedItem = (business?.menu || []).find(m => getName(m).toLowerCase() === selected.toLowerCase());
      await _maybeSendItemImage(session, suggestedItem, tenant);
      // Smart recommendation (non-blocking — never delays order flow)
      const recoA = await getSmartRecommendation(business, selected, session).catch(() => null);
      // [FIX-STALE-SPREAD] Always include item in the spread so this write never wipes
      // data.item that was stored by the updateSession call just above (session.data is
      // the in-memory snapshot from before that write, so a plain ...session.data would
      // overwrite data.item back to undefined — causing the QUANTITY step to show the menu).
      if (recoA) await updateSession(session.customerPhone, session.tenantId, { data: { ...session.data, item: selected, recommendedThisSession: true } });
      const qtyA  = `Great choice 👍\n\nHow many *${selected}* would you like?\n\n(Enter a number or word, e.g. *1*, *2*, *four*)`;
      return recoA ? { type: 'text', body: `${recoA}\n\n${qtyA}` } : qtyA;
    }
    if (isBtnReject(raw)) {
      await updateSession(session.customerPhone, session.tenantId, { suggestion: null });
      return buildMenuUI(business);
    }
    await updateSession(session.customerPhone, session.tenantId, { suggestion: null });
  }

  switch (session.step) {

    case 'SELECT_ITEM': {
      // Support both numeric ("2") and word-number ("two") for item selection
      const _rawWordNum = WORD_NUMBERS[raw.trim().toLowerCase()];
      const index = _rawWordNum !== undefined ? _rawWordNum : parseInt(raw, 10);
      if (!isNaN(index) && index > 0) {
        // [SPEC FIX] Invalid index → re-show the interactive menu, never plain text
        if (!menu[index - 1]) return buildMenuUI(business);
        const menuItem = menu[index - 1];
        const item     = getName(menuItem);
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, item }, step: 'QUANTITY', expectedInputType: 'quantity',
        });
        await pushStep(session, 'QUANTITY');
        // Send item image if available (side-effect — fires before text reply)
        await _maybeSendItemImage(session, menuItem, tenant);
        // Smart recommendation (non-blocking)
        const recoB = await getSmartRecommendation(business, item, session).catch(() => null);
        // [FIX-STALE-SPREAD] Always include item in the spread (same stale-snapshot bug as recoA).
        if (recoB) await updateSession(session.customerPhone, session.tenantId, { data: { ...session.data, item, recommendedThisSession: true } });
        const qtyB  = `Great choice 👍\n\nHow many *${item}* would you like?\n\n(Enter a number or word, e.g. *1*, *2*, *four*)`;
        return recoB ? { type: 'text', body: `${recoB}\n\n${qtyB}` } : qtyB;
      }

      if (!clean) return buildMenuUI(business);

      const { item, confidenceLevel } = findBestMatch(menu, clean);

      // [FIX] Don't re-send the menu for clearly non-menu input (random text, questions).
      // Re-sending the menu on every unrecognised message causes a frustrating loop.
      // Instead: use AI to respond helpfully, keeping the flow intact so they can
      // still select from the menu after getting a real answer.
      if (!item || confidenceLevel === 'NONE') {
        // If input looks conversational (4+ chars, not a number), ask AI first
        if (raw.trim().length >= 4 && !/^\d+$/.test(raw.trim())) {
          const aiReply = await getAIReply(raw, business, session, 'FALLBACK').catch(() => null);
          if (aiReply) return { type: 'text', body: aiReply };
        }
        // Short/garbled or AI failed → show menu with a gentle prompt
        const menuNames = menu.slice(0, 5).map((m, i) => `${i + 1}. ${getName(m)}`).join('\n');
        return {
          type: 'text',
          body: `I didn't quite catch that 😊\n\nHere are our options:\n${menuNames}\n\nReply with a *number* or item name to choose.`,
        };
      }

      const name = getName(item);

      if (confidenceLevel === 'HIGH') {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, item: name }, step: 'QUANTITY', expectedInputType: 'quantity',
        });
        await pushStep(session, 'QUANTITY');
        // Send item image if available (side-effect — fires before text reply)
        await _maybeSendItemImage(session, item, tenant);
        // Smart recommendation (non-blocking)
        const recoC = await getSmartRecommendation(business, name, session).catch(() => null);
        // [FIX-STALE-SPREAD] Always include item: name in the spread (same stale-snapshot bug as recoA/B).
        if (recoC) await updateSession(session.customerPhone, session.tenantId, { data: { ...session.data, item: name, recommendedThisSession: true } });
        const qtyC  = `Great choice 👍\n\nHow many *${name}* would you like?\n\n(Enter a number or word, e.g. *1*, *2*, *four*)`;
        return recoC ? { type: 'text', body: `${recoC}\n\n${qtyC}` } : qtyC;
      }

      // LOW confidence — buttons (v3.0)
      await updateSession(session.customerPhone, session.tenantId, { suggestion: name });
      return {
        type:    'buttons',
        body:    `Did you mean *${name}*?`,
        buttons: [
          { id: 'CONFIRM', title: '✅ Yes, that one' },
          { id: 'CANCEL',  title: '❌ No, pick again' },
        ],
      };
    }

    case 'QUANTITY': {
      // [v12] Interactive taps at QUANTITY — a button was tapped while awaiting
      // a quantity. Show a clear prompt with the item name and cancel option.
      if (isInteractive) {
        // [LARGE-QTY] Customer confirmed a large order — pull pendingLargeQty and proceed.
        if (raw === 'QTY_LARGE_CONFIRM') {
          const confirmedQty = session.data?.pendingLargeQty;
          if (confirmedQty) {
            // Clear the pending flag so a re-visit doesn't double-trigger
            await updateSession(session.customerPhone, session.tenantId, {
              data: { ...session.data, pendingLargeQty: null },
            });
            // Re-enter QUANTITY flow with the confirmed number as plain text
            return handleFlow(
              { ...session, data: { ...session.data, pendingLargeQty: null } },
              String(confirmedQty),
              business,
              false,
            );
          }
        }

        // [LARGE-QTY] Customer wants to change quantity — re-prompt cleanly.
        if (raw === 'QTY_LARGE_CHANGE') {
          const itemName = session.data?.item;
          await updateSession(session.customerPhone, session.tenantId, {
            data: { ...session.data, pendingLargeQty: null },
          });
          return {
            type: 'buttons',
            body: itemName
              ? `No problem! How many *${itemName}* would you like? 🛒\n\nType a number or word (e.g. *1*, *2*, *five*).`
              : 'Please type the quantity you\'d like (e.g. *1*, *2*, *five*).',
            buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
          };
        }

        const itemName = session.data?.item;
        const promptBody = itemName
          ? `How many *${itemName}* would you like? 🛒\n\nPlease type a *number or word* (e.g. *1*, *2*, *three*).`
          : 'Please *type* a number for the quantity (e.g. *1*, *2*, *3*).';
        return {
          type: 'buttons',
          body: promptBody,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
        };
      }

      const qty = parseQuantity(raw);

      if (qty === null || qty === undefined || qty < 1) {
        const itemName = session.data?.item;
        const nudgeBody = itemName
          ? `How many *${itemName}* would you like? 🛒\n\nPlease type a *number or word* (e.g. *1*, *2*, *three*).`
          : 'Please enter a *number or word* for the quantity (e.g. *1*, *2*, *three*).';

        // [v12 FIX] Only call AI for clearly conversational, off-topic messages
        // (not short garble, not negation-filtered inputs).
        // This prevents AI from misinterpreting "twelve" or "two" as something
        // other than a quantity, and prevents Groq from generating open-ended
        // replies that break flow context.
        if (raw.trim().length >= 10 && !/^\d+$/.test(raw.trim()) && !/^\w{1,6}$/.test(raw.trim())) {
          const aiReply = await getAIReply(raw, business, session, 'FALLBACK').catch(() => null);
          if (aiReply) {
            // After the AI answer, re-prompt for quantity with a button nudge
            return [
              { type: 'text', body: aiReply },
              {
                type: 'buttons',
                body: nudgeBody,
                buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
              },
            ];
          }
        }
        return {
          type: 'buttons',
          body: nudgeBody,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
        };
      }

      // Bounds check comes after null guard — qty is guaranteed a positive number here
      // [SPEC FIX] Button-first UX — never plain-text instructions
      if (qty > 100) {
        const itemNameForBounds = session.data?.item;
        return {
          type: 'buttons',
          body: itemNameForBounds
            ? `Maximum quantity is 100 😊\n\nHow many *${itemNameForBounds}* would you like?\n\n(Enter a number or word, e.g. *1*, *2*, *ten*)`
            : `Maximum quantity is 100 😊\n\nPlease enter a number or word between *1* and *100*.`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
        };
      }

      // [LARGE-ORDER WARN] qty 21–100 — confirm before proceeding so customers don't
      // accidentally order 30 items instead of 3. Store qty in session so the
      // YES/CONFIRM path can pick it up without re-parsing the message.
      if (qty > 20) {
        const itemNameForWarn = session.data?.item;
        const menuItemForWarn = (business?.menu || []).find(m => getName(m).toLowerCase() === (itemNameForWarn || '').toLowerCase());
        const unitPriceWarn   = menuItemForWarn?.price || 0;
        const totalWarn       = unitPriceWarn > 0 ? unitPriceWarn * qty : null;
        const currency        = business?.payment?.currency || 'GMD';
        const totalStr        = totalWarn ? ` (${currency} ${totalWarn.toLocaleString()})` : '';
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, pendingLargeQty: qty },
        });
        return {
          type: 'buttons',
          body: itemNameForWarn
            ? `Just to confirm — *${qty} × ${itemNameForWarn}*${totalStr}? 🤔\n\nThat's a large order. Did you mean ${qty}?`
            : `Just to confirm — you want *${qty} items*${totalStr}? 🤔`,
          buttons: [
            { id: 'QTY_LARGE_CONFIRM', title: `✅ Yes, ${qty} items` },
            { id: 'QTY_LARGE_CHANGE',  title: '✏️ Change Quantity' },
          ],
        };
      }

      const itemName = session.data?.item;
      if (!itemName) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return buildMenuUI(business);
      }

      const menuItem   = (business?.menu || []).find(m => getName(m).toLowerCase() === itemName.toLowerCase());
      const unitPrice  = menuItem?.price || 0;
      const totalPrice = unitPrice > 0 ? unitPrice * qty : null;

      // [FLOW-UPSELL] Decide UPSELL vs CONFIRM before writing to DB — only one write needed.
      // Step transitions: QUANTITY → UPSELL (if add-ons available) OR CONFIRM (direct)
      const cfg    = getModeConfig(business);
      const addOns = cfg.addOns || [];

      // [v13] Clean modern order summary via shared builder — currency-aware, locale-formatted
      const currency    = business?.payment?.currency || 'GMD';
      const summaryText = buildOrderSummaryText(itemName, qty, totalPrice, currency);

      if (addOns.length > 0 && !session.upsellSent && !_hasUpsellCooldown(session.customerPhone, session.tenantId)) {
        // Pick a random add-on and queue upsell immediately after summary
        const addOn = addOns[Math.floor(Math.random() * addOns.length)];
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, quantity: qty, totalPrice },
          step: 'UPSELL',
          upsellSent:  true,
          pendingAddOn: { name: addOn.name, price: addOn.price },
        });
        await pushStep(session, 'UPSELL');

        // [v13] Natural upsell language — rotates through friendly prompts
        const upsellPrompts = [
          `Most customers pair *${itemName}* with a *${addOn.name}* 😄\nWant to add one for *D${addOn.price}*?`,
          `Don't forget drinks! Add a *${addOn.name}* for just *D${addOn.price}*? 🥤`,
          `Quick add: *${addOn.name}* for *D${addOn.price}*. Worth it! 😊`,
          `Top it off with a *${addOn.name}* — only *D${addOn.price}* extra. Yes? 🙌`,
        ];
        const upsellCopy = upsellPrompts[Math.floor(Math.random() * upsellPrompts.length)];

        return {
          type: 'buttons',
          body: summaryText + `\n\n${upsellCopy}`,
          buttons: [
            { id: 'UPSELL_YES', title: '✅ Yes, add it' },
            { id: 'UPSELL_NO',  title: '❌ No thanks'   },
          ],
        };
      }

      // No upsell → go straight to confirm prompt
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, quantity: qty, totalPrice }, step: 'CONFIRM',
      });
      await pushStep(session, 'CONFIRM');

      const confirmText =
        getLabel(business, 'confirmOrder', itemName, qty, totalPrice) ||
        summaryText;

      return buildConfirmUI(business, confirmText);
    }

    case 'PAYMENT_PROOF': {
      // [v11] Payment retry tracking — after 2 text messages during PAYMENT_PROOF,
      // suggest contacting the business directly for support.
      const { totalPrice } = session.data || {};
      const retryCount = (session.paymentRetryCount || 0) + 1;
      await updateSession(session.customerPhone, session.tenantId, { paymentRetryCount: retryCount });

      // After 3 messages without a screenshot, offer human support with a button escape
      if (retryCount >= 3) {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        const supportBody = adminPhone
          ? `It looks like you might need help with your payment. 🙏\n\nPlease contact us directly at *${adminPhone}* and we'll sort it out for you.`
          : `Please send your *Wave payment screenshot* to complete your order.`;
        return {
          type: 'buttons',
          body: supportBody,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
        };
      }

      // Try AI for conversational messages (questions, complaints, etc.)
      if (raw.trim().length >= 4) {
        const aiReply = await getAIReply(raw, business, session, 'FALLBACK').catch(() => null);
        if (aiReply) {
          const reminder = '\n\n💳 Reminder: please send your *Wave payment screenshot* to complete your order.';
          return { type: 'text', body: aiReply + reminder };
        }
      }

      // Fallback: re-show full payment instructions (handles null totalPrice safely)
      return buildPaymentInstructionsUI(business, totalPrice, String(session.customerPhone).slice(-4));
    }

    default:
      // FIX-8: Unknown step in ORDER flow — reset to SELECT_ITEM and show menu.
      // This handles edge cases where a session has a step value that no longer
      // maps to a valid case (schema migration, corrupted state, etc.).
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
      return buildMenuUI(business);
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// BOOKING FLOW
// ═════════════════════════════════════════════════════════════════════════════

async function handleBooking(session, raw, clean, business) {
  // Handle pending service suggestion (LOW confidence "Did you mean?" from SELECT_SERVICE)
  if (session.suggestion && session.step === 'SELECT_SERVICE') {
    if (isBtnConfirm(raw)) {
      const selected = session.suggestion;
      const services = (business?.services || []).filter(s => s.available !== false);
      const svcItem  = services.find(s => s.name.toLowerCase() === selected.toLowerCase());
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, service: selected, serviceDuration: svcItem?.duration },
        step: 'DATE', suggestion: null, expectedInputType: 'date',
      });
      await pushStep(session, 'DATE');
      const prompt = getLabel(business, 'bookPrompt') || 'What date would you like?';
      return `Great! *${selected}* selected ✅\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
    }
    if (isBtnReject(raw)) {
      await updateSession(session.customerPhone, session.tenantId, { suggestion: null });
      return buildServicesUI(business);
    }
    await updateSession(session.customerPhone, session.tenantId, { suggestion: null });
  }

  switch (session.step) {

    case 'SELECT_SERVICE': {
      const services = (business?.services || []).filter(s => s.available !== false);

      // No services configured — skip to DATE step rather than looping
      if (services.length === 0) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'DATE' });
        const prompt = getLabel(business, 'bookPrompt') || 'What date would you like?';
        return `No booking types are currently listed, but we can still book you in!\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
      }

      // Support both numeric ("2") and word-number ("two") for service selection
      const _svcWordNum = WORD_NUMBERS[raw.trim().toLowerCase()];
      const index = _svcWordNum !== undefined ? _svcWordNum : parseInt(raw, 10);
      if (!isNaN(index) && index > 0) {
        // [SPEC FIX] Invalid index → re-show the interactive services list, never plain text
        if (!services[index - 1]) return buildServicesUI(business);
        const svc = services[index - 1];
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, service: svc.name, serviceDuration: svc.duration }, step: 'DATE', expectedInputType: 'date',
        });
        await pushStep(session, 'DATE');
        const prompt = getLabel(business, 'bookPrompt') || 'What date would you like?';
        return `Great! *${svc.name}* selected ✅\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
      }
      const { item: svcMatch, confidenceLevel } = findBestMatch(services, clean);
      if (svcMatch && confidenceLevel === 'HIGH') {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, service: svcMatch.name, serviceDuration: svcMatch.duration }, step: 'DATE', expectedInputType: 'date',
        });
        await pushStep(session, 'DATE');
        const prompt = getLabel(business, 'bookPrompt') || 'What date would you like?';
        return `Great! *${svcMatch.name}* selected ✅\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
      }

      // LOW confidence — ask "Did you mean?" with buttons (mirrors SELECT_ITEM behaviour)
      if (svcMatch && confidenceLevel === 'LOW') {
        await updateSession(session.customerPhone, session.tenantId, { suggestion: svcMatch.name });
        return {
          type:    'buttons',
          body:    `Did you mean *${svcMatch.name}*?`,
          buttons: [
            { id: 'CONFIRM', title: '✅ Yes, that one' },
            { id: 'CANCEL',  title: '❌ No, pick again' },
          ],
        };
      }

      return buildServicesUI(business);
    }

    case 'DATE': {
      const dateInput = raw.trim();
      if (dateInput.length < 2) {
        return getLabel(business, 'bookPrompt') || 'Please tell me the *date* for your booking 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)';
      }
      if (isConfirm(clean) || isReject(clean)) {
        return 'I need a *date* for your booking 📅\n\nWhat date works for you?\n(e.g. *25 June*, *next Friday*, *tomorrow*)';
      }
      if (!looksLikeDate(dateInput)) {
        // Long/conversational input → Groq handles it (complaint, question, etc.)
        if (dateInput.length >= 8 && !/\d/.test(dateInput)) {
          const aiReply = await getAIReply(dateInput, business, session, 'FALLBACK').catch(() => null);
          if (aiReply) return { type: 'text', body: aiReply };
        }
        return {
          type: 'buttons',
          body: (
            `I need a *date* for your booking 📅\n\n` +
            `Please give me a date, for example:\n` +
            `• *25 June*\n• *tomorrow*\n• *next Friday*\n• *25/06/2025*`
          ),
          buttons: [{ id: 'CANCEL', title: '❌ Cancel Booking' }],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, date: dateInput }, step: 'DATE_CONFIRM',
      });
      await pushStep(session, 'DATE_CONFIRM');
      return {
        type:    'buttons',
        body:    `Just to confirm — did you mean *${dateInput}*? 📅`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
      };
    }

    case 'DATE_CONFIRM': {
      if (isConfirm(clean) || isBtnConfirm(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'TIME', expectedInputType: 'time' });
        await pushStep(session, 'TIME');
        const timePrompt = getLabel(business, 'timePrompt') || 'What time would you prefer?';
        return `Got it — *${session.data?.date}* ✅\n\n${timePrompt} ⏰\n\n(e.g. *2pm*, *14:00*, *morning*)`;
      }
      // DATE_BACK is the "❌ No, re-enter" button ID — send back to DATE step.
      // NOTE: raw === 'CANCEL' is intentionally NOT handled here; that falls
      // through to the global cancel guard above which clears the whole session.
      if (raw === 'DATE_BACK' || isReject(clean)) {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, date: null }, step: 'DATE',
        });
        return "No problem! Let's try again.\n\nWhat *date* would you like to book? 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)";
      }
      const newDate = raw.trim();
      if (looksLikeDate(newDate)) {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, date: newDate }, step: 'DATE_CONFIRM',
        });
        return {
          type:    'buttons',
          body:    `Just to confirm — did you mean *${newDate}*? 📅`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
        };
      }
      return `Please tap *Yes* to confirm *${session.data?.date}* or *No* to change it.`;
    }

    case 'TIME': {
      const timeInput = raw.trim();
      if (timeInput.length < 2) {
        return getLabel(business, 'timePrompt') || 'Please enter a *time* for your booking ⏰\n\n(e.g. *2pm*, *14:00*, *morning*)';
      }
      if (isConfirm(clean) || isReject(clean)) {
        return 'I need a *time* for your booking ⏰\n\nWhat time works for you?\n(e.g. *2pm*, *14:00*, *morning*)';
      }
      if (!looksLikeTime(timeInput)) {
        // Long/conversational input → Groq handles it
        if (timeInput.length >= 8 && !/\d/.test(timeInput) && !/am|pm/i.test(timeInput)) {
          const aiReply = await getAIReply(timeInput, business, session, 'FALLBACK').catch(() => null);
          if (aiReply) return { type: 'text', body: aiReply };
        }
        return {
          type: 'buttons',
          body: (
            `I need a *time* for your booking ⏰\n\n` +
            `Please give me a time, for example:\n` +
            `• *2pm* or *2:00pm*\n• *14:00*\n• *morning*\n• *6 in the morning*`
          ),
          buttons: [{ id: 'CANCEL', title: '❌ Cancel Booking' }],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, {
        data: { ...session.data, time: timeInput }, step: 'TIME_CONFIRM',
      });
      await pushStep(session, 'TIME_CONFIRM');
      return {
        type:    'buttons',
        body:    `Just to confirm — did you mean *${timeInput}*? ⏰`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ No, re-enter' }],
      };
    }

    case 'TIME_CONFIRM': {
      if (isConfirm(clean) || isBtnConfirm(raw)) {
        const { date, time, service } = session.data || {};
        await updateSession(session.customerPhone, session.tenantId, { step: 'CONFIRM', expectedInputType: 'confirmation' });
        await pushStep(session, 'CONFIRM');
        const summaryText = service
          ? getLabel(business, 'confirmBooking', service, date, time)
            || `📋 *Appointment Summary*\n\n💅 Service: *${service}*\n📅 Date: *${date}*${time ? `\n⏰ Time: *${time}*` : ''}`
          : getLabel(business, 'confirmBooking', date, time)
            || `📋 *Booking Summary*\n\n📅 Date: *${date || 'Not specified'}*${time ? `\n⏰ Time: *${time}*` : ''}`;
        return buildConfirmUI(business, summaryText);
      }
      // TIME_BACK is the "❌ No, re-enter" button ID — send back to TIME step.
      // NOTE: raw === 'CANCEL' is intentionally NOT handled here; that falls
      // through to the global cancel guard above which clears the whole session.
      if (raw === 'TIME_BACK' || isReject(clean)) {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, time: null }, step: 'TIME',
        });
        return "No problem! Let's try again.\n\nWhat *time* would you prefer? ⏰\n\n(e.g. *2pm*, *14:00*, *morning*)";
      }
      const newTime = raw.trim();
      if (looksLikeTime(newTime)) {
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...session.data, time: newTime }, step: 'TIME_CONFIRM',
        });
        return {
          type:    'buttons',
          body:    `Just to confirm — did you mean *${newTime}*? ⏰`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ No, re-enter' }],
        };
      }
      return `Please tap *Yes* to confirm *${session.data?.time}* or *No* to change it.`;
    }

    default: {
      const cfg = getModeConfig(business);
      let firstStep = cfg.bookingSteps[0] || 'DATE';
      // Skip SELECT_SERVICE when no services are configured
      if (firstStep === 'SELECT_SERVICE') {
        const availableSvcs = (business?.services || []).filter(s => s.available !== false);
        if (availableSvcs.length === 0) firstStep = 'DATE';
      }
      await updateSession(session.customerPhone, session.tenantId, { step: firstStep });
      if (firstStep === 'SELECT_SERVICE') return buildServicesUI(business);
      return getLabel(business, 'bookPrompt') || "Let's start over 😊\n\nWhat *date* would you like to book? 📅";
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// FINALIZE
// ═════════════════════════════════════════════════════════════════════════════

async function handleFinalize(session, business, tenant) {

  const gracefulRetryUI = (flow) => {
    const bizName = business?.name || 'us';
    const action  = flow === 'ORDER' ? '*Order*' : '*Book*';
    return {
      type: 'text',
      body: `We're having a little trouble right now 🙏\n\nYour request didn't go through — but it's not your fault!\n\nPlease try again by typing ${action}, or contact *${bizName}* directly if the problem continues.`,
    };
  };

  if (session.currentFlow === 'ORDER') {
    const { item, quantity, totalPrice } = session.data || {};

    if (!item || !quantity) {
      logger.error('[flowService] Order finalize: missing item or quantity', { item, quantity, customerPhone: session.customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('ORDER');
    }

    // Guard against null/incomplete business object
    if (!business?._id) {
      logger.error('[flowService] Order finalize: business not found or missing _id', {
        tenantId: session.tenantId, phoneNumberId: session.phoneNumberId, customerPhone: session.customerPhone,
      });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('ORDER');
    }

    if (!tenant?._id) {
      logger.error('[flowService] Order finalize: no tenant _id', { tenantId: session.tenantId, customerPhone: session.customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('ORDER');
    }

    const customerPhone = session.customerPhone || session.phone;

    // [FIX-6a] Determine paymentMethod BEFORE Order.create.
    // Hardcoding 'wave' stamped every order with paymentMethod='wave' even for
    // businesses using cash, card, or no payment — breaking all payment filtering.
    const _wavePhone = business?.payment?.wavePhone?.trim() || business?.wavePhone?.trim();
    const _waveInstr = business?.customMessages?.payment?.trim() ||
                       business?.customMessages?.paymentInstructions?.trim();
    const _hasPaymentConfig = !!(_wavePhone || _waveInstr);

    // [FIX-3] Capture the return value of Order.create() directly.
    // The original code discarded it and then did a second Order.findOne() to
    // retrieve the saved doc — opening a race window where a retry tap from the
    // same customer within 60 seconds could cause findOne to return the WRONG
    // (older) order and trigger initiatePayment on that stale record.
    let savedOrder;
    try {
      savedOrder = await Order.create({
        phone:         customerPhone,
        customerPhone,
        businessId:    business._id,
        tenantId:      tenant._id,
        item,
        quantity,
        totalPrice:    totalPrice || null,
        status:        'pending',
        paymentMethod: _hasPaymentConfig ? 'wave' : null,
        paymentStatus: 'unpaid',
      });
    } catch (err) {
      logger.error('[flowService] Order save error', { err: err.message, item, quantity, customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('ORDER');
    }

    trackOrderAnalytics(item, session.phoneNumberId, quantity, totalPrice || 0, session.tenantId).catch(() => {});
    recordOrderRevenue({ item, quantity, totalPrice: totalPrice || 0, phoneNumberId: session.phoneNumberId, customerPhone }).catch(() => {});
    trackUser(customerPhone, item, 'ORDER', { item }).catch(() => {});

    // [FIX-6b] Fall back to tenant.adminPhone when business.adminPhone is not set.
    const _orderAlertPhone = business.adminPhone || tenant?.adminPhone;
    if (_orderAlertPhone) {
      const alert = buildAdminOrderAlert(customerPhone, item, quantity, business, totalPrice);
      dispatch(_orderAlertPhone, { type: 'text', body: alert }, tenant).catch((err) =>
        logger.error('[flowService] Admin order alert failed', { err: err.message }));
    }

    // ── Wave payment flow ─────────────────────────────────────────────────
    if (_hasPaymentConfig) {
      let paymentMsg;
      try {
        paymentMsg = await initiatePayment(savedOrder._id, business);
      } catch { /* fallback to builder */ }

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'PAYMENT_PROOF',
        // [FIX-ORDER-TRACK] Store orderId so payment rejection/approval can
        // always re-link the session to the correct order regardless of status.
        data: { item, quantity, totalPrice, orderId: String(savedOrder._id) },
        expectedInputType: 'image',
        _stepHint: 'PAYMENT_PROOF',   // [v13 SES-1] triggers 4-hour TTL in sessionService
      });
      // [v13 PAY-F3] Anchor order to customer for proof-recovery fallback (conversationMemoryService)
      const { anchorOrderToCustomer } = await import('./conversationMemoryService.js');
      anchorOrderToCustomer(savedOrder._id, session.customerPhone, session.tenantId).catch(() => {});
      return paymentMsg
        ? { type: 'text', body: paymentMsg }
        : buildPaymentInstructionsUI(business, totalPrice, String(customerPhone).slice(-4));
    }

    // No payment configured — clear session and confirm
    await clearSession(session.customerPhone, session.tenantId);
    // Use buildOrderSuccessUI for a structured, mode-aware confirmation — mirrors
    // the BOOKING path which correctly calls buildBookingSuccessUI. The plain
    // afterOrder label is still honoured as the body if the owner configured it.
    const afterOrderLabel = getLabel(business, 'afterOrder');
    if (afterOrderLabel) {
      return { type: 'text', body: afterOrderLabel };
    }
    return buildOrderSuccessUI(business, item, quantity);
  }

  if (session.currentFlow === 'BOOKING') {
    const { date, time, service, serviceDuration } = session.data || {};

    if (!date && !service) {
      logger.error('[flowService] Booking finalize: missing date and service', { customerPhone: session.customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('BOOKING');
    }

    // Guard against null business for BOOKING path too
    if (!business?._id) {
      logger.error('[flowService] Booking finalize: business not found or missing _id', {
        tenantId: session.tenantId, phoneNumberId: session.phoneNumberId, customerPhone: session.customerPhone,
      });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('BOOKING');
    }

    if (!tenant?._id) {
      logger.error('[flowService] Booking finalize: no tenant _id', { tenantId: session.tenantId, customerPhone: session.customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('BOOKING');
    }

    const customerPhone = session.customerPhone || session.phone;

    // Capture customerName and partySize from session for admin visibility and reminders
    const _customerName = session.customerName || null;
    const _partySize    = session.data?.partySize || null;

    // [SC-2] Attempt to parse the free-text date into a JS Date for the scheduler.
    // The scheduler uses parsedDate for accurate reminder timing — if null it falls
    // back to the createdAt window which is imprecise. Best-effort: never crash if
    // the date string is unrecognised (e.g. "next Friday", "tomorrow", "25 June").
    let _parsedDate = null;
    if (date) {
      try {
        const d = new Date(date);
        // Reject NaN and clearly wrong dates (Date parses many strings but some give
        // Invalid Date or year 2001 from bare "June" with no year context)
        if (!isNaN(d.getTime()) && d.getFullYear() >= new Date().getFullYear()) {
          _parsedDate = d;
        }
      } catch { /* non-fatal — scheduler falls back to createdAt window */ }
    }

    try {
      await Booking.create({
        phone:         customerPhone,
        customerPhone,
        businessId:    business._id,
        tenantId:      tenant._id,
        date:          date    || null,
        time:          time    || null,
        service:       service || null,
        duration:      serviceDuration || null,
        status:        'pending',
        notifiedAt:    null,
        // [FIX] Persist customer name and party size — required for admin workflow
        // and booking reminder templates. Previously always null in every booking.
        customerName:  _customerName,
        partySize:     _partySize,
        // [SC-2] Parsed date for accurate scheduler reminder timing
        parsedDate:    _parsedDate,
      });
    } catch (err) {
      logger.error('[flowService] Booking save error', { err: err.message, date, time, service, customerPhone });
      await clearSession(session.customerPhone, session.tenantId);
      return gracefulRetryUI('BOOKING');
    }

    trackBookingAnalytics({ date, time, phoneNumberId: session.phoneNumberId, tenantId: session.tenantId }).catch(() => {});
    trackUser(customerPhone, date || service, 'BOOKING', {}).catch(() => {});

    // [FIX-6d] Same tenant.adminPhone fallback as the ORDER path above.
    const _bookingAlertPhone = business.adminPhone || tenant?.adminPhone;
    if (_bookingAlertPhone) {
      const alert = buildAdminBookingAlert(customerPhone, date || 'TBD', time, business, service);
      dispatch(_bookingAlertPhone, { type: 'text', body: alert }, tenant).catch((err) =>
        logger.error('[flowService] Admin booking alert failed', { err: err.message }));
    }

    await clearSession(session.customerPhone, session.tenantId);
    // [v11] Pass service as 3rd arg so bookingSuccess label can include it
    return buildBookingSuccessUI(business, date || null, time, service || null);
  }

  await clearSession(session.customerPhone, session.tenantId);
  return buildWelcomeUI(business);
}


// ═════════════════════════════════════════════════════════════════════════════
// INTERRUPT
// ═════════════════════════════════════════════════════════════════════════════

async function handleInterrupt(session, raw, business, tenant) {

  if (isSwitchYes(raw)) {
    const newFlow = session.pendingIntent;
    if (!newFlow || !['ORDER', 'BOOKING'].includes(newFlow)) {
      await clearSession(session.customerPhone, session.tenantId);
      return buildWelcomeUI(business);
    }
    const cfg = getModeConfig(business);
    let firstStep = newFlow === 'ORDER' ? cfg.orderSteps[0] || 'SELECT_ITEM' : cfg.bookingSteps[0] || 'DATE';

    // Skip SELECT_SERVICE when no services are configured
    if (newFlow === 'BOOKING' && firstStep === 'SELECT_SERVICE') {
      const availableSvcs = (business?.services || []).filter(s => s.available !== false);
      if (availableSvcs.length === 0) firstStep = 'DATE';
    }

    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: newFlow, step: firstStep, data: {},
      pendingIntent: null, previousStep: null, previousFlow: null, suggestion: null,
    });
    if (newFlow === 'ORDER')            return buildMenuUI(business);
    if (firstStep === 'SELECT_SERVICE') return buildServicesUI(business);
    return `Sure! Let's set up your booking 📅\n\nWhat *date* would you like?\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`;
  }

  if (isSwitchNo(raw)) {
    const prevStep = session.previousStep ||
      (session.currentFlow === 'ORDER' ? 'SELECT_ITEM' : 'DATE');
    await updateSession(session.customerPhone, session.tenantId, {
      step: prevStep, pendingIntent: null, previousStep: null,
    });

    if (session.currentFlow === 'BOOKING') {
      if (prevStep === 'TIME' || prevStep === 'TIME_CONFIRM') {
        const d = session.data?.date || 'your booking';
        return `No problem! Continuing your booking.\n\nWhat *time* would you like for *${d}*? ⏰`;
      }
      if (prevStep === 'DATE_CONFIRM') {
        return {
          type:    'buttons',
          body:    `No problem! Continuing your booking.\n\nJust to confirm — did you mean *${session.data?.date}*? 📅`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
        };
      }
      if (prevStep === 'SELECT_SERVICE') return buildServicesUI(business);
      if (prevStep === 'CONFIRM') {
        const { date, time, service } = session.data || {};
        const summaryText = service
          ? `📋 *Appointment Summary*\n\n💅 Service: *${service}*\n📅 Date: *${date}*${time ? `\n⏰ Time: *${time}*` : ''}`
          : `📋 *Booking Summary*\n\n📅 Date: *${date}*${time ? `\n⏰ Time: *${time}*` : ''}`;
        return buildConfirmUI(business, summaryText);
      }
      return "No problem! Continuing your booking.\n\nWhat *date* would you like? 📅";
    }

    if (prevStep === 'QUANTITY' && session.data?.item) {
      return `No problem! Continuing your order.\n\nHow many *${session.data.item}* would you like?`;
    }
    if (prevStep === 'CONFIRM' && session.data?.item) {
      return buildConfirmUI(
        business,
        `🧾 *Order Summary*\n\n🍽️ Item: *${session.data.item}*\n🔢 Quantity: *${session.data.quantity}*`,
      );
    }
    return buildMenuUI(business);
  }

  return buildInterruptUI(business, session.currentFlow, session.pendingIntent || 'ORDER');
}


// ═════════════════════════════════════════════════════════════════════════════
// FLOW STARTERS
// ═════════════════════════════════════════════════════════════════════════════

export async function startOrderFlow(session, business) {
  const cfg = getModeConfig(business);
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'ORDER', step: cfg.orderSteps[0] || 'SELECT_ITEM', data: {}, suggestion: null,
  });
  return buildMenuUI(business);
}

export async function startBookingFlow(session, business) {
  const cfg = getModeConfig(business);
  let firstStep = cfg.bookingSteps[0] || 'DATE';

  // If SELECT_SERVICE is the first step but no services are configured,
  // skip straight to DATE so the customer isn't shown an empty/stale services list.
  const availableServices = (business?.services || []).filter(s => s.available !== false);
  if (firstStep === 'SELECT_SERVICE' && availableServices.length === 0) {
    firstStep = 'DATE';
    logger.warn('[flowService] startBookingFlow: SELECT_SERVICE step skipped — no services configured', {
      tenantId: session.tenantId,
    });
  }

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'BOOKING', step: firstStep, data: {}, suggestion: null,
  });
  if (firstStep === 'SELECT_SERVICE') return buildServicesUI(business);
  const prompt = getLabel(business, 'bookPrompt') || 'What date would you like to book?';
  return { type: 'text', body: `Sure 👍\n\n${prompt} 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)` };
}

// ─── Enquiry handler ──────────────────────────────────────────────────────────
//
// Called when brainService detects action:'ENQUIRY' — meaning the user typed
// something like "enquiry", "I don't understand", "help", "i have a question"
// EITHER inside a protected flow step (DATE, TIME, QUANTITY…) OR with no
// active flow at all.
//
// Behaviour:
//   - Does NOT clear the session — user can continue their flow after.
//   - Shows a friendly topic menu + the standard flow action buttons.
//   - If an FAQ entry matches, shows that answer first.
//   - Falls back to Groq for a context-aware answer if configured.
//
// This is the function that fixes the screenshot bug:
//   User: "Enquiry" (mid-booking DATE step)
//   Old:  "Sorry, I couldn't understand 'Enquiry' as a date 📅"
//   New:  "Sure! 😊 What would you like to know? You can ask about: …"

/**
 * handleEnquiry — Two-phase question flow.
 *
 * PHASE 1 — "Ask a Question" button tapped (no real question yet):
 *   • Set session.mode = 'awaiting_question'
 *   • Reply with a prompt asking WHAT they want to know
 *   • DO NOT call Groq. DO NOT show business info. Just ask.
 *
 * PHASE 2 — Customer sends their actual question:
 *   • session.mode === 'awaiting_question'  →  treat message as the question
 *   • FAQ first, then Groq, then static menu
 *   • Clear awaiting_question state
 *
 * Called from webhookController for both the initial button press AND the
 * follow-up message (via the ENQUIRY action path).
 */
export async function handleEnquiry(session, raw, business, tenant) {
  const customerPhone = session?.customerPhone;
  const tenantId      = session?.tenantId;

  // ── PHASE 1: Customer just tapped "Ask a Question" (raw is the button label,
  //    e.g. "Ask a Question", "question", "help", "enquiry" — none of these are
  //    real questions). Set awaiting_question and ask what they want to know.
  const triggerPhrases = new Set([
    'ask a question', 'question', 'ask', 'enquiry', 'enquire',
    'help', 'i have a question', 'i want to ask', 'i need help',
  ]);
  const normalizedRaw = raw.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');

  const isEnquiryTrigger = triggerPhrases.has(normalizedRaw);

  if (isEnquiryTrigger && session?.mode !== 'awaiting_question') {
    // Store state so next message is treated as the actual question
    if (customerPhone && tenantId) {
      await updateSession(customerPhone, tenantId, { mode: 'awaiting_question' });
    }
    return buildAskQuestionPromptUI(business);
  }

  // ── PHASE 2: We are awaiting their question and they've now sent it.
  //    raw IS the real question — answer it.
  if (customerPhone && tenantId) {
    // Clear awaiting_question so we don't loop
    await updateSession(customerPhone, tenantId, { mode: null });
  }

  // 1. Check FAQ first — instant, no AI cost
  const faqAnswer = resolveFaq(raw, business);
  if (faqAnswer) {
    return { type: 'text', body: faqAnswer };
  }

  // 2. Try Groq for a context-aware answer if it's a real question (>= 4 chars)
  if (raw.trim().length >= 4) {
    try {
      const aiReply = await getAIReply(raw, business, session, 'ENQUIRY');
      if (aiReply) return { type: 'text', body: aiReply };
    } catch (_) { /* fall through to static UI */ }
  }

  // 3. Static enquiry menu — always friendly, never a dead-end
  return buildEnquiryUI(business);
}
