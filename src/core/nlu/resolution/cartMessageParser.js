/**
 * core/nlu/resolution/cartMessageParser.js
 *
 * [NLU-CONSOLIDATION] Split out of core/shared/cartEngine.js — this file
 * holds that module's pure TEXT-PARSING functions (free text + live menu/cart
 * data in, structured cart lines out), which are natural-language resolution
 * logic in the same sense as bookingDateParser.js/matchEngine.js elsewhere in
 * this resolution/ folder. cartEngine.js itself keeps only cart STATE
 * manipulation (merge/remove/increment/total/format) — pure array logic with
 * no text parsing or fuzzy matching involved. This is a physical move only;
 * no function body changed.
 *
 * [MULTICART-v39-PHASE2] Flow-layer multi-item cart support.
 *
 * BACKGROUND — the gap this closes:
 *   Phase 1 (services/orderService.js resolveOrderFields/saveOrder) already
 *   accepts an `items[]` cart array and normalizes/sums it correctly — see
 *   that file's [MULTICART-v39] / [FIX-CATALOG-CART-2] notes and
 *   tests/multiItemCartOrderService.test.mjs. modules/catalog/waCatalogFlow.js
 *   already builds real multi-item Orders from a native WhatsApp Catalog cart
 *   (when business.multiItemCart.enabled).
 *
 *   But the ORDINARY typed/tapped ORDER flow — the one every text message
 *   goes through (restaurant/flows/orderFlow.js and every module that copies
 *   its shape) — had ZERO multi-item awareness. core/nlu/resolution/matchEngine.js's
 *   findBestMatch() matches ONE query string against ONE item, so a message
 *   like "2 jollof rice and a coke, plus 3 fries" was fuzzy-matched as a
 *   SINGLE garbled query against the whole menu — almost always a wrong
 *   match, a LOW-confidence "did you mean?" for something unrelated, or a
 *   flat "couldn't find that" miss. There was also no way to add a SECOND,
 *   DIFFERENT item to an order already in progress — CONFIRM saved exactly
 *   one item and ended the flow; ordering two different dishes required two
 *   entirely separate, sequential orders.
 *
 *   This is the actual "AI misunderstanding" — the customer said something
 *   completely reasonable and the bot could not parse it.
 *
 * WHAT THIS FILE ADDS (pure functions only — no mongoose, no session/network
 * calls, so it's independently unit-testable, same isolation rationale as
 * core/nlu/resolution/matchEngine.js and modules/catalog/waCatalogHelpers.js):
 *
 *   parseMultiItemMessage(menu, text)
 *     Splits a free-text message on item separators (",", "and", "plus",
 *     "&", "+", "also", newlines/semicolons), extracts a leading quantity
 *     per segment (digit, word-number, or "2x"/"2×" shorthand — defaulting
 *     to 1), and fuzzy-matches the remainder against the menu via
 *     findBestMatch(). Returns null when the message doesn't actually look
 *     like a multi-item request (fewer than 2 segments resolve to DIFFERENT
 *     menu items) — callers fall back to their existing single-item path
 *     untouched. This is what makes the integration purely additive: a
 *     normal single-item message ("jollof rice", "2 burgers") never enters
 *     this code path at all.
 *
 * [CART-AI-2] Two further additions so the bot treats the cart as one
 * editable set of items rather than an append-only list:
 *
 *   Trailing quantities — extractQuantityAndName() now also recognises
 *   "Burger x2", "Fries (3)", "Coke *2" (quantity AFTER the name), not just
 *   the original leading form ("2 burgers"). Compound number words
 *   ("twenty five", "twenty-five") are handled by parseQuantity().
 *
 *   parseCartModification(cart, text)
 *     Lets a customer already reviewing their cart say "remove the coke",
 *     "no fries", or "make it 3 burgers" and have that resolve against the
 *     items ALREADY in the cart (matched by name via findBestMatch, same
 *     fuzzy engine as everything else), instead of only ever being able to
 *     append more lines. Returns null for anything that doesn't read as a
 *     removal/resize, so callers fall through to their existing "treat this
 *     as more items to add" path unchanged. Applying the result back onto a
 *     cart array is applyCartModification() in cartEngine.js — that half is
 *     pure state manipulation, not parsing, so it stayed there.
 */

import { findBestMatch } from './matchEngine.js';
import { parseQuantity } from './parseQuantity.js';
import { itemLabel } from '../../../utils/itemLabel.js';

const norm = (s = '') =>
  s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// [AUDIT-FIX-GREETING-LEADIN] Both parseNaturalOrderMessage() and
// parseMultiItemMessage() used to strip order-intent filler ("I want",
// "can I get") but NOT a leading greeting ("hi", "hello", "good morning").
// Greeting-stripping existed only as copy-pasted regexes at some CALL SITES
// (moduleRegistry.js, restaurant/flows/orderFlow.js, webhookController.js)
// but was never applied inside these shared parsing functions themselves —
// so any call site that forgot the local copy (or passed the raw message,
// as restaurant/flows/orderFlow.js's SELECT_ITEM step does at its
// parseMultiItemMessage/parseNaturalOrderMessage call) fed a message like
// "hi I want to order two plates of Domoda and a plate of denachin"
// through untouched. Concretely, that broke extractQuantityAndName()'s
// leading-quantity regex, which requires the quantity token to sit right at
// the start of the (sub)string: "hi I want to order two" doesn't match
// "^(\d+|word)\s+plates?\s+of", so quantity silently fell back to the
// default of 1 — the item still fuzzy-matched (findBestMatch's substring
// rule finds "Domoda" buried in the garbled leftover), but the customer's
// actual "two" was dropped without any error or notice. Reproduced in
// src/tests/cartMessageParser.test.mjs.
//
// Fix: strip greeting + order-intent lead-in ONCE, in the shared parsing
// layer, so every caller gets correct quantity extraction regardless of
// whether it also does its own (now redundant, harmless) local stripping.
// Looped so stacked lead-ins ("hi, please can I get...") fully resolve.
const GREETING_LEADIN_RE =
  /^(?:hi|hello|hey|hiya|howdy|yo|good\s*(?:morning|afternoon|evening|night)|greetings|salaam|salam)\b(?:\s+there\b)?[,\s]*/i;
// Unifies the two previously-divergent intent-phrase regexes (one file had
// "like to order" but not "give"/"please", the other had "give" but not
// "like to order") into one list shared by both parsing functions below.
// Prefix covers bare "I " as well as the "I'd"/"I'd" contraction (dropped
// "would"), so "I'd like two Domoda" strips down to "two Domoda" the same
// way "I would like two Domoda" already did — previously only the
// uncontracted form was recognised.
const INTENT_LEADIN_RE_1 =
  /^(?:i(?:'d|’d)?\s+)?(?:want|need|would\s+like|like\s+to\s+order|like)\s+(?:to\s+order\s+)?/i;
const INTENT_LEADIN_RE_2 =
  /^(?:please\s+)?(?:can\s+i\s+|could\s+i\s+)?(?:give|get|have|order|buy|purchase)\s+(?:me\s+)?/i;
const TRAILING_POLITENESS_RE = /[\s,]*(?:please|thanks?|thank\s*you)[\s.!]*$/i;

/**
 * stripOrderLeadIn(text)
 * Removes a leading greeting and/or order-intent filler phrase, and trailing
 * politeness, so the remainder starts directly at the quantity/item content
 * ("hi I want to order two plates of X" → "two plates of X"). Loops because
 * a greeting and an intent phrase (or several stacked politeness words) can
 * appear together in either order, and each individual regex only strips
 * one occurrence per pass.
 */
export function stripOrderLeadIn(text = '') {
  let s = String(text || '').trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(GREETING_LEADIN_RE, '').replace(INTENT_LEADIN_RE_1, '').replace(INTENT_LEADIN_RE_2, '').trim();
    if (s === before) break;
  }
  return s.replace(TRAILING_POLITENESS_RE, '').trim();
}

// Segment separators: commas, semicolons, newlines, "+"/"&", and the words
// and/also/plus used as connectors between items ("a burger AND a coke").
// Word-boundary so "sandwich" doesn't get split on a stray "and" substring.
const SEGMENT_SPLIT_RE = /\s*(?:,|;|\n|\+|&|\band\b|\balso\b|\bplus\b)\s*/i;

// Leading-quantity extraction: "2 burgers", "two burgers", "2x burgers",
// "2× burgers", "a burger", "twenty five burgers". Falls back to quantity 1
// when no leading quantity token is present ("burger" alone).
const LEADING_QTY_RE = /^\s*(\d+|[a-z]+(?:[\s-][a-z]+)?)\s*[x×]?\s+(.+)$/i;

// [AUDIT-FIX-QTY-PHRASE] Word-based quantity phrases that carry an article
// and/or a partitive "of" — "a dozen donuts", "a couple of burgers", "a few
// samosas", "half a dozen eggs", "several plates" (without "plates of",
// e.g. "several burgers"). parseQuantity()'s own WORD_MAP already assigns
// the correct value to "dozen"/"half dozen"/"couple"/"few"/"several", but
// the generic LEADING_QTY_RE below hands the WHOLE unstripped phrase ("a
// dozen") to parseQuantity(), which doesn't recognise it as a single key and
// returns null — extractQuantityAndName then retried with just the leading
// article ("a"), silently resolving to quantity 1 and leaving "dozen" stuck
// on the front of the item name ("dozen donuts"). Worse, when there was no
// article at all ("couple of burgers"), the same retry left the partitive
// "of" stuck on the front of the name ("of burgers"), breaking the menu
// match entirely. This is checked before LEADING_QTY_RE so these specific
// phrasings are resolved correctly instead of falling into that retry path.
const QTY_PHRASE_RE = /^(?:a\s+|an\s+)?(half\s+(?:a\s+)?dozen|dozen|couple|few|several)\s+(?:of\s+)?(.+)$/i;

// [CART-AI-TRAILING-QTY] Trailing-quantity extraction: "Burger x2",
// "Burgers x 2", "Fries (3)", "Coke *2". Some customers put the quantity
// AFTER the item name rather than before it — the leading-quantity check
// above never matches these (there's no number at the start of the
// segment), so without this the "x2"/"(3)" always defaulted to quantity 1,
// silently losing the customer's actual count.
const TRAILING_QTY_RE = /^(.+?)\s*(?:[x×]\s*(\d+)|\((\d+)\)|\*\s*(\d+))\s*$/i;

export function extractQuantityAndName(segment) {
  const trimmed = segment.trim();

  const plateMatch = trimmed.match(/^((?:\d+|[a-z]+(?:[\s-][a-z]+)?))\s+plates?\s+of\s+(.+)$/i);
  if (plateMatch) {
    const quantity = parseQuantity(plateMatch[1]);
    if (quantity && quantity > 0) return { quantity, name: plateMatch[2].trim() };
  }

  // [AUDIT-FIX-QTY-PHRASE] Checked before the generic leading-quantity regex
  // — see the constant's comment above.
  const qtyPhraseMatch = trimmed.match(QTY_PHRASE_RE);
  if (qtyPhraseMatch) {
    const normalizedPhrase = qtyPhraseMatch[1]
      .toLowerCase()
      .replace(/half\s+a\s+dozen/, 'half dozen')
      .replace(/\s+/g, ' ')
      .trim();
    const qty = parseQuantity(normalizedPhrase);
    if (qty && qty > 0) {
      return { quantity: qty, name: qtyPhraseMatch[2].trim() };
    }
  }

  const leadingMatch = trimmed.match(LEADING_QTY_RE);
  if (leadingMatch) {
    const qty = parseQuantity(leadingMatch[1]);
    if (qty && qty > 0) {
      return { quantity: qty, name: leadingMatch[2].trim() };
    }

    // Retry with one token when the greedy word-number pattern captured an
    // item word too, as in "two Jollof Rice".
    const firstToken = trimmed.match(/^([a-z]+|\d+)\s+(.+)$/i);
    const firstQuantity = firstToken ? parseQuantity(firstToken[1]) : null;
    if (firstQuantity && firstQuantity > 0) {
      return { quantity: firstQuantity, name: firstToken[2].trim() };
    }
  }

  // Only tried when leading didn't resolve — leading always wins if present.
  const trailingMatch = trimmed.match(TRAILING_QTY_RE);
  if (trailingMatch) {
    const qtyStr = trailingMatch[2] || trailingMatch[3] || trailingMatch[4];
    const qty = parseQuantity(qtyStr);
    if (qty && qty > 0 && trailingMatch[1].trim().length >= 2) {
      return { quantity: qty, name: trailingMatch[1].trim() };
    }
  }

  return { quantity: 1, name: trimmed };
}

/** Resolve a complete order sentence into one cart line using live menu data. */
export function parseNaturalOrderMessage(menu = [], text = '') {
  const raw = String(text || '').trim();
  if (!raw || !Array.isArray(menu) || !menu.length) return null;

  const withoutLead = stripOrderLeadIn(raw);

  const plateMatch = withoutLead.match(/^((?:\d+|[a-z]+(?:[\s-][a-z]+)?))\s+plates?\s+of\s+(.+)$/i);
  const { quantity, name } = plateMatch
    ? { quantity: parseQuantity(plateMatch[1]) || 1, name: plateMatch[2].trim() }
    : extractQuantityAndName(withoutLead);
  const variantCandidates = [];
  for (const item of menu) {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    for (const variant of variants) {
      const variantName = typeof variant === 'string' ? variant : variant?.name;
      if (!variantName) continue;
      variantCandidates.push({ item, variant: variantName, name: `${variantName} ${item.name}` });
    }
  }

  const queryNorm = norm(name);
  const explicitVariant = variantCandidates.find(candidate => {
    const variantNorm = norm(candidate.variant);
    const escapedVariant = variantNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return variantNorm && new RegExp(`\\b${escapedVariant}\\b`, 'i').test(queryNorm);
  });
  const candidateItems = menu.filter(item => {
    const itemNorm = norm(item.name);
    const keywordMatch = (item.keywords || []).some(keyword => {
      const keywordNorm = norm(keyword);
      return keywordNorm && (keywordNorm.includes(queryNorm) || queryNorm.includes(keywordNorm));
    });
    return itemNorm.includes(queryNorm) || queryNorm.includes(itemNorm) || keywordMatch;
  });
  const exactItem = menu.find(item => norm(item.name) === queryNorm);
  if (exactItem && Array.isArray(exactItem.variants) && exactItem.variants.length && !explicitVariant) {
    return {
      ambiguous: true,
      candidates: exactItem.variants.slice(0, 5).map(variant => {
        const variantName = typeof variant === 'string' ? variant : variant?.name;
        return { ...exactItem, name: `${exactItem.name} (${variantName})`, variant: variantName };
      }),
      quantity,
      unmatchedSegments: [],
    };
  }
  if (!exactItem && candidateItems.length > 1 && !variantCandidates.some(candidate => norm(candidate.name) === queryNorm)) {
    return {
      ambiguous: true,
      candidates: candidateItems.slice(0, 5),
      quantity,
      unmatchedSegments: [],
    };
  }

  const variantMatch = explicitVariant || (variantCandidates.length ? findBestMatch(variantCandidates, name) : null);
  const keywordMatch = candidateItems.find(item => (item.keywords || []).some(keyword => {
    const keywordNorm = norm(keyword);
    return keywordNorm && (keywordNorm === queryNorm || queryNorm.includes(keywordNorm));
  }));
  const baseMatch = keywordMatch
    ? { item: keywordMatch, confidenceLevel: 'HIGH' }
    : findBestMatch(menu, name);
  const matchedVariant = explicitVariant?.item
    ? explicitVariant
    : (variantMatch?.confidenceLevel === 'HIGH' ? variantMatch.item : null);
  const item = matchedVariant?.item || baseMatch.item;
  const confidenceLevel = explicitVariant
    ? 'HIGH'
    : (matchedVariant ? variantMatch.confidenceLevel : baseMatch.confidenceLevel);
  if (!item || confidenceLevel !== 'HIGH') return null;
  return {
    lines: [{ item, quantity, variant: matchedVariant?.variant || null }],
    unmatchedSegments: [],
  };
}

/**
 * parseMultiItemMessage(menu, text)
 * → { lines: [{ item, quantity, variant: null }], unmatchedSegments: string[] } | null
 *
 * Returns null when the message doesn't resolve to 2+ DISTINCT menu items —
 * that's the signal for callers to fall back to their existing single-item
 * findBestMatch() flow, completely unchanged.
 */
export function parseMultiItemMessage(menu = [], text = '') {
  const raw = stripOrderLeadIn(text);
  if (!raw) return null;

  // Guard: some menu items legitimately have a separator word IN their own
  // name ("Mac and Cheese", "Fish & Chips", "Rice, Beans and Stew"). If the
  // WHOLE message already reads as one confident single-item match AND the
  // item name accounts for most of the message's length, trust that over
  // any segment-split guess — otherwise "mac and cheese" would be wrongly
  // split into a "mac" line + a "cheese" line. The length-ratio check is
  // what keeps this from also swallowing genuine multi-item messages: a
  // short item name like "Burger" is a HIGH-confidence *substring* match
  // inside "burger and fries" too (findBestMatch's substring rule), but it
  // only accounts for a third of that message's length, so it must NOT
  // block the multi-item split there.
  const wholeMatch = findBestMatch(menu, raw);
  if (wholeMatch.confidenceLevel === 'HIGH') {
    const nameLen = norm(wholeMatch.item.name).length;
    const rawLen  = norm(raw).length;
    const ratio   = Math.max(nameLen, rawLen) / Math.max(Math.min(nameLen, rawLen), 1);
    if (ratio <= 1.5) return null;
  }

  const segments = raw
    .split(SEGMENT_SPLIT_RE)
    .map(s => s.trim())
    .filter(Boolean);

  if (segments.length < 2) return null; // single phrase — not a multi-item message

  const lines = [];
  const unmatchedSegments = [];
  const seenIds = new Set();

  for (const segment of segments) {
    const { quantity, name } = extractQuantityAndName(segment);
    if (norm(name).length < 2) continue; // too short to be a real item name fragment

    const { item, confidenceLevel } = findBestMatch(menu, name);
    if (!item || confidenceLevel === 'NONE') {
      unmatchedSegments.push(segment);
      continue;
    }

    const id = String(item._id);
    if (seenIds.has(id)) {
      // Same item mentioned twice in one message ("2 burgers ... 1 burger") — merge.
      const existing = lines.find(l => String(l.item._id) === id);
      if (existing) existing.quantity += quantity;
      continue;
    }
    seenIds.add(id);
    lines.push({ item, quantity, variant: null, confidenceLevel });
  }

  // Require at least 2 DISTINCT resolved items — otherwise this reads better
  // as a single-item message with some incidental filler word ("burger and
  // fries please" where "please" failed to match anything is fine to treat
  // as multi only if a real second item resolved; if not, don't force it).
  if (lines.length < 2) return null;

  return { lines, unmatchedSegments };
}

// [CART-AI-MODIFY] Phrasing customers use to remove or resize a line already
// in the cart while reviewing it — "remove the coke", "no fries please",
// "take out 1 burger", "make it 3 burgers", "change fries to 2". Captured as
// two prefix families (remove vs. resize) plus, for resize, a leading target
// quantity to apply to whichever cart line the remaining text best matches.
const REMOVE_PREFIX_RE = /^(?:remove|delete|cancel|drop|take out|no more|actually no|no)\s+(?:the\s+|my\s+|a\s+|an\s+)?(.+)$/i;
// "change fries to 2", "set the coke to 5", "update burgers to 3" — item name, THEN quantity.
const RESIZE_PREFIX_RE = /^(?:change|update|set)\s+(?:the\s+|my\s+)?(.+?)\s+to\s+(\d+|[a-z]+)$/i;
// "make it 3 fries", "make it three cokes" — quantity, THEN item name.
const MAKE_IT_QTY_FIRST_RE = /^make it\s+(\d+|[a-z]+)\s+(.+)$/i;
const RESIZE_LEADING_RE = /^(\d+|[a-z]+)\s+(?:not|instead of)\s+\d+\s+(.+)$/i; // "3 not 1 burgers"

/**
 * parseCartModification(cart, text)
 * → { type: 'remove', lineIndex } | { type: 'setQuantity', lineIndex, quantity } | null
 *
 * Pure — matches free text against the item NAMES already sitting in the
 * cart (not the full menu), since a modification only ever makes sense
 * against something the customer already added. Returns null when the text
 * doesn't read as a removal/resize request at all, so callers (CART_REVIEW
 * steps) can fall through to their normal "treat this as more items to add"
 * path unchanged — this is purely additive, same pattern as
 * parseMultiItemMessage.
 */
export function parseCartModification(cart = [], text = '') {
  const raw = String(text || '').trim();
  if (!raw || !cart.length) return null;

  const findLine = (fragment) => {
    const names = cart.map(l => ({ name: itemLabel(l.item, l.variant) }));
    const { item, confidenceLevel } = findBestMatch(names.map((n, i) => ({ _id: i, name: n.name })), fragment);
    if (!item || confidenceLevel === 'NONE') return -1;
    return item._id;
  };

  const removeMatch = raw.match(REMOVE_PREFIX_RE);
  if (removeMatch) {
    const idx = findLine(removeMatch[1].trim());
    if (idx >= 0) return { type: 'remove', lineIndex: idx };
  }

  const resizeMatch = raw.match(RESIZE_PREFIX_RE);
  if (resizeMatch) {
    const idx = findLine(resizeMatch[1].trim());
    const qty = parseQuantity(resizeMatch[2]);
    if (idx >= 0 && qty && qty > 0) return { type: 'setQuantity', lineIndex: idx, quantity: qty };
  }

  const makeItMatch = raw.match(MAKE_IT_QTY_FIRST_RE);
  if (makeItMatch) {
    const idx = findLine(makeItMatch[2].trim());
    const qty = parseQuantity(makeItMatch[1]);
    if (idx >= 0 && qty && qty > 0) return { type: 'setQuantity', lineIndex: idx, quantity: qty };
  }

  const resizeLeading = raw.match(RESIZE_LEADING_RE);
  if (resizeLeading) {
    const idx = findLine(resizeLeading[2].trim());
    const qty = parseQuantity(resizeLeading[1]);
    if (idx >= 0 && qty && qty > 0) return { type: 'setQuantity', lineIndex: idx, quantity: qty };
  }

  return null;
}
