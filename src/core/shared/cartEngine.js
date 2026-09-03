/**
 * core/shared/cartEngine.js
 *
 * [NLU-CONSOLIDATION] This file used to also hold this module's free-text
 * PARSING functions (extractQuantityAndName, parseNaturalOrderMessage,
 * parseMultiItemMessage, parseCartModification). Those moved to
 * core/nlu/resolution/cartMessageParser.js — that's genuinely NLU/resolution
 * logic (fuzzy-matching customer text against menu/cart data), whereas
 * everything left here is pure cart-array state manipulation with no text
 * parsing or fuzzy matching involved. Physical split only; no function body
 * changed. See cartMessageParser.js's header for the original multi-item
 * cart background/rationale.
 *
 * WHAT THIS FILE HAS:
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
 *   applyCartModification(cart, mod)
 *     Applies a { type: 'remove' | 'setQuantity', ... } instruction (as
 *     produced by cartMessageParser.js's parseCartModification()) onto a
 *     cart array. Pure state transition — the free-text resolution that
 *     produces `mod` in the first place lives in cartMessageParser.js.
 */

import { itemLabel, formatMoney } from '../../utils/formatFeature.js';

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
      // [AUDIT-FIX-UPSELL-PRICE-1] Previously only `quantity` was merged here —
      // if the same item/variant was added again with a newly-accepted add-on,
      // that add-on (and its price) was silently dropped because `existing`
      // (the first-added line) was kept as-is. Fold both in instead.
      if (Array.isArray(line.addOns) && line.addOns.length) {
        existing.addOns = [...new Set([...(existing.addOns || []), ...line.addOns])];
      }
      if (typeof line.addOnsTotal === 'number' && line.addOnsTotal) {
        existing.addOnsTotal = (existing.addOnsTotal || 0) + line.addOnsTotal;
      }
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
    item:        itemLabel(line.item, line.variant),
    quantity:    line.quantity,
    addOns:      line.addOns || [],
    // [AUDIT-FIX-UPSELL-PRICE-1] Flat accepted-add-on price for this line —
    // see models/Order.js's addOnsTotal comment. Must be added on top of
    // unitPrice*quantity wherever a total is computed (orderService.
    // resolveOrderFields, formatCartSummary/formatNumberedCartSummary below).
    addOnsTotal: typeof line.addOnsTotal === 'number' ? line.addOnsTotal : 0,
    unitPrice:   typeof line.item?.price === 'number' ? line.item.price : null,
    menuItemId:  line.item?._id,
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
    // [AUDIT-FIX-UPSELL-PRICE-1] Fold in any accepted add-on's flat price so the
    // customer-facing cart summary matches what's actually charged/saved.
    const lineTotal = typeof line.item?.price === 'number'
      ? line.item.price * line.quantity + (line.addOnsTotal || 0)
      : null;
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
    // [AUDIT-FIX-UPSELL-PRICE-1] See formatCartSummary() above.
    const lineTotal = typeof line.item?.price === 'number'
      ? line.item.price * line.quantity + (line.addOnsTotal || 0)
      : null;
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
