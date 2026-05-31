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

// Compound indexes for the most common analytics query patterns:
//   getTopItem:          { type: "ORDER", phoneNumberId }  → sorted by quantity
//   getPeakHour:         { phoneNumberId, hour }
//   getDailyStats:       { phoneNumberId } → grouped by day
//   getAnalyticsSummary: { phoneNumberId, type }
//   trackRevenue:        { type: "REVENUE", phoneNumberId, revenue }
analyticsSchema.index({ phoneNumberId: 1, type: 1, createdAt: -1 });
analyticsSchema.index({ phoneNumberId: 1, type: 1, revenue: 1 });
analyticsSchema.index({ type: 1, item: 1 });

export default mongoose.model("Analytics", analyticsSchema);
