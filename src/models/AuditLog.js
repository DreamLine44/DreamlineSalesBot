/**
 * models/AuditLog.js
 *
 * Structured, queryable audit trail for every significant order lifecycle event.
 *
 * All writes go through auditService.logAudit() which is always fire-and-forget.
 * A write failure here must NEVER block order processing — the audit trail is
 * supplementary, not a source of truth.
 *
 * Supported actions:
 *   order_created        — a new order was saved (orderService.saveOrder)
 *   payment_submitted    — customer sent payment proof (paymentService.receiveProof)
 *   payment_approved     — admin confirmed payment (adminCommandService.confirmPayment)
 *   payment_rejected     — admin rejected payment (adminCommandService.rejectPayment)
 *   customer_notified    — a customer-facing message was dispatched
 *   status_changed       — order fulfilment status advanced by admin
 *   rejection_noted      — admin added/updated a rejection reason
 *   order_cancelled      — order was cancelled by customer or admin
 *   order_completed      — order marked completed/delivered
 *   customer_frustration_flag — [FEAT-EMOTION-1] pre-flow frustration signal
 *                          strong/repeated enough to surface for admin follow-up
 */

import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  tenantId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Tenant',
    required: true,
    index:    true,
  },

  orderId: {
    type:   mongoose.Schema.Types.ObjectId,
    ref:    'Order',
    index:  true,
    default: null,
  },

  actor: {
    type:    String,
    enum:    ['admin', 'customer', 'system'],
    required: true,
  },

  actorId: {
    type:    String,   // phone number, 'system', or 'scheduler'
    default: null,
  },

  action: {
    type:    String,
    enum: [
      'order_created',
      'payment_submitted',
      'payment_approved',
      'payment_rejected',
      'customer_notified',
      'status_changed',
      'rejection_noted',
      'order_cancelled',
      'order_completed',
      // [FEAT-EMOTION-1] Pre-flow frustration signal strong/repeated enough to
      // warrant admin attention. Written by webhookController.js's emotion hook.
      'customer_frustration_flag',
    ],
    required: true,
    index:    true,
  },

  // Arbitrary JSON payload — e.g. { from: 'pending', to: 'preparing' } for status_changed
  metadata: {
    type:    mongoose.Schema.Types.Mixed,
    default: {},
  },

}, { timestamps: true });

// Primary query index: all audit events for a tenant in reverse-chronological order
auditLogSchema.index({ tenantId: 1, createdAt: -1 });

// Order-level history: all events for a specific order
auditLogSchema.index({ orderId: 1, createdAt: 1 });

export default mongoose.model('AuditLog', auditLogSchema);
