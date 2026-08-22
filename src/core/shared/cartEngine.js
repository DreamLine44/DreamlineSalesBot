/**
 * core/shared/cartEngine.js
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
 *   its shape) — had ZERO multi-item awareness. utils/matchEngine.js's
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
 * utils/matchEngine.js and modules/catalog/waCatalogHelpers.js):
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
 *   mergeCartLines(cart, newLines)
 *     Adds newLines to an existing cart, summing quantity when the same
 *     menuItem (+variant) already has a line, so "2 burgers" followed later
 *     by "1 more burger" becomes a single 3× line, not two separate ones.
 *
 *   cartTotal(cart) / cartToOrderItems(cart) / formatCartSummary(cart, business)
 *     Pure helpers for pricing, persistence (saveOrder({items})) and the
 *     customer-facing cart summary text — shared by every module that wires
 *     this in, so the summary format and pricing logic can't drift per
 *     vertical.
 *
 *   enforceCartLimit(cart, business)
 *     [AUDIT-FIX-MULTICART-2 Phase 2] orderService.js's own comment flagged
 *     that multiItemCart.maxItems existed in schema but was "separate, later
 *     work" to enforce at the flow layer. This is that enforcement — applied
 *     wherever a flow adds lines to a cart, so a runaway "add another item"
 *     loop (or a garbled multi-item message that over-matches) can never
 *     build an unbounded cart before saveOrder()'s own 50-item hard cap.
 *
 * [CART-AI-2] Two further additions so the bot treats the cart as one
 * editable set of items rather than an append-only list:
 *
 *   Trailing quantities — extractQuantityAndName() now also recognises
 *   "Burger x2", "Fries (3)", "Coke *2" (quantity AFTER the name), not just
 *   the original leading form ("2 burgers"). Compound number words
 *   ("twenty five", "twenty-five") are handled by parseQuantity().
 *
 *   parseCartModification(cart, text) / applyCartModification(cart, mod)
 *     Lets a customer already reviewing their cart say "remove the coke",
 *     "no fries", or "make it 3 burgers" and have that resolve against the
 *     items ALREADY in the cart (matched by name via findBestMatch, same
 *     fuzzy engine as everything else), instead of only ever being able to
 *     append more lines. Returns null for anything that doesn't read as a
 *     removal/resize, so callers fall through to their existing "treat this
 *     as more items to add" path unchanged.
 */

import { findBestMatch } from '../../utils/matchEngine.js';
import { parseQuantity } from '../../utils/parseQuantity.js';
import { itemLabel } from '../../utils/itemLabel.js';
import { formatMoney } from '../../utils/formatCurrency.js';

const norm = (s = '') =>
  s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Segment separators: commas, periods, semicolons, newlines, "+"/"&", and
// the words and/also/plus used as connectors between items ("a burger AND a
// coke"). Word-boundary so "sandwich" doesn't get split on a stray "and"
// substring. [FIX-MULTIITEM-PERIOD-SEP] Period added — customers who write
// two full sentences ("I want a plate of benachin. I want 4 plates of
// domoda.") got no split at all before this, since "." wasn't a recognised
// separator, silently defeating multi-item detection.
const SEGMENT_SPLIT_RE = /\s*(?:,|;|\.|\n|\+|&|\band\b|\balso\b|\bplus\b)\s*/i;

// [FIX-MULTIITEM-NO-PUNCTUATION] Customers who list several items with NO
// punctuation or connector word at all between clauses — "i want a plate of
// benachin i want to order 4 plates of domoda" — never hit SEGMENT_SPLIT_RE
// above either, so the whole message was treated as one unsplittable phrase
// and multi-item detection silently gave up (returned null) even though a
// repeated "I want"/"I need"/"can I get" mid-message is itself an
// unambiguous signal that a new item clause is starting. This inserts an
// explicit boundary right before each such mid-message occurrence (not the
// one at position 0, which the leading .replace() calls above already
// consume) so the normal split above can then do its job.
const IMPLICIT_ITEM_BOUNDARY_RE = /\b(?:i\s+(?:want|need|would\s+like)(?:\s+to\s+order)?|can\s+i\s+(?:get|have|order|buy|purchase)(?:\s+me)?)\b/gi;

function insertImplicitItemBoundaries(text) {
  return text.replace(IMPLICIT_ITEM_BOUNDARY_RE, (match, offset) => (offset === 0 ? match : `, ${match}`));
}

// Leading-quantity extraction: "2 burgers", "two burgers", "2x burgers",
// "2× burgers", "a burger", "twenty five burgers". Falls back to quantity 1
// when no leading quantity token is present ("burger" alone).
const LEADING_QTY_RE = /^\s*(\d+|[a-z]+(?:[\s-][a-z]+)?)\s*[x×]?\s+(.+)$/i;

// [CART-AI-TRAILING-QTY] Trailing-quantity extraction: "Burger x2",
// "Burgers x 2", "Fries (3)", "Coke *2". Some customers put the quantity
// AFTER the item name rather than before it — the leading-quantity check
// above never matches these (there's no number at the start of the
// segment), so without this the "x2"/"(3)" always defaulted to quantity 1,
// silently losing the customer's actual count.
const TRAILING_QTY_RE = /^(.+?)\s*(?:[x×]\s*(\d+)|\((\d+)\)|\*\s*(\d+))\s*$/i;

// [FIX-MULTIITEM-REPEATED-LEADIN] Customers frequently repeat a full
// "I want (to order)" / "can I get" clause on EACH item when listing several
// in one message — e.g. "I want a plate of benachin, I want to order 4
// plates of domoda" — rather than saying it only once at the very start.
// Previously this lead-in was stripped once from the whole raw message
// (below, in parseMultiItemMessage/parseNaturalOrderMessage), so a SECOND
// occurrence mid-message survived untouched into extractQuantityAndName(),
// which had no idea "I want to order 4 plates of domoda" meant qty 4 — the
// leading-quantity regex greedily consumed "I want" as a fake word-number,
// parseQuantity("I want") correctly returned null, and the whole clause fell
// through to the qty-1 default with the item name reduced to garbage. This
// shared helper strips the same lead-in phrasing per-segment too, so every
// item in a multi-item message gets its quantity read correctly regardless
// of which item it's mentioned alongside.
const LEAD_IN_RE = /^(?:(?:i\s+)?(?:want|need|would\s+like)\s+(?:to\s+order\s+)?|(?:can\s+i\s+)?(?:get|have|order|buy|purchase)\s+(?:me\s+)?)/i;

function stripLeadIn(s) {
  return String(s || '').replace(LEAD_IN_RE, '').trim();
}

// [FIX-MULTIITEM-SLASH-QTY] A customer sometimes writes the quantity as
// "four/4 plates of domoda" or "4/4 plates of domoda" — two spellings of the
// SAME number jammed together with a slash (voice-to-text artifact, or
// autocorrect offering both forms), not a fraction. Previously neither the
// plate-phrase regex nor the leading-quantity regex could match a token
// containing "/", so the whole "four/4" token was rejected outright and the
// quantity silently defaulted to 1. This collapses a leading "A/B" token to
// a single resolved number first, whenever at least one side parses as a
// real quantity, so downstream matching sees a normal "4 plates of domoda".
const LEADING_SLASH_QTY_RE = /^([a-z]+|\d+)\s*\/\s*([a-z]+|\d+)(\s+.*)$/i;

function collapseSlashQuantity(s) {
  const m = s.match(LEADING_SLASH_QTY_RE);
  if (!m) return s;
  const left = parseQuantity(m[1]);
  const right = parseQuantity(m[2]);
  const resolved = left || right; // both forms of "four/4" agree; if they
  // genuinely differ, favor the left (first-spoken) side rather than reject.
  if (!resolved) return s;
  return `${resolved}${m[3]}`;
}

export function extractQuantityAndName(segment) {
  const trimmed = collapseSlashQuantity(stripLeadIn(segment.trim()) || segment.trim());

  const plateMatch = trimmed.match(/^((?:\d+|[a-z]+(?:[\s-][a-z]+)?))\s+plates?\s+of\s+(.+)$/i);
  if (plateMatch) {
    const quantity = parseQuantity(plateMatch[1]);
    if (quantity && quantity > 0) return { quantity, name: plateMatch[2].trim() };
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

  const withoutLead = collapseSlashQuantity(raw
    .replace(/^(?:i\s+)?(?:want|need|would\s+like|like\s+to\s+order)\s+(?:to\s+order\s+)?/i, '')
    .replace(/^(?:can\s+i\s+)?(?:give|get|have|order|buy|purchase)\s+(?:me\s+)?/i, '')
    .trim());

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
  const raw = String(text || '')
    .trim()
    .replace(/^(?:i\s+)?(?:want|need|would\s+like)\s+(?:to\s+order\s+)?/i, '')
    .replace(/^(?:can\s+i\s+)?(?:get|have|order|buy|purchase)\s+(?:me\s+)?/i, '')
    .trim();
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

  const segments = insertImplicitItemBoundaries(raw)
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

/**
 * applyCartModification(cart, mod)
 * → new cart array (does not mutate input)
 */
export function applyCartModification(cart = [], mod) {
  if (!mod) return cart;
  if (mod.type === 'remove') {
    return cart.filter((_, i) => i !== mod.lineIndex);
  }
  if (mod.type === 'setQuantity') {
    return cart.map((l, i) => (i === mod.lineIndex ? { ...l, quantity: mod.quantity } : l));
  }
  return cart;
}

/**
 * enforceCartLimit(cart, business)
 * → { cart: [...capped], overflowCount }
 *
 * [AUDIT-FIX-MULTICART-2 Phase 2] Caps a cart at business.multiItemCart.maxItems
 * (default 10) BEFORE it's persisted or shown to the customer — the flow-layer
 * enforcement orderService.js's Phase-1 comment deferred to later work.
 */
export function enforceCartLimit(cart = [], business) {
  const maxItems = business?.multiItemCart?.maxItems || 10;
  if (cart.length <= maxItems) return { cart, overflowCount: 0 };
  return { cart: cart.slice(0, maxItems), overflowCount: cart.length - maxItems };
}

/**
 * mergeCartLines(cart, newLines)
 * → new cart array (does not mutate inputs)
 *
 * Same menuItem (+variant) already in the cart → quantities are summed
 * instead of creating a duplicate line, so re-adding "1 more burger" behaves
 * the way a customer expects.
 */
export function mergeCartLines(cart = [], newLines = []) {
  const result = cart.map(l => ({ ...l }));
  for (const line of newLines) {
    const id = String(line.item?._id);
    const existing = result.find(l => String(l.item?._id) === id && (l.variant || null) === (line.variant || null));
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      result.push({ ...line });
    }
  }
  return result;
}

/**
 * removeCartLine(cart, index)
 * → new cart array with the line at `index` removed (does not mutate input).
 * [MULTICART-v40-EDIT] Powers the "Remove Item" action in the cart Edit
 * Order menu — index refers to the line's position in the cart array as
 * shown to the customer (1-based numbering is converted to 0-based by the
 * caller before this is invoked). Complements [CART-AI-MODIFY]'s
 * parseCartModification/applyCartModification above: that path resolves
 * free-text ("remove the coke"), this path resolves an explicit numbered
 * pick from the structured Edit Order menu — both end up here or in
 * incrementCartLine/decrementCartLine.
 */
export function removeCartLine(cart = [], index) {
  return cart.filter((_, i) => i !== index);
}

/**
 * incrementCartLine(cart, index, by = 1)
 * → new cart array with the line's quantity increased by `by`.
 */
export function incrementCartLine(cart = [], index, by = 1) {
  return cart.map((line, i) => (i === index ? { ...line, quantity: line.quantity + by } : { ...line }));
}

/**
 * decrementCartLine(cart, index, by = 1)
 * → new cart array with the line's quantity decreased by `by`. If the
 * resulting quantity would drop to 0 or below, the line is removed entirely
 * (mirrors normal e-commerce cart behaviour — decrementing a 1-quantity line
 * to 0 removes it rather than leaving a dangling 0× line).
 */
export function decrementCartLine(cart = [], index, by = 1) {
  const line = cart[index];
  if (!line) return cart.map(l => ({ ...l }));
  const newQty = line.quantity - by;
  if (newQty <= 0) return removeCartLine(cart, index);
  return cart.map((l, i) => (i === index ? { ...l, quantity: newQty } : { ...l }));
}

/**
 * clearCart()
 * → [] — trivial helper kept here so every caller clears a cart the same
 * (obvious) way and so the intent reads clearly at call sites (data.cart =
 * clearCart() vs. a bare []).
 */
export function clearCart() {
  return [];
}

/**
 * cartItemCount(cart)
 * → total quantity across all lines (the "Items: N" line in the summary).
 */
export function cartItemCount(cart = []) {
  return cart.reduce((sum, l) => sum + (l.quantity || 0), 0);
}

/**
 * cartTotal(cart)
 * → number | null (null when any line is missing a price — never a silently
 *   partial sum, same "don't lie about the total" principle as
 *   orderService.js's resolveOrderFields()).
 */
export function cartTotal(cart = []) {
  if (!cart.length) return null;
  const allPriced = cart.every(l => typeof l.item?.price === 'number');
  if (!allPriced) return null;
  return cart.reduce((sum, l) => sum + l.item.price * l.quantity, 0);
}

/**
 * cartToOrderItems(cart)
 * → [{ item, quantity, addOns, unitPrice, menuItemId }, ...]
 * Exact shape services/orderService.js's saveOrder({ items }) expects —
 * mirrors modules/catalog/waCatalogHelpers.js's buildCatalogCartItems() so
 * a text-typed multi-item order and a WA-Catalog multi-item order both
 * persist identically.
 */
export function cartToOrderItems(cart = []) {
  return cart.map(line => ({
    item:       itemLabel(line.item, line.variant),
    quantity:   line.quantity,
    addOns:     line.addOns || [],
    unitPrice:  typeof line.item?.price === 'number' ? line.item.price : null,
    menuItemId: line.item?._id,
  }));
}

/**
 * formatCartSummary(cart, business)
 * → multi-line string, e.g. "2× Jollof Rice — D400\n1× Coke — D50"
 */
export function formatCartSummary(cart = [], business) {
  const currency = business?.payment?.currency || 'D';
  return cart.map(line => {
    const name = itemLabel(line.item, line.variant);
    const lineTotal = typeof line.item?.price === 'number' ? line.item.price * line.quantity : null;
    return `${line.quantity}× ${name}${lineTotal != null ? ` — ${currency}${formatMoney(lineTotal)}` : ''}`;
  }).join('\n');
}

/**
 * formatNumberedCartSummary(cart, business)
 * → multi-line string with a 1-based index per line, e.g.
 *   "1. 2× Jollof Rice — D400\n2. 1× Coke — D50"
 * [MULTICART-v40-EDIT] Used by the Edit Order item-picker (Remove/Increase/
 * Decrease) so the customer can reply with a plain number to pick a line.
 */
export function formatNumberedCartSummary(cart = [], business) {
  const currency = business?.payment?.currency || 'D';
  return cart.map((line, i) => {
    const name = itemLabel(line.item, line.variant);
    const lineTotal = typeof line.item?.price === 'number' ? line.item.price * line.quantity : null;
    return `${i + 1}. ${line.quantity}× ${name}${lineTotal != null ? ` — ${currency}${formatMoney(lineTotal)}` : ''}`;
  }).join('\n');
}

/**
 * buildUnmatchedNote(unmatchedSegments)
 * → '' | customer-facing note about fragments of their message that
 *   couldn't be matched to any menu item, so nothing is silently dropped
 *   without at least telling the customer.
 */
export function buildUnmatchedNote(unmatchedSegments = []) {
  if (!unmatchedSegments.length) return '';
  const list = unmatchedSegments.map(s => `"${s.slice(0, 30)}"`).join(', ');
  return `\n\n_(I couldn't match ${unmatchedSegments.length > 1 ? 'these to any items' : 'this to an item'}: ${list} — you can add ${unmatchedSegments.length > 1 ? 'them' : 'it'} separately if needed.)_`;
}
