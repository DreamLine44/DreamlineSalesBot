/**
 * services/orderService.js
 *
 * [FIX] saveOrder: accepts and stores `status` param.
 *       Callers on the payment path pass 'pending_payment';
 *       callers on the no-payment path pass 'confirmed'.
 *       Previously the param was silently ignored — every order saved as 'pending'.
 *
 * [FIX] Added getLastOrder() — returns the full Order document (including price).
 *       REPEAT_ORDER in moduleRegistry needs the price to compute totals correctly.
 *       getLastOrderItem() only returns the name string — left for backward-compat.
 */
import Order from '../models/Order.js';

export async function saveOrder({
  item, quantity, totalPrice, addOns,
  customerPhone, tenantId, businessId, status,
}) {
  return Order.create({
    item, quantity, totalPrice,
    addOns:        addOns || [],
    customerPhone, tenantId, businessId,
    status:        status || 'pending',
    paymentStatus: 'unpaid',
  });
}

export async function getRecentOrders(customerPhone, tenantId, limit = 5) {
  return Order.find({ customerPhone, tenantId }).sort({ createdAt: -1 }).limit(limit).lean();
}

export async function getLastOrderItem(customerPhone, tenantId) {
  const order = await Order.findOne({ customerPhone, tenantId }).sort({ createdAt: -1 }).lean();
  return order?.item || null;
}

/**
 * getLastOrder — full Order document (includes price, quantity, totalPrice).
 * Used by REPEAT_ORDER to compute unit price for the QUANTITY step.
 */
export async function getLastOrder(customerPhone, tenantId) {
  return Order.findOne({ customerPhone, tenantId }).sort({ createdAt: -1 }).lean();
}
