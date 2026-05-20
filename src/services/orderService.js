/**
 * services/orderService.js
 */
import Order  from '../models/Order.js';

export async function saveOrder({ item, quantity, totalPrice, addOns, customerPhone, tenantId, businessId }) {
  // NOTE: do NOT set shortId here — Order.pre('save') hook auto-populates it
  // from the last 6 hex chars of _id, keeping it consistent with admin command lookups.
  return Order.create({
    item, quantity, totalPrice,
    addOns:        addOns || [],
    customerPhone, tenantId, businessId,
    status:        'pending',
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
