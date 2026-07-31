/**
 * models/AdminNotification.js  [ADMIN-NOTIFY-1]
 *
 * Two-way messaging between the platform super admin and a tenant's admin
 * users, surfaced in both dashboards. This is deliberately a flat,
 * per-recipient collection rather than a single doc with a recipients[]
 * array — every row is "one message, one tenant" so read/unread state,
 * WhatsApp-ping state, and pagination are all plain per-document fields
 * with no nested-array update gymnastics (same reasoning already applied
 * to `promotions` on BusinessConfig vs. a shared collection).
 *
 * Broadcasts (super admin → all tenants) are NOT a single doc with
 * tenantId=null. They're fanned out at creation time into one doc per
 * tenant, all sharing a `broadcastId`, so:
 *   - a tenant's inbox query (`{ tenantId }`) never needs special-casing
 *     for "was this a broadcast or a direct message"
 *   - the super admin can still see aggregate delivery/read stats for one
 *     broadcast via `{ broadcastId }`
 *
 * direction:
 *   TO_TENANT — sent by the super admin, read by the tenant's admin(s)
 *   TO_ADMIN  — sent by a tenant admin, read by the super admin
 *
 * This model never touches Session, flow state, or any bot-facing
 * collection — it's purely a dashboard/admin-console concern. The one
 * exception is a best-effort WhatsApp nudge (see adminRoutes.js
 * pingTenantAdmin()) for TO_TENANT messages, which reuses the existing
 * dispatch pipeline exactly the way order/booking status changes already
 * do — fire-and-forget, never blocking the notification write itself.
 */
import mongoose from 'mongoose';

const DIRECTIONS = ['TO_TENANT', 'TO_ADMIN'];
const SEVERITIES = ['info', 'warning', 'urgent'];

const adminNotificationSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },

    direction: {
      type: String,
      enum: DIRECTIONS,
      required: true,
    },

    // Groups fan-out siblings from one broadcast send. Null for a direct
    // (non-broadcast) message.
    broadcastId: {
      type: String,
      default: null,
      index: true,
    },

    // Set only when the sender authenticated via an AdminUser Bearer token
    // (see middleware/authMiddleware.js tryBearerAuth) — null for super-admin sends and
    // for legacy shared-tenant-API-key sends (which predate individual
    // logins and have no single "who sent this" identity).
    fromAdminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminUser',
      default: null,
    },

    // Display name shown in the inbox — captured at send time rather than
    // populated live, so a message still reads sensibly even if the
    // sending AdminUser is later renamed or removed.
    fromLabel: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },

    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },

    severity: {
      type: String,
      enum: SEVERITIES,
      default: 'info',
    },

    read: {
      type: Boolean,
      default: false,
      index: true,
    },

    readAt: {
      type: Date,
      default: null,
    },

    // [ADMIN-NOTIFY-1] Best-effort record of whether the WhatsApp nudge was
    // actually sent — lets the super admin console show "delivered via
    // dashboard only" vs "also pinged on WhatsApp" without re-deriving it.
    whatsappPinged: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Primary inbox query for both roles: "this tenant's thread, newest first,
// optionally unread-only" — see buildNotificationAccessFilter() in
// adminRoutes.js.
adminNotificationSchema.index({ tenantId: 1, direction: 1, read: 1, createdAt: -1 });

export const NOTIFICATION_DIRECTIONS = DIRECTIONS;
export const NOTIFICATION_SEVERITIES = SEVERITIES;

export default mongoose.model('AdminNotification', adminNotificationSchema);
