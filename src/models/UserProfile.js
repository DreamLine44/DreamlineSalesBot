import mongoose from "mongoose";

const favoriteItemSchema = new mongoose.Schema({
  name:  { type: String, required: true },
  count: { type: Number, default: 1 }
}, { _id: false });

const userProfileSchema = new mongoose.Schema({

  // 🔑 Identity
  // [FIX-C] `phone` alone was unique — two tenants with the same customer phone
  // collided on insert. Unique constraint moved to compound index (phone, tenantId)
  // at the bottom of this file. The field-level `unique: true` is REMOVED.
  phone: {
    type:     String,
    required: true,
    index:    true   // single-field index kept for query perf; uniqueness via compound below
  },

  // Tenant scope — required for multi-tenancy correctness.
  // Every query that reads/writes UserProfile must include tenantId.
  tenantId: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   'Tenant',
    index: true,
    default: null,
  },

  // ================= 🧠 BEHAVIOR ENGINE =================
  behavior: {
    style: {
      type: String,
      // "ROUGH" was in the enum but detectStyle() never returns it — removed.
      // "NORMAL" was returned by detectStyle() but missing from enum — added.
      enum:    ["FAST", "CONFUSED", "POLITE", "NORMAL", "DETAILED"],
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
    totalOrders:   { type: Number, default: 0 },
    totalBookings: { type: Number, default: 0 }
  },

  // ================= 🎯 INTENT MEMORY =================
  memory: {
    lastIntent:  { type: String, default: null },
    lastFlow:    { type: String, default: null },
    lastMessage: { type: String, default: null }
  },

  // ================= 🛒 PREFERENCES =================
  preferences: {
    favoriteItems: [favoriteItemSchema],

    preferredTime: { type: String, default: null },

    frequentFlow: {
      type:    String,
      enum:    ["ORDER", "BOOKING", "BOTH"],
      default: "BOTH"
    }
  },

  // ================= 🧠 LEARNING SIGNALS =================
  learning: {
    confidenceScore: {
      type:    Number,
      default: 0,
      min:     0
    },

    consistencyScore: {
      type:    Number,
      default: 0,
      min:     0
    },

    lastRecommendation: { type: String, default: null }
  },

  // ================= ⏱️ ACTIVITY =================
  activity: {
    lastSeen:  { type: Date, default: Date.now },
    firstSeen: { type: Date, default: Date.now }
  },

  // ================= 🎯 LEAD CAPTURE =================
  // Populated by leadCaptureService when business.leadCapture.enabled = true.
  // All fields are optional — the capture flow accepts "skip" at every step.
  lead: {
    captured:   { type: Boolean, default: false },
    name:       { type: String,  default: null },
    // [FIX-H] leadCaptureService writes lead.email but this field was missing.
    // Without it, Mongoose strict mode silently dropped every email write.
    email:      { type: String,  default: null },
    contact:    { type: String,  default: null }, // legacy alias — email or phone
    interest:   { type: String,  default: null },
    // [FIX-H] capturedAt and source were written by leadCaptureService but absent
    // from the schema — silently dropped by Mongoose strict mode.
    capturedAt: { type: Date,    default: null },
    source:     { type: String,  default: null }, // e.g. "whatsapp"
    // [FIX] tenantId scopes the lead to the business that captured it.
    // Without this, getLeadsForTenant() falls back to querying ephemeral Session
    // records — customers who haven't messaged in >30 min have no session and
    // their captured leads are invisible to GET /business/leads.
    // NOTE: top-level tenantId (added in FIX-C) is the canonical scope field.
    // This nested copy is kept for backward-compat with any lead-specific queries.
    tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
  },

}, {
  timestamps: true,
  minimize:   false // 🔥 keeps empty objects (important for AI logic)
});

// [FIX-C] Compound unique index — replaces the old field-level unique:true on phone.
// Two tenants can serve the same customer phone; the compound (phone, tenantId) is
// what must be unique, not phone alone.
userProfileSchema.index({ phone: 1, tenantId: 1 }, { unique: true });

export default mongoose.model("UserProfile", userProfileSchema);
