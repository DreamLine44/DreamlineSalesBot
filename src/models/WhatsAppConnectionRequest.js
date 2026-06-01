/**
 * models/WhatsAppConnectionRequest.js
 *
 * Tracks each tenant's WhatsApp Business onboarding request.
 * Super Admins review these and manually provision credentials.
 *
 * Status lifecycle:
 *   pending → contacted → connecting → connected
 *                                   ↘ rejected
 *
 * This model is entirely additive — it does NOT touch Tenant, Session,
 * or any existing model. The existing bot continues operating unchanged.
 */
import mongoose from 'mongoose';

const CONNECTION_STATUSES = ['pending', 'contacted', 'connecting', 'connected', 'rejected'];

const whatsAppConnectionRequestSchema = new mongoose.Schema(
  {
    // ── Tenant reference ────────────────────────────────────────────────────
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },

    // ── Business information (filled by tenant) ─────────────────────────────
    businessName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    businessCategory: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    whatsappNumber: {
      type: String,
      required: true,
      trim: true,
      // E.164 format recommended but not enforced server-side — Meta validates it
      maxlength: 20,
    },

    contactPerson: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    contactEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 200,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'contactEmail must be a valid email address'],
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },

    // ── Status lifecycle ────────────────────────────────────────────────────
    status: {
      type: String,
      enum: CONNECTION_STATUSES,
      default: 'pending',
      index: true,
    },

    // ── Admin fields ────────────────────────────────────────────────────────
    adminNotes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },

    reviewedBy: {
      type: String, // Super-admin identifier (e.g. email or username stored in env/context)
      trim: true,
      default: null,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
    collection: 'whatsappconnectionrequests',
  },
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// Each tenant may have at most ONE active (non-rejected) request at a time.
// We enforce uniqueness in application logic; the compound index below supports
// fast lookups by tenantId + status.
whatsAppConnectionRequestSchema.index({ tenantId: 1, status: 1 });
whatsAppConnectionRequestSchema.index({ createdAt: -1 }); // admin list — newest first

// ── Virtual: friendly status label ──────────────────────────────────────────
whatsAppConnectionRequestSchema.virtual('statusLabel').get(function () {
  const labels = {
    pending:    'Pending Review',
    contacted:  'Admin Contacted',
    connecting: 'Connecting',
    connected:  'Connected',
    rejected:   'Rejected',
  };
  return labels[this.status] || this.status;
});

whatsAppConnectionRequestSchema.set('toJSON', { virtuals: true });

export const CONNECTION_STATUS_ENUM = CONNECTION_STATUSES;
export default mongoose.model('WhatsAppConnectionRequest', whatsAppConnectionRequestSchema);
