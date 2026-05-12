import Analytics from "../models/Analytics.js";
import logger from "../config/logger.js";

// ================= TRACK ORDER =================

// [FIX 4] Accept actual `quantity` so analytics reflects real order volumes
// instead of always recording 1.
// [FIX R] Accept `revenue` (totalPrice) so we can aggregate sales revenue.
// [FIX T] Accept `tenantId` — Analytics model has the field but callers weren't
// passing it. Without it, platform-level tenantId queries return nothing.
export const trackOrderAnalytics = async (item, phoneNumberId = null, quantity = 1, revenue = 0, tenantId = null) => {
  try {
    const now = new Date();
    await Analytics.create({
      type: "ORDER",
      phoneNumberId,
      tenantId: tenantId || undefined,
      item,
      quantity: quantity > 0 ? quantity : 1,
      revenue:  revenue  > 0 ? revenue  : 0,
      hour: now.getHours(),
      dayOfWeek: now.getDay()
    });
  } catch (err) {
    logger.error("Order Analytics Error:", err.message);
  }
};


// ================= TRACK BOOKING =================

export const trackBookingAnalytics = async ({ date, time, phoneNumberId = null, tenantId = null } = {}) => {
  try {
    const now = new Date();

    const parsedDate = date ? new Date(date) : null;
    const validDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : undefined;

    await Analytics.create({
      type: "BOOKING",
      phoneNumberId,
      tenantId: tenantId || undefined,
      bookingDate: validDate,
      bookingTime: time || undefined,
      hour: now.getHours(),
      dayOfWeek: now.getDay()
    });
  } catch (err) {
    logger.error("Booking Analytics Error:", err.message);
  }
};


// ================= TRACK FAILED INTERACTION =================

export const trackFailedInteraction = async (phone, message, intent = "UNKNOWN", phoneNumberId = null) => {
  try {
    const now = new Date();
    await Analytics.create({
      type: "FAILED",
      phoneNumberId,
      phone,
      failedMessage: message,
      failedIntent:  intent,
      hour:          now.getHours(),
      dayOfWeek:     now.getDay()
    });
  } catch (err) {
    logger.error("Failed Interaction Tracking Error:", err.message);
  }
};


// ================= TRACK REVENUE =================
//
// Called by revenueEngineService after every confirmed order.
// Stores a dedicated REVENUE record so revenue can be aggregated
// independently of order counts (e.g. cancelled orders don't inflate revenue).
//
// Parameters:
//   item          — item name (or "item + add-on" string)
//   quantity      — number of units ordered
//   revenue       — total order value in local currency (e.g. GMD)
//   phoneNumberId — tenant identifier
//   customerPhone — customer's phone number (for unique customer count)
//
export const trackRevenue = async ({ item, quantity, revenue, phoneNumberId = null, customerPhone = null } = {}) => {
  if (!revenue || revenue <= 0) return;
  try {
    const now = new Date();
    await Analytics.create({
      type:         'REVENUE',
      phoneNumberId,
      phone:        customerPhone,
      item,
      quantity:     quantity > 0 ? quantity : 1,
      revenue,
      hour:         now.getHours(),
      dayOfWeek:    now.getDay(),
    });
  } catch (err) {
    logger.error('Revenue Tracking Error:', err.message);
  }
};


// ================= GET TOP ITEM =================

export const getTopItem = async (phoneNumberId) => {
  try {
    const match = { type: "ORDER" };
    if (phoneNumberId) match.phoneNumberId = phoneNumberId;

    const result = await Analytics.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$item",
          total: { $sum: "$quantity" }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 1 }
    ]);

    return result[0]?._id || null;
  } catch (err) {
    return null;
  }
};


// ================= GET PEAK HOUR =================

export const getPeakHour = async (phoneNumberId) => {
  try {
    const match = { hour: { $exists: true } };
    if (phoneNumberId) match.phoneNumberId = phoneNumberId;

    const result = await Analytics.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$hour",
          total: { $sum: 1 }
        }
      },
      { $sort: { total: -1 } },
      { $limit: 1 }
    ]);

    return result[0]?._id ?? null;
  } catch (err) {
    return null;
  }
};


// ================= DAILY STATS =================

export const getDailyStats = async (phoneNumberId) => {
  try {
    const match = {};
    if (phoneNumberId) match.phoneNumberId = phoneNumberId;

    const pipeline = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });

    pipeline.push(
      {
        // [FIX-G] Keep phoneNumberId in $project so the subsequent $group
        // doesn't accidentally merge records from different tenants when
        // the $match stage is empty (no phoneNumberId provided).
        // Also keep type so the $group can distinguish ORDER vs BOOKING vs FAILED.
        $project: {
          type: 1,
          phoneNumberId: 1,
          day: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$createdAt"
            }
          }
        }
      },
      {
        $group: {
          _id: { day: "$day", type: "$type" },
          total: { $sum: 1 }
        }
      },
      { $sort: { "_id.day": -1 } }
    );

    return await Analytics.aggregate(pipeline);
  } catch (err) {
    return [];
  }
};


// ================= GET ANALYTICS SUMMARY =================
// Scoped to a single tenant via phoneNumberId.
// All counts and aggregations only include records for that tenant.

export const getAnalyticsSummary = async (phoneNumberId) => {
  try {
    const filter = phoneNumberId ? { phoneNumberId } : {};

    // Revenue aggregation — sum all REVENUE records for this tenant
    const revenueAgg = Analytics.aggregate([
      { $match: { ...filter, type: 'REVENUE', revenue: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$revenue' } } },
    ]);

    // Unique customers — distinct phone values across ORDER records
    const uniqueCustomersAgg = Analytics.distinct('phone', {
      ...filter,
      type:  'ORDER',
      phone: { $ne: null },
    });

    const [
      topItem,
      peakHour,
      dailyStats,
      totalOrders,
      totalBookings,
      totalFailed,
      revenueResult,
      uniqueCustomers,
    ] = await Promise.all([
      getTopItem(phoneNumberId),
      getPeakHour(phoneNumberId),
      getDailyStats(phoneNumberId),
      Analytics.countDocuments({ ...filter, type: "ORDER" }),
      Analytics.countDocuments({ ...filter, type: "BOOKING" }),
      Analytics.countDocuments({ ...filter, type: "FAILED" }),
      revenueAgg,
      uniqueCustomersAgg,
    ]);

    const totalRevenue = revenueResult[0]?.total ?? 0;

    return {
      totalOrders,
      totalBookings,
      totalFailed,
      totalRevenue,
      uniqueCustomers: uniqueCustomers.length,
      topItem,
      peakHour: peakHour !== null ? `${peakHour}:00` : null,
      dailyStats,
    };
  } catch (err) {
    logger.error("Analytics Summary Error:", err.message);
    return null;
  }
};
