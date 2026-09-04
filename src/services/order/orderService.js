/**
 * services/orderService.js
 *
 * [FIX-BUG5] Now calls recordOrderItem() after every successful save so that
 *            customer memory / personalisation / repeat-order features actually work.
 *            Previously customerMemory was defined but never invoked from here.
 */
import Order  from '../../models/Order.js';
import { recordOrderItem } from '../../core/memory/customerMemory.js';
import logger from '../../config/logger.js';
import { formatMoney } from '../../utils/formatCurrency.js';

// [MULTICART-v39] Phase 1 — pure normalization function, no DB/session
// dependency. Given either legacy scalar order fields (item/quantity/
// totalPrice/addOns) OR a multi-item cart (items: [{item, quantity,
// unitPrice, addOns}, ...]), returns one consistent shape:
//   { hasCart, resolvedItem, resolvedQuantity, resolvedTotal, resolvedAddOns }
//
// Backward compat: a call with no items[] (or an empty items[]) returns
// exactly what was passed in — zero behavior change for the verticals that
// don't use carts yet.
//
// New path: a non-empty items[] mirrors item/quantity/addOns from items[0]
// (so dashboard/analytics/getLastOrderItem readers never have to change),
// and sums totalPrice from unitPrice*quantity across all items — UNLESS an
// explicit totalPrice was given (always wins, e.g. a discount applied
// upstream), or [AUDIT-FIX-MULTICART-1] any single item is missing a
// unitPrice, in which case the total is null rather than a silently partial
// sum (previously this could add up just the priced items and hand that
// back as if it were the whole order's total).
//
// [AUDIT-FIX-MULTICART-2] items[] gets a 50-item hard cap here as a last
// line of defense against an unbounded array (a stuck "add another item?"
// loop, or a caller bug) — the multiItemCart.maxItems config field exists
// but enforcing it at the flow layer is separate, later work.
//
// Wiring this into saveOrder() (and persisting items[] on the Order
// document) is intentionally NOT done in this pass — that needs an Order
// schema addition, which is out of scope for Phase 1.
export const resolveOrderFields = ({ item, quantity, totalPrice, addOns, items } = {}) => {
  const hasCart = Array.isArray(items) && items.length > 0;

  if (!hasCart) {
    return {
      hasCart: false,
      resolvedItem: item,
      resolvedQuantity: quantity,
      resolvedTotal: totalPrice === undefined ? null : totalPrice,
      resolvedAddOns: addOns || [],
    };
  }

  if (items.length > 50) {
    throw new Error(`Cart is exceeding the hard cap of 50 items (got ${items.length})`);
  }

  const first = items[0];

  let resolvedTotal;
  if (totalPrice !== undefined) {
    resolvedTotal = totalPrice;
  } else {
    const allPriced = items.every(i => typeof i.unitPrice === 'number');
    // [AUDIT-FIX-UPSELL-PRICE-1] Add each line's addOnsTotal (flat, not
    // multiplied by quantity — see models/Order.js) on top of unitPrice*quantity,
    // or accepted paid upsells never reach the persisted order total.
    resolvedTotal = allPriced
      ? items.reduce((sum, i) => sum + i.unitPrice * (i.quantity ?? 1) + (i.addOnsTotal || 0), 0)
      : null;
  }

  return {
    hasCart: true,
    resolvedItem: first.item,
    resolvedQuantity: first.quantity,
    resolvedTotal,
    resolvedAddOns: first.addOns || [],
  };
}

// [FIX-SAVE-1] Added `notes` and `customerName` to destructure — previously both were
// silently dropped because they weren't listed, even though notes IS in the Order schema
// and all module callers pass it. customerName is also now in the Order schema.
//
// [FIX-CATALOG-CART-2] Added `items` to destructure and wired resolveOrderFields()
// through it. waCatalogFlow.js's handleMultiItemCatalogOrder() already called
// saveOrder({ items: cartItems, ... }) but `items` wasn't in this destructure at
// all — every multi-item catalog order silently saved with item/quantity/totalPrice
// all undefined. Single-item callers (the vast majority) pass no `items`, so
// resolveOrderFields()'s hasCart:false branch returns their scalar fields
// completely unchanged — zero behavior change for every existing caller.
export async function saveOrder({ item, quantity, totalPrice, addOns, items, notes, customerName, customerPhone, tenantId, businessId, status, idempotencyKey }) {
  const resolved = resolveOrderFields({ item, quantity, totalPrice, addOns, items });

  let order;
  try {
    order = await Order.create({
      item:          resolved.resolvedItem,
      quantity:      resolved.resolvedQuantity,
      totalPrice:    resolved.resolvedTotal,
      addOns:        resolved.resolvedAddOns,
      items:         resolved.hasCart ? items : [],
      notes:         notes         || null,
      customerName:  customerName  || null,
      customerPhone, tenantId, businessId,
      status:        status || 'pending',
      paymentStatus: 'unpaid',
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (err) {
    // A rapid double-tap can race two creates. The unique idempotency index
    // makes the second create safe; return the already-created order instead
    // of showing the customer a generic checkout failure.
    if (err?.code === 11000 && idempotencyKey) {
      order = await Order.findOne({ tenantId, customerPhone, idempotencyKey });
      if (!order) throw err;
    } else {
      throw err;
    }
  }

  // [FIX-BUG5] Update customer memory — fire-and-forget, never blocks order completion
  // [FIX-MEM-DOUBLECOUNT] countOrder:false — this fires on EVERY saveOrder() call,
  // including orders that are later rejected/cancelled/abandoned. stats.totalOrders
  // must only reflect confirmed orders, which recordConfirmedOrder() (called from
  // adminCommandService.confirmPayment on actual admin approval) already handles.
  // Without this flag, every approved order was counted twice — once here at save
  // time, once again at confirmation — corrupting VIP-threshold detection and the
  // "welcome back" returning-customer greeting logic in moduleRouter.js.
  recordOrderItem(customerPhone, String(tenantId), resolved.resolvedItem, { countOrder: false }).catch(err =>
    logger.debug('[OrderService] recordOrderItem failed (non-fatal)', { err: err.message })
  );

  return order;
}

/**
 * True when admin confirmation should say "Order Confirmed", not "Payment Confirmed".
 * Must NOT rely on session.step alone — AWAIT_ADMIN_CONFIRM expires with the session TTL
 * (~30 min), but cash / no-payment businesses still need order wording after that.
 */
export const isNoPaymentOrder = (business, order, session = null) => {
  if (!business?.payment?.enabled) return true;
  if (session?.step === 'AWAIT_ADMIN_CONFIRM') return true;
  if (order?.paymentStatus === 'unpaid' && !order?.paymentProof) return true;
  return false;
}

/**
 * WhatsApp-friendly order lines for admin/customer notifications.
 * Uses order.items[] when present (multi-item cart); falls back to item/quantity.
 */
export const formatOrderItemsForMessage = (order, business) => {
  const currency = business?.payment?.currency || 'GMD';
  const cartLines = Array.isArray(order?.items) && order.items.length > 0 ? order.items : null;

  if (!cartLines) {
    return `📦  Order: *${order.item}* × ${order.quantity}`;
  }

  if (cartLines.length === 1) {
    return `📦  Order: *${cartLines[0].item}* × ${cartLines[0].quantity}`;
  }

  return cartLines.map((i) => {
    const qty = i.quantity ?? 1;
    // [AUDIT-FIX-UPSELL-PRICE-1] See resolveOrderFields() above.
    const lineTotal = typeof i.unitPrice === 'number' ? i.unitPrice * qty + (i.addOnsTotal || 0) : null;
    const pricePart = lineTotal != null ? ` — ${currency}${formatMoney(lineTotal)}` : '';
    return `📦  ${qty}× ${i.item}${pricePart}`;
  }).join('\n');
}

/** Compact inline summary e.g. "*Attaya* × 1, *Akara* × 1" for status cards. */
export const formatOrderItemSummary = (order) => {
  const cartLines = Array.isArray(order?.items) && order.items.length > 1 ? order.items : null;
  if (!cartLines) {
    return `*${order.item}* × ${order.quantity}`;
  }
  return cartLines.map((i) => `*${i.item}* × ${i.quantity ?? 1}`).join(', ');
}

export async function getRecentOrders(customerPhone, tenantId, limit = 5) {
  return Order.find({ customerPhone, tenantId }).sort({ createdAt: -1 }).limit(limit).lean();
}

export async function getLastOrderItem(customerPhone, tenantId) {
  const order = await Order.findOne({ customerPhone, tenantId }).sort({ createdAt: -1 }).lean();
  return order?.item || null;
}
