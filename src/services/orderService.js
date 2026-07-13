/**
 * services/orderService.js
 *
 * [FIX-BUG5] Now calls recordOrderItem() after every successful save so that
 *            customer memory / personalisation / repeat-order features actually work.
 *            Previously customerMemory was defined but never invoked from here.
 */
import Order  from '../models/Order.js';
import { recordOrderItem } from '../core/memory/customerMemory.js';
import { validatePromoCode, applyPromoUsage } from './promoService.js';
import logger from '../config/logger.js';

// [MULTICART-v39] Hard ceiling on cart size, independent of any per-tenant
// multiItemCart.maxItems config. This is a last-line-of-defense sanity bound
// on saveOrder() itself — the flow layer (Phase 2's "add another item?" loop)
// is expected to enforce the tenant's own configured maxItems (1-50) before
// ever calling saveOrder(), but this schema field's max is 50, so no tenant
// can legitimately need more than that. Without this, a stuck loop or a
// caller bug upstream could hand saveOrder() an unbounded items[] array with
// nothing here to catch it.
const HARD_MAX_CART_ITEMS = 50;

// [MULTICART-v39] Pure normalization, split out from saveOrder() so it's
// unit-testable without a live DB connection. If items[] is supplied,
// item/quantity/addOns always mirror items[0] so every pre-v39 reader
// (dashboard, analytics, getLastOrderItem) keeps working unchanged, whether
// this is a single- or multi-item order.
export function resolveOrderFields({ item, quantity, totalPrice, addOns, items }) {
  const hasCart = Array.isArray(items) && items.length > 0;

  if (hasCart && items.length > HARD_MAX_CART_ITEMS) {
    throw new Error(
      `[MULTICART-v39] items[] has ${items.length} entries, exceeding the hard cap of ${HARD_MAX_CART_ITEMS}.`
    );
  }

  const resolvedItem     = hasCart ? items[0].item     : item;
  const resolvedQuantity = hasCart ? items[0].quantity : quantity;
  const resolvedAddOns   = hasCart ? (items[0].addOns || []) : (addOns || []);

  // [AUDIT-FIX-MULTICART-1] Previously, if only SOME cart items had a
  // unitPrice, the sum silently added only the priced items and presented
  // the partial result as if it were the full order total (e.g. a 2-item
  // cart where only item 1 has a price would report item 1's price alone
  // as "the total"). That's a silent undercount, not a real total. Now:
  // the computed sum is only used when EVERY item has a unitPrice; if any
  // item is missing one, resolvedTotal is null (unknown) rather than wrong.
  const allItemsPriced = hasCart && items.every(it => it.unitPrice != null);
  const computedCartTotal = allItemsPriced
    ? items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0)
    : null;

  const resolvedTotal = totalPrice != null
    ? totalPrice
    : (hasCart ? computedCartTotal : null);

  return { hasCart, resolvedItem, resolvedQuantity, resolvedAddOns, resolvedTotal };
}

// [FIX-SAVE-1] Added `notes` and `customerName` to destructure — previously both were
// silently dropped because they weren't listed, even though notes IS in the Order schema
// and all module callers pass it. customerName is also now in the Order schema.
//
// [MULTICART-v39] Backward-compatible signature change: callers can now pass an
// optional `items` array ([{ item, quantity, addOns, unitPrice }, ...]) instead of
// (or alongside) the single item/quantity/addOns fields. Every existing caller that
// still passes item/quantity/addOns directly is unaffected — items defaults to
// undefined and the single-item path below runs exactly as before.
// [CATALOG-STOCK-1] Decrements BusinessConfig.menuItems[].stockCount for every
// line in a just-placed order, for items that actually track stock (stockCount
// != null — untracked items are a complete no-op, zero behaviour change).
// Flips `available` to false once an item hits 0, and — if that happened and
// the tenant has WA Catalog enabled — immediately schedules a resync so the
// Meta-facing catalog doesn't sit stale (out-of-stock item still shown as
// purchasable) until the next unrelated menu edit debounces one in.
// Never throws outward: called fire-and-forget from saveOrder(), same pattern
// as recordOrderItem() above.
//
// [AUDIT-FIX-STOCK-RACE-1] Previously this read `menuItem.stockCount` via a
// plain findById().lean() snapshot, computed `newStock = stockCount - qty` in
// JS, then wrote that JS-computed value back with a plain $set. Two orders
// for the same limited-stock item arriving close together (a real scenario —
// this is a WhatsApp bot with no purchase-time reservation/lock step) both
// read the same starting stockCount, both compute the same newStock, and the
// second write simply overwrites the first: exactly one unit gets decremented
// total instead of two, silently overselling. This is the identical
// check-then-write race class already fixed atomically in promoService's
// applyPromoUsage() (see [AUDIT-FIX-PROMO-RACE]) — same fix shape here: an
// aggregation-pipeline update ($map/$cond) that reads and writes
// menuItems.$.stockCount in one atomic server-side operation per item, so
// concurrent decrements always serialize correctly instead of racing on a
// stale JS-side snapshot.
async function decrementStockForOrder(businessId, tenantId, lines) {
  if (!businessId || !Array.isArray(lines) || !lines.length) return;

  const { default: BusinessConfig } = await import('../models/BusinessConfig.js');

  let anyWentOutOfStock = false;
  let waCatalog = null;

  for (const { menuItemId, quantity } of lines) {
    if (!menuItemId) continue;
    const qty = Number(quantity) || 1;

    let updated;
    try {
      // Filter requires the target item to exist AND currently track stock
      // (stockCount != null) — untracked items never match, so this is a
      // complete no-op for them, same as before.
      updated = await BusinessConfig.findOneAndUpdate(
        { _id: businessId, menuItems: { $elemMatch: { _id: menuItemId, stockCount: { $ne: null } } } },
        [
          {
            $set: {
              menuItems: {
                $map: {
                  input: '$menuItems',
                  as: 'mi',
                  in: {
                    $cond: [
                      { $eq: ['$$mi._id', menuItemId] },
                      {
                        $mergeObjects: [
                          '$$mi',
                          {
                            stockCount: { $max: [0, { $subtract: ['$$mi.stockCount', qty] }] },
                            available: {
                              $cond: [
                                { $lte: [{ $subtract: ['$$mi.stockCount', qty] }, 0] },
                                false,
                                '$$mi.available',
                              ],
                            },
                          },
                        ],
                      },
                      '$$mi',
                    ],
                  },
                },
              },
            },
          },
        ],
        { new: true, projection: { 'menuItems.$': 1, waCatalog: 1 } },
      ).lean();
    } catch (err) {
      logger.error('[OrderService] stock decrement failed (non-fatal)', { err: err.message, businessId, menuItemId });
      continue;
    }

    if (!updated) continue; // item didn't match (untracked, deleted, or wrong id) — nothing to do
    waCatalog = updated.waCatalog || waCatalog;
    const newStockCount = updated.menuItems?.[0]?.stockCount;
    // Trigger a resync whenever the item is now at zero. This runs on every
    // order that empties an already-empty item too (not just the "first" time
    // it hits zero) — harmless: waCatalogSyncScheduler's delta sync
    // ([CATALOG-DELTA-1]) skips items whose synced content hash is unchanged,
    // so a redundant trigger costs nothing but avoids re-introducing the same
    // stale-snapshot race this fix removes if we tried to detect the exact
    // zero-crossing instead.
    if (newStockCount === 0) anyWentOutOfStock = true;
  }

  if (anyWentOutOfStock && waCatalog?.enabled && waCatalog?.catalogId) {
    const { scheduleWaCatalogSync } = await import('../modules/catalog/waCatalogSyncScheduler.js');
    scheduleWaCatalogSync(String(tenantId));
  }
}

export async function saveOrder({
  item, quantity, totalPrice, addOns,
  items,          // [MULTICART-v39] optional multi-item array
  menuItemId,     // [CATALOG-STOCK-1] optional — enables stock decrement for single-item orders
  promoCode,      // [PROMO-1] optional — validated & applied below if present
  notes, customerName, customerPhone, tenantId, businessId, status,
}) {
  const { hasCart, resolvedItem, resolvedQuantity, resolvedAddOns, resolvedTotal } =
    resolveOrderFields({ item, quantity, totalPrice, addOns, items });

  // [PROMO-1] Only touched when a caller explicitly supplies promoCode — every
  // existing caller that doesn't pass one gets byte-for-byte the same order
  // as before. Validation failures are non-fatal: the order still saves, just
  // without a discount, so a stale/expired code never blocks a sale.
  let finalTotal = resolvedTotal;
  let appliedPromoCode = null;
  let appliedDiscountAmount = null;
  if (promoCode && resolvedTotal != null) {
    try {
      const result = await validatePromoCode(tenantId, promoCode, resolvedTotal);
      if (result.valid) {
        finalTotal = result.newTotal;
        appliedPromoCode = result.promotion.code;
        appliedDiscountAmount = result.discountAmount;
      } else {
        logger.info('[OrderService] promoCode not applied', { tenantId, promoCode, reason: result.reason });
      }
    } catch (err) {
      logger.warn('[OrderService] promoCode validation failed (non-fatal)', { err: err.message, tenantId, promoCode });
    }
  }

  const order = await Order.create({
    item: resolvedItem, quantity: resolvedQuantity, totalPrice: finalTotal,
    addOns:        resolvedAddOns,
    items:         hasCart ? items : undefined,
    notes:         notes         || null,
    customerName:  customerName  || null,
    customerPhone, tenantId, businessId,
    status:        status || 'pending',
    paymentStatus: 'unpaid',
    promoCode:      appliedPromoCode,
    discountAmount: appliedDiscountAmount,
  });

  // [PROMO-1] Fire-and-forget usage increment — mirrors decrementStockForOrder's
  // fire-and-forget pattern below. Must never block or fail order creation.
  if (appliedPromoCode) {
    applyPromoUsage(tenantId, appliedPromoCode).catch(() => {});
  }

  // [FIX-BUG5] Update customer memory — fire-and-forget, never blocks order completion
  // [FIX-MEM-DOUBLECOUNT] countOrder:false — this fires on EVERY saveOrder() call,
  // including orders that are later rejected/cancelled/abandoned. stats.totalOrders
  // must only reflect confirmed orders, which recordConfirmedOrder() (called from
  // adminCommandService.confirmPayment on actual admin approval) already handles.
  // Without this flag, every approved order was counted twice — once here at save
  // time, once again at confirmation — corrupting VIP-threshold detection and the
  // "welcome back" returning-customer greeting logic in moduleRouter.js.
  // [MULTICART-v39] For a multi-item order, record EVERY item, not just the first —
  // otherwise repeat-order/personalisation memory would silently forget every item
  // past items[0] in a cart order.
  const itemsToRecord = hasCart ? items.map(it => it.item) : [resolvedItem];
  for (const itemName of itemsToRecord) {
    recordOrderItem(customerPhone, String(tenantId), itemName, { countOrder: false }).catch(err =>
      logger.debug('[OrderService] recordOrderItem failed (non-fatal)', { err: err.message })
    );
  }

  // [CATALOG-STOCK-1] Fire-and-forget stock decrement — never blocks order
  // completion. Only does anything for lines that actually carry a
  // menuItemId (i.e. callers that resolved a real BusinessConfig.menuItems
  // entry) and only for items that track stockCount at all.
  const stockLines = hasCart
    ? items.map(it => ({ menuItemId: it.menuItemId, quantity: it.quantity })).filter(l => l.menuItemId)
    : (menuItemId ? [{ menuItemId, quantity: resolvedQuantity }] : []);
  if (stockLines.length) {
    decrementStockForOrder(businessId, tenantId, stockLines).catch(err =>
      logger.debug('[OrderService] decrementStockForOrder failed (non-fatal)', { err: err.message })
    );
  }

  return order;
}

export async function getRecentOrders(customerPhone, tenantId, limit = 5) {
  return Order.find({ customerPhone, tenantId }).sort({ createdAt: -1 }).limit(limit).lean();
}

export async function getLastOrderItem(customerPhone, tenantId) {
  const order = await Order.findOne({ customerPhone, tenantId }).sort({ createdAt: -1 }).lean();
  return order?.item || null;
}
