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
  // [FIX-RAWKEY] apiKey (plaintext) removed from the schema. Storing the raw key
  // in the DB means a DB breach exposes every tenant's key directly. Only the
  // SHA-256 hash (apiKeyHash) is stored and used for lookups. The plaintext key
  // is generated, returned once to the caller, then discarded — never persisted.
  // NOTE: existing rows that still have apiKey populated will continue to work;
  // auth middleware uses apiKeyHash for lookups. Run a migration to $unset apiKey
  // on all existing tenant documents before removing the field entirely from the DB.
  apiKeyHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
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
  // 0 = schema default (should not persist — createTenant writes 1 immediately)
  // 1 = tenant created, awaiting WhatsApp credentials
  // 2 = credentials supplied, awaiting Meta verification
  // 3 = credentials verified by Meta (whatsapp.connected = true)
  // 4 = tenant activated (status = ACTIVE) — fully live
  onboardingStep: {
    type:    Number,
    default: 0,
    min:     0,
    max:     4,
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

// [FIX-RAWKEY] Generate a plaintext key, hash it, store only the hash.
// The plaintext key is returned once by createTenant/rotateApiKey and then
// discarded — it is never stored in the DB. This means a DB breach exposes
// only SHA-256 hashes, which are not usable as API keys without the preimage.
//
// this._plaintextApiKey is a temporary in-memory property set by the hook so
// createTenant can return it in the response. It is NOT a schema field and is
// never saved to MongoDB.
tenantSchema.pre("validate", function (next) {
  if (!this.apiKeyHash) {
    const rawKey = crypto.randomBytes(32).toString("hex");
    this._plaintextApiKey = rawKey; // transient — read once by createTenant, then gone
    this.apiKeyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  }
  next();
});

tenantSchema.set("toJSON", {
  transform: (doc, ret) => {
    // Strip all sensitive credential fields from every serialised Tenant.
    // apiKeyHash  — SHA-256 fingerprint; not the key but still sensitive
    // accessToken — AES-256-GCM encrypted WhatsApp token; must never leave the server
    // verifyToken — AES-256-GCM encrypted Meta webhook verify token; internal only
    // [FIX-RAWKEY] apiKey field removed from schema — no need to delete it here,
    // but we keep the delete as a safety net for any old documents still in the DB.
    if (ret.whatsapp) {
      delete ret.whatsapp.accessToken;
      delete ret.whatsapp.verifyToken;
    }
    delete ret.apiKey;     // safety net for legacy documents
    delete ret.apiKeyHash;
    delete ret.__v;
    return ret;
  }
});

export default mongoose.model("Tenant", tenantSchema);
