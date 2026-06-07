/**
 * models/Analytics.js
 *
 * [AUDIT-P2-B] Added compound indexes on tenantId for dashboard analytics queries.
 *              Previously Analytics.aggregate({ $match: { tenantId } }) was a full
 *              collection scan. At scale with many tenants this will be a bottleneck.
 *
 *              New indexes:
 *                (tenantId, type, createdAt) — primary analytics query pattern
 *                (tenantId, createdAt)       — time-range queries per tenant
 *
 *              Pre-existing phoneNumberId indexes are retained for backward-compat
 *              with any paths that still query by phoneNumberId.
 */
import mongoose from "mongoose";

const analyticsSchema = new mongoose.Schema(
  {
    // 🎯 TYPE
    type: {
      type: String,
      enum: ["ORDER", "BOOKING", "FAILED", "REVENUE"],
      required: true,
      index: true
    },

    // 🏢 TENANT — scopes all analytics to a single business.
    // Without this field every tenant's stats merged into one platform-wide pool.
    phoneNumberId: {
      type: String,
      index: true
    },

    // tenantId for direct cross-collection joins and platform-level queries
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      index: true,
      default: null,
    },

    // 👤 USER
    phone: {
      type: String,
      index: true
    },

    // 🍽️ ORDER DATA
    item: {
      type: String,
      index: true
    },

    quantity: {
      type: Number,
      default: 1
    },

    // 💰 REVENUE — amount collected for this order (in local currency, e.g. GMD)
    // Populated only for type === "ORDER" or type === "REVENUE".
    // Zero-price orders (free samples, etc.) are stored as 0, not null.
    revenue: {
      type:    Number,
      default: 0,
      min:     0,
      index:   true,
    },

    // 📅 BOOKING DATA
    bookingDate: {
      type: Date
    },

    bookingTime: {
      type: String
    },

    // ✅ NEW — failed interaction details
    // Populated when type === "FAILED"
    failedMessage: {
      type: String,
      default: null
    },

    failedIntent: {
      type: String,
      default: null
    },

    // ================= TIME INTELLIGENCE =================

    hour: {
      type: Number,
      min: 0,
      max: 23,
      index: true
    },

    dayOfWeek: {
      type: Number, // 0 = Sunday, 6 = Saturday
      min: 0,
      max: 6,
      index: true
    },

    // 📊 META
    source: {
      type: String,
      default: "whatsapp"
    }
  },
  {
    timestamps: true
  }
);

// ── Compound indexes ──────────────────────────────────────────────────────────
// phoneNumberId-based indexes (legacy — retained for backward compat):
//   getTopItem:          { type: "ORDER", phoneNumberId }  → sorted by quantity
//   getPeakHour:         { phoneNumberId, hour }
//   getDailyStats:       { phoneNumberId } → grouped by day
//   getAnalyticsSummary: { phoneNumberId, type }
//   trackRevenue:        { type: "REVENUE", phoneNumberId, revenue }
analyticsSchema.index({ phoneNumberId: 1, type: 1, createdAt: -1 });
analyticsSchema.index({ phoneNumberId: 1, type: 1, revenue: 1 });
analyticsSchema.index({ type: 1, item: 1 });

// [AUDIT-P2-B] tenantId-based indexes (new) — required for dashboard analytics
// aggregate queries that filter by tenantId. Without these, every call to
// getAnalyticsSummary() is a full collection scan.
analyticsSchema.index({ tenantId: 1, type: 1, createdAt: -1 });
analyticsSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model("Analytics", analyticsSchema);
