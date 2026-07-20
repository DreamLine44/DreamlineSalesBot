/**
 * services/orderService.js
 *
 * [FIX-BUG5] Now calls recordOrderItem() after every successful save so that
 *            customer memory / personalisation / repeat-order features actually work.
 *            Previously customerMemory was defined but never invoked from here.
 *
 * [MULTICART-v39] resolveOrderFields() — pure normalization function that lets
 * saveOrder() accept EITHER the original single-item shape (item/quantity/
 * totalPrice/addOns — every one of the 9 non-cart verticals) OR a new items[]
 * cart shape (WA Catalog multi-item orders — see waCatalogFlow.js
 * handleMultiItemCatalogOrder()) without changing behaviour for existing
 * callers at all. When items[] is used, item/quantity/addOns are mirrored
 * from items[0] so every downstream reader (dashboard, analytics,
 * getLastOrderItem, admin alerts) keeps working unmodified.
 */
import Order  from '../models/Order.js';
import { recordOrderItem } from '../core/memory/customerMemory.js';
import { logAudit } from './auditService.js';
import logger from '../config/logger.js';

// [AUDIT-FIX-MULTICART-2] Hard ceiling on items[] length — saveOrder() itself
// must never accept an unbounded cart, independent of any flow-layer cap
// (business.multiItemCart.maxItems is a Phase 2 UX limit; this is the Phase 1
// data-layer backstop).
const HARD_MAX_CART_ITEMS = 50;

/**
 * resolveOrderFields({ item, quantity, totalPrice, addOns, items })
 * → { hasCart, resolvedItem, resolvedQuantity, resolvedTotal, resolvedAddOns }
 *
 * Pure — no DB access, no side effects. Exported for direct unit testing and
 * so buildCatalogCartItems() output can be validated before it ever reaches
 * saveOrder()/Order.create().
 */
export function resolveOrderFields({ item, quantity, totalPrice, addOns, items } = {}) {
  const hasCart = Array.isArray(items) && items.length > 0;

  if (!hasCart) {
    return {
      hasCart:          false,
      resolvedItem:     item,
      resolvedQuantity: quantity,
      resolvedAddOns:   addOns || [],
      resolvedTotal:    totalPrice ?? null,
    };
  }

  if (items.length > HARD_MAX_CART_ITEMS) {
    throw new Error(`Cart items[] exceeding the hard cap of ${HARD_MAX_CART_ITEMS} items`);
  }

  const first = items[0];

  // [AUDIT-FIX-MULTICART-1] Only auto-sum when EVERY item has a known
  // unitPrice — a partial sum silently presented as "the total" would drop
  // the cost of whatever's missing a price. Explicit totalPrice always wins.
  let resolvedTotal = totalPrice ?? null;
  if (resolvedTotal === null) {
    const allPriced = items.every(i => typeof i.unitPrice === 'number');
    resolvedTotal = allPriced
      ? items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
      : null;
  }

  return {
    hasCart:          true,
    resolvedItem:     first.item,
    resolvedQuantity: first.quantity,
    resolvedAddOns:   first.addOns || [],
    resolvedTotal,
  };
}

// [FIX-SAVE-1] Added `notes` and `customerName` to destructure — previously both were
// silently dropped because they weren't listed, even though notes IS in the Order schema
// and all module callers pass it. customerName is also now in the Order schema.
export async function saveOrder({ item, quantity, totalPrice, addOns, items, notes, customerName, customerPhone, tenantId, businessId, status }) {
  const { hasCart, resolvedItem, resolvedQuantity, resolvedTotal, resolvedAddOns } =
    resolveOrderFields({ item, quantity, totalPrice, addOns, items });

  const order = await Order.create({
    item:          resolvedItem,
    quantity:      resolvedQuantity,
    totalPrice:    resolvedTotal,
    addOns:        resolvedAddOns,
    ...(hasCart ? { items } : {}),
    notes:         notes         || null,
    customerName:  customerName  || null,
    customerPhone, tenantId, businessId,
    status:        status || 'pending',
    paymentStatus: 'unpaid',
  });

  // [FIX-BUG5] Update customer memory — fire-and-forget, never blocks order completion
  // [FIX-MEM-DOUBLECOUNT] countOrder:false — this fires on EVERY saveOrder() call,
  // including orders that are later rejected/cancelled/abandoned. stats.totalOrders
  // must only reflect confirmed orders, which recordConfirmedOrder() (called from
  // adminCommandService.confirmPayment on actual admin approval) already handles.
  // Without this flag, every approved order was counted twice — once here at save
  // time, once again at confirmation — corrupting VIP-threshold detection and
  // other internal order-count consumers (e.g. admin dashboard analytics).
  recordOrderItem(customerPhone, String(tenantId), resolvedItem, { countOrder: false }).catch(err =>
    logger.debug('[OrderService] recordOrderItem failed (non-fatal)', { err: err.message })
  );

  // [AUDIT-WIRE-1] AuditLog.js's own docstring has documented this as the
  // order_created call site since the model was written — auditService.js's
  // logAudit() existed and was fully unit-tested, but nothing anywhere ever
  // called it, so AuditLog was pure dead schema with zero rows ever written.
  // Fire-and-forget, matching auditService's own contract.
  logAudit({
    tenantId, orderId: order._id, actor: 'customer', actorId: customerPhone,
    action: 'order_created', metadata: { item: resolvedItem, quantity: resolvedQuantity, status: order.status },
  });

  return order;
}

export async function getRecentOrders(customerPhone, tenantId, limit = 5) {
  return Order.find({ customerPhone, tenantId }).sort({ createdAt: -1 }).limit(limit).lean();
}

export async function getLastOrderItem(customerPhone, tenantId) {
  const order = await Order.findOne({ customerPhone, tenantId }).sort({ createdAt: -1 }).lean();
  return order?.item || null;
}
