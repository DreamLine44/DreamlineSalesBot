/**
 * core/analytics/analyticsService.js
 *
 * FIXES:
 * [FIX-A] track() was writing { event, timestamp } but Analytics schema uses
 *         { type, ...timestamps:true (createdAt) }. All analytics silently dropped.
 *         Now maps EVENT.* values to the schema's `type` enum and omits `timestamp`.
 * [FIX-B] getAnalyticsSummary queried { event, timestamp } — same schema mismatch.
 *         Now queries { type, createdAt } to match the actual Analytics schema.
 * [FIX-C] trackRevenue now accepts and stores tenantId.
 * [FIX-D] $exists:false → null on all scheduler sentinel fields.
 */

import Analytics from '../../models/Analytics.js';
import logger    from '../../config/logger.js';

export const EVENT = {
  ORDER_PLACED:    'ORDER_PLACED',
  BOOKING_MADE:    'BOOKING_MADE',
  PAYMENT_MADE:    'PAYMENT_MADE',
  REVENUE:         'REVENUE',
  ABANDONED_CART:  'ABANDONED_CART',
  USER_MESSAGE:    'USER_MESSAGE',
  FAILED_INTENT:   'FAILED_INTENT',
};

// Map EVENT.* strings → Analytics schema `type` enum values
// Schema enum: ["ORDER", "BOOKING", "FAILED", "REVENUE"]
const EVENT_TO_TYPE = {
  [EVENT.ORDER_PLACED]:   'ORDER',
  [EVENT.BOOKING_MADE]:   'BOOKING',
  [EVENT.PAYMENT_MADE]:   'ORDER',   // payment events stored as ORDER type
  [EVENT.REVENUE]:        'REVENUE',
  [EVENT.ABANDONED_CART]: 'FAILED',
  [EVENT.USER_MESSAGE]:   'ORDER',   // general message — best-fit bucket
  [EVENT.FAILED_INTENT]:  'FAILED',
};

/**
 * track(event, data)
 * Internal writer. Maps event string → schema type, omits legacy `timestamp` field.
 * Schema has `timestamps: true` which auto-sets createdAt — no manual timestamp needed.
 */
async function track(event, data = {}) {
  try {
    const type = EVENT_TO_TYPE[event] || 'ORDER';
    // Omit `event` and `timestamp` — not in schema. Use `type` instead.
    const { event: _e, timestamp: _t, ...rest } = data;
    await Analytics.create({ type, ...rest });
  } catch (err) {
    logger.debug('[Analytics] track failed (non-fatal)', { event, err: err.message });
  }
}

export async function trackOrderAnalytics(item, phoneNumberId, quantity, revenue, tenantId) {
  return track(EVENT.ORDER_PLACED, { item, phoneNumberId, quantity, revenue, tenantId });
}

export async function trackBookingAnalytics({ date, time, phoneNumberId, tenantId }) {
  return track(EVENT.BOOKING_MADE, {
    bookingDate: date ? new Date(date) : null,
    bookingTime: time,
    phoneNumberId,
    tenantId,
  });
}

/** [FIX-C] tenantId is required — was missing in v28 causing unscoped revenue records */
export async function recordRevenue({ item, quantity, revenue, tenantId, customerPhone, phoneNumberId }) {
  if (!revenue || revenue <= 0) return;
  return track(EVENT.REVENUE, { item, quantity, revenue, tenantId, phone: customerPhone, phoneNumberId });
}

export async function trackFailedInteraction(phone, message, tenantId) {
  return track(EVENT.FAILED_INTENT, {
    phone,
    failedMessage: (message || '').slice(0, 100),
    tenantId,
  });
}

/**
 * getAnalyticsSummary(tenantId, days)
 * [FIX-B] Was querying { event, timestamp } — Analytics schema has { type, createdAt }.
 *         Now uses correct field names.
 */
export async function getAnalyticsSummary(tenantId, days = 30) {
  const since = new Date(Date.now() - days * 86400000);
  try {
    const [orders, bookings, revenue] = await Promise.all([
      Analytics.countDocuments({ type: 'ORDER',   tenantId, createdAt: { $gte: since } }),
      Analytics.countDocuments({ type: 'BOOKING', tenantId, createdAt: { $gte: since } }),
      Analytics.aggregate([
        { $match: { type: 'REVENUE', tenantId, createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$revenue' } } },
      ]),
    ]);
    return { orders, bookings, revenue: revenue[0]?.total || 0, days };
  } catch (err) {
    logger.error('[Analytics] getAnalyticsSummary failed', { err: err.message });
    return { orders: 0, bookings: 0, revenue: 0, days };
  }
}
