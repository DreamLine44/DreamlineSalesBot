import Analytics from "../models/Analytics.js";
import logger from "../config/logger.js";

// ================= TRACK ORDER =================

// [FIX 4] Accept actual `quantity` so analytics reflects real order volumes
// instead of always recording 1.
export const trackOrderAnalytics = async (item, phoneNumberId = null, quantity = 1) => {
  try {
    const now = new Date();
    await Analytics.create({
      type: "ORDER",
      phoneNumberId,
      item,
      quantity: quantity > 0 ? quantity : 1,
      hour: now.getHours(),
      dayOfWeek: now.getDay()
    });
  } catch (err) {
    logger.error("Order Analytics Error:", err.message);
  }
};


// ================= TRACK BOOKING =================

export const trackBookingAnalytics = async ({ date, time, phoneNumberId = null } = {}) => {
  try {
    const now = new Date();

    const parsedDate = date ? new Date(date) : null;
    const validDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : undefined;

    await Analytics.create({
      type: "BOOKING",
      phoneNumberId,
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
// ✅ NEW — logs any message the bot couldn't handle (Groq fallback / repeat loops)

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
        $project: {
          type: 1,
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

    const [
      topItem,
      peakHour,
      dailyStats,
      totalOrders,
      totalBookings,
      totalFailed,
    ] = await Promise.all([
      getTopItem(phoneNumberId),
      getPeakHour(phoneNumberId),
      getDailyStats(phoneNumberId),
      Analytics.countDocuments({ ...filter, type: "ORDER" }),
      Analytics.countDocuments({ ...filter, type: "BOOKING" }),
      Analytics.countDocuments({ ...filter, type: "FAILED" }),
    ]);

    return {
      totalOrders,
      totalBookings,
      totalFailed,
      topItem,
      peakHour: peakHour !== null ? `${peakHour}:00` : null,
      dailyStats,
    };
  } catch (err) {
    logger.error("Analytics Summary Error:", err.message);
    return null;
  }
};
