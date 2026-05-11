import mongoose from "mongoose";

const favoriteItemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  count: { type: Number, default: 1 }
}, { _id: false });

const userProfileSchema = new mongoose.Schema({

  // 🔑 Identity
  phone: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // ================= 🧠 BEHAVIOR ENGINE =================
  behavior: {
    style: {
      type: String,
      // "ROUGH" was in the enum but detectStyle() never returns it — removed.
      // "NORMAL" was returned by detectStyle() but missing from enum — added.
      enum: ["FAST", "CONFUSED", "POLITE", "NORMAL", "DETAILED"],
      default: "NORMAL"
    },

    scores: {
      fast:     { type: Number, default: 0 },
      confused: { type: Number, default: 0 },
      polite:   { type: Number, default: 0 },
      normal:   { type: Number, default: 0 }, // was "rough" — never produced; "normal" always was
      detailed: { type: Number, default: 0 }
    }
  },

  // ================= 📊 INTERACTION MEMORY =================
  stats: {
    totalMessages: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    totalBookings: { type: Number, default: 0 }
  },

  // ================= 🎯 INTENT MEMORY =================
  memory: {
    lastIntent: { type: String, default: null },
    lastFlow: { type: String, default: null },
    lastMessage: { type: String, default: null }
  },

  // ================= 🛒 PREFERENCES =================
  preferences: {
    favoriteItems: [favoriteItemSchema],

    preferredTime: { type: String, default: null },

    frequentFlow: {
      type: String,
      enum: ["ORDER", "BOOKING", "BOTH"],
      default: "BOTH"
    }
  },

  // ================= 🧠 LEARNING SIGNALS =================
  learning: {
    confidenceScore: {
      type: Number,
      default: 0,
      min: 0
    },

    consistencyScore: {
      type: Number,
      default: 0,
      min: 0
    },

    lastRecommendation: { type: String, default: null }
  },

  // ================= ⏱️ ACTIVITY =================
  activity: {
    lastSeen: { type: Date, default: Date.now },
    firstSeen: { type: Date, default: Date.now }
  },

  // ================= 🎯 LEAD CAPTURE =================
  // Populated by leadCaptureService when business.leadCapture.enabled = true.
  // All fields are optional — the capture flow accepts "skip" at every step.
  lead: {
    captured:   { type: Boolean, default: false },
    name:       { type: String,  default: null },
    contact:    { type: String,  default: null }, // email or phone
    interest:   { type: String,  default: null },
    capturedAt: { type: Date,    default: null },
  },

}, {
  timestamps: true,
  minimize: false // 🔥 keeps empty objects (important for AI logic)
});

export default mongoose.model("UserProfile", userProfileSchema);