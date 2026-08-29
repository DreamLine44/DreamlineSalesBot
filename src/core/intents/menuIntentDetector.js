/**
 * core/intents/menuIntentDetector.js
 *
 * [FIX-MENU-COVERAGE] Token-based (word-order-independent) detector for "show me
 * the menu / what do you have / what can I eat" style requests.
 *
 * WHY NOT ONE BIG REGEX: the old VIEW_MENU_DIRECT_RE approach (still exported
 * from intentEngine.js for reference) enumerated one alternation per sentence
 * shape. Every new way a customer phrases "let me see what you've got" needed
 * its own clause added, and it will never be exhaustive — natural language has
 * effectively infinite surface forms. This detector instead scores a message
 * on two independent, much shorter axes and fires when it sees a signal from
 * each, so it generalizes to phrasings nobody explicitly wrote a pattern for.
 *
 *   BROWSE_SIGNAL — "I want to look at / know about ..." (show, see, what, etc.)
 *   MENU_NOUN     — "... the food / items / menu / catalog"
 *
 * Three tiers, checked in order:
 *   1. STRONG_STANDALONE_NOUNS — words that mean "the browsable list" on their
 *      own with no verb needed ("menu", "catalog", "price list", ...). Safe to
 *      fire alone because these words essentially never appear in a genuine
 *      order/booking sentence.
 *   2. BROWSE_SIGNAL + AMBIGUOUS_NOUN pairing — broader nouns like "food",
 *      "items", "products", "options" are ambiguous alone ("I want food" is an
 *      ORDER, not a browse request) so they only fire paired with a browsing
 *      verb/question-word. Exact "i want food" phrasing is already resolved
 *      earlier by the step-4 exact-keyword match / ORDER_DIRECT_RE before this
 *      detector is ever reached, so the overlap here is intentionally safe.
 *   3. IMPLICIT_MENU_RE — a shorter list of common noun-less browsing asks
 *      ("what's good", "any recommendations", "surprise me", pidgin phrasing)
 *      that don't fit the verb+noun shape at all.
 *
 * Callers are responsible for applying DIRECT_INTENT_EXCLUDE_RE (cancel/track/
 * status phrasing) before calling this — this module only judges "is this a
 * browse-the-catalog request", not whether it's safe to act on right now.
 */

import { isBookingInfoQuestion } from '../../services/question/questionModeHelper.js';

// Words that unambiguously mean "the browsable list of things you sell",
// regardless of surrounding words. Safe to fire on their own.
const STRONG_STANDALONE_NOUNS = [
  'menu', 'menus', 'catalog', 'catalogue', 'catalogs', 'catalogues',
  'pricelist', 'price list', 'lineup', 'line up',
];

// Broader nouns that need a browsing verb/question-word alongside them,
// since alone they can also appear in genuine order requests ("i want food",
// already resolved earlier at step 4 / ORDER_DIRECT_RE before this file runs).
const AMBIGUOUS_MENU_NOUNS = [
  'food', 'foods', 'items', 'item', 'products', 'product',
  'dishes', 'dish', 'meals', 'meal', 'options', 'option',
  'stuff', 'stock', 'goods', 'selection', 'offers', 'offer',
  'prices', 'price', 'stuffs', 'things', 'range',
];

// Verbs / question-words signalling "let me look at / know about", as opposed
// to "want"/"give me"/"get me" which signal ORDER_DIRECT_RE territory.
const BROWSE_SIGNALS = [
  'show', 'see', 'view', 'browse', 'check', 'list', 'display',
  'tell', 'know', 'have', 'got', 'sell', 'offer', 'offering', 'serve',
  'carry', 'available', 'recommend', 'suggest', 'what', 'which',
  'send', 'share', 'got any', 'any', 'wetin', 'dey sell', 'de sell',
];

// Common noun-less "what should I get / what's good" style browsing asks
// that don't contain any of the nouns above at all, including this
// platform's Gambian/West-African pidgin customer base.
const IMPLICIT_MENU_RE = /\b(what'?s good|whats good|what'?s popular|whats popular|best\s?sell(?:er|ers)?|any recommendations?|recommend something|suggest something|surprise me|what'?s on offer|whats on offer|what do you (?:have|sell|offer|serve|carry)|what (?:can|could|should) (?:i|we|they) (?:eat|order|get|have)|what to (?:eat|order|get)|what do you have in (?:the |your )?menu|what(?:'s| is) (?:on|in) (?:the |your )?menu|wetin (?:una|you|unu|you all|yall) (?:get|dey sell|dey get|get for sell|get to sell|de sell)|una get wetin|wetin dey (?:for|inside|on) (?:menu|catalog|catalogue)|make (?:i|we|una) see (?:the |una )?(?:menu|catalog|catalogue|wetin (?:una|you) get)|show (?:me|us) wetin (?:una|you|unu) (?:get|dey sell))\b/;

/** Broader menu/food browse phrasing used by Q&A classification. */
export const MENU_BROWSE_RE = /\b(menu|what do you (have|serve|sell|offer)|today'?s menu|show menu|view menu|see menu|what('s| is) (on|in) (the |your )?menu|list (of )?(food|items|products|dishes|services)|price list|catalog|available (food|items|products|dishes|services)|what can i eat|what could i eat|what should i eat|what to eat|what else do you have|anything else (available|on the menu))\b/i;

/** Generic "order food" with no named item — browse the catalog, not a direct SKU order. */
const GENERIC_FOOD_ORDER_RE = /\b(i want|i d like|i'd like|want|need|like) to order (food|something|a meal|meals|takeaway|take away|take-out|takeout)\b/i;

function containsToken(text, phrases) {
  return phrases.some((p) => new RegExp('\\b' + p.replace(/\s+/g, '\\s+') + '\\b').test(text));
}

/**
 * @param {string} clean - already-normalised (lowercase, punctuation-stripped) message
 * @returns {boolean}
 */
export function isMenuBrowsingIntent(clean) {
  if (!clean) return false;

  // Tier 1 — strong standalone nouns, no verb required.
  if (containsToken(clean, STRONG_STANDALONE_NOUNS)) return true;

  // Tier 2 — ambiguous noun + browse signal, both required.
  if (containsToken(clean, AMBIGUOUS_MENU_NOUNS) && containsToken(clean, BROWSE_SIGNALS)) {
    return true;
  }

  // Tier 3 — implicit, noun-less browsing phrasing.
  if (IMPLICIT_MENU_RE.test(clean)) return true;

  return false;
}

/**
 * Whether a free-text message is asking to browse food/menu items (not a specific
 * product order, status check, or cancel request).
 */
export function isCatalogBrowseRequest(message) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  if (isBookingInfoQuestion(raw)) return false;
  const clean = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (isMenuBrowsingIntent(clean)) return true;
  if (MENU_BROWSE_RE.test(raw)) return true;
  return GENERIC_FOOD_ORDER_RE.test(raw);
}
