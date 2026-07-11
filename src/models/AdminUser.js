/**
 * models/AdminUser.js
 *
 * [FEATURE-MULTIADMIN-1] Individual staff logins for the Tenant Dashboard.
 *
 * This is deliberately SEPARATE from the existing Tenant.apiKeyHash auth model,
 * not a replacement:
 *   - Tenant.apiKeyHash — one shared key per tenant, used for server-to-server /
 *     script access and backward compatibility. Continues to work unchanged.
 *   - AdminUser — individual, named, revocable logins for people. Each has their
 *     own email/password and role, so "who changed the menu on Tuesday" and
 *     "revoke just this one person's access" are both answerable — neither is
 *     possible with a single shared tenant-wide key.
 *
 * Password storage mirrors the security posture already established for
 * WhatsApp credentials elsewhere in this codebase (see tenantController.js
 * encryptToken/apiKeyHash): never store anything that lets a DB breach recover
 * the original secret. Passwords use scrypt (Node's built-in, no new
 * dependency — consistent with the rest of this codebase avoiding npm crypto
 * libs in favor of the standard library) with a random per-user salt.
 */
import mongoose from 'mongoose';

const adminUserSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant',
    required: true,
    index: true,
  },

  name: { type: String, required: true, trim: true, maxlength: 80 },

  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },

  // scrypt output, hex-encoded. Null while status='INVITED' and the invitee
  // hasn't set a password yet.
  passwordHash: { type: String, default: null },
  // Random per-user salt, hex-encoded. Generated once at invite time.
  passwordSalt: { type: String, required: true },

  role: {
    type: String,
    // OWNER   — full access, only role that can invite/remove/re-role other
    //           admins or change billing-adjacent settings. The tenant's
    //           original creator is auto-assigned OWNER.
    // MANAGER — full operational access (menu, orders, bookings, settings)
    //           but cannot manage other admins.
    // STAFF   — day-to-day access (orders, bookings, conversations) but
    //           cannot edit business settings/menu/payment config.
    // Route-level enforcement lives in middleware/adminAuthMiddleware.js —
    // this field is the source of truth, not a UI-only label.
    enum: ['OWNER', 'MANAGER', 'STAFF'],
    default: 'STAFF',
  },

  status: {
    type: String,
    // INVITED  — created by an OWNER, no password set yet, cannot log in.
    // ACTIVE   — password set, can log in normally.
    // DISABLED — access revoked by an OWNER; login and all sessions rejected,
    //            but the record is kept (not deleted) for audit history.
    enum: ['INVITED', 'ACTIVE', 'DISABLED'],
    default: 'INVITED',
    index: true,
  },

  // Random token (hex), hashed with SHA-256 before storage — same
  // "never persist the raw secret" pattern as Tenant.apiKeyHash. Presented
  // once in the invite link/message, consumed by POST /auth/accept-invite.
  inviteTokenHash: { type: String, default: null },
  inviteExpiresAt: { type: Date, default: null },

  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },

  lastLoginAt: { type: Date, default: null },

}, { timestamps: true });

// One email per tenant — the same person's email could legitimately manage
// two different tenants (e.g. an agency), so this is NOT a globally unique
// index, only unique within a tenant.
adminUserSchema.index({ tenantId: 1, email: 1 }, { unique: true });

export default mongoose.model('AdminUser', adminUserSchema);
