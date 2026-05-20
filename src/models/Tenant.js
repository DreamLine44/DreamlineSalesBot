import mongoose from "mongoose";
import crypto from "crypto";

const tenantSchema = new mongoose.Schema({

  // ================= IDENTITY =================
  name: {
    type: String,
    required: true,
    trim: true
  },

  // [FIX] email was required:true but tenantController.createTenant and seed.js
  // never supply it — every Tenant.create() threw a Mongoose ValidationError and
  // silently rolled back. Made optional (sparse unique so two tenants can omit it).
  email: {
    type: String,
    required: false,
    unique: true,
    sparse: true,       // only index when present — allows multiple tenants with no email
    lowercase: true,
    trim: true,
    default: null,
  },

  // ================= AUTH =================
  apiKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // Hashed version of apiKey for safe DB lookups.
  apiKeyHash: {
    type: String,
    index: true,
    sparse: true,
  },

  // ================= WHATSAPP CREDENTIALS =================
  whatsapp: {
    phone: {
      type: String,
      trim: true,
      default: null
    },

    phoneNumberId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    wabaId: {
      type: String,
      trim: true,
      default: null
    },

    accessToken: {
      type: String,
      trim: true,
      default: null
    },

    verifyToken: {
      type: String,
      trim: true,
      default: null
    },

    apiVersion: {
      type: String,
      default: "v21.0",
      trim: true
    },

    connected: {
      type: Boolean,
      default: false
    },

    tokenUpdatedAt: {
      type: Date,
      default: null
    }
  },

  // ================= PLAN =================
  plan: {
    type: String,
    enum: ["FREE", "STARTER", "PRO", "ENTERPRISE"],
    default: "FREE"
  },

  limits: {
    messagesPerMonth: { type: Number, default: 500 },
    maxMenuItems:     { type: Number, default: 10 },
    maxAdmins:        { type: Number, default: 1 }
  },

  usage: {
    messagesThisMonth: { type: Number, default: 0 },
    resetDate:         { type: Date, default: () => new Date() }
  },

  // ================= STATUS =================
  status: {
    type: String,
    enum: ["ACTIVE", "SUSPENDED", "PENDING", "INACTIVE"],
    default: "PENDING"
  },

  // ================= ONBOARDING STEP =================
  onboardingStep: {
    type:    Number,
    default: 0,
    min:     0,
    max:     3,
  },

  // ================= ADMIN CONTACT =================
  adminPhone: {
    type:    String,
    default: null,
    trim:    true,
  },

  // ================= META =================
  notes: { type: String, default: "" }

}, { timestamps: true });

// Auto-generate apiKey and keep apiKeyHash in sync
tenantSchema.pre("validate", function (next) {
  if (!this.apiKey) {
    this.apiKey = crypto.randomBytes(32).toString("hex");
  }
  if (!this.apiKeyHash || this.isModified("apiKey")) {
    this.apiKeyHash = crypto.createHash("sha256").update(this.apiKey).digest("hex");
  }
  next();
});

tenantSchema.set("toJSON", {
  transform: (doc, ret) => {
    if (ret.whatsapp) delete ret.whatsapp.accessToken;
    delete ret.apiKey;
    delete ret.__v;
    return ret;
  }
});

export default mongoose.model("Tenant", tenantSchema);
