import mongoose from "mongoose";

const analyticsSchema = new mongoose.Schema(
  {
    // 🎯 TYPE
    type: {
      type: String,
      // ✅ NEW — "FAILED" type for unhandled / Groq-fallback interactions
      enum: ["ORDER", "BOOKING", "FAILED"],
      required: true,
      index: true
    },

    // 🏢 TENANT — scopes all analytics to a single business.
    // Without this field every tenant's stats merged into one platform-wide pool.
    phoneNumberId: {
      type: String,
      index: true
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

export default mongoose.model("Analytics", analyticsSchema);
