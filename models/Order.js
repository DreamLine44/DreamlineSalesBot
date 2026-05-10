/**
 * models/Order.js
 *
 * Stores customer orders with full payment lifecycle support.
 *
 * idempotencyKey: auto-generated UUID per order — prevents duplicate key errors
 * on the (tenantId, customerPhone, idempotencyKey) compound index.
 *
 * paymentStatus tracks Wave payment lifecycle:
 *   unpaid → payment_pending_verification → paid | payment_failed | refunded
 *
 * Note: 'failed' is retained as a backward-compat alias in the enum.
 */

import mongoose from "mongoose";
import { randomUUID } from "crypto";

const orderSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tenant",
    required: true,
    index: true,
  },

  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BusinessConfig",
    index: true,
  },

  customerPhone: { type: String, required: true, index: true },
  phone:         { type: String, index: true }, // legacy alias

  // Auto-generated UUID per order — ensures the unique (tenantId, customerPhone, idempotencyKey)
  // index is always satisfied. Prevents duplicate orders from button double-taps.
  idempotencyKey: {
    type:    String,
    default: () => randomUUID(),
  },

  item:     { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },

  totalPrice: { type: Number, default: null },

  status: {
    type: String,
    enum: ["pending", "payment_pending_verification", "confirmed", "completed", "cancelled", "rejected", "payment_failed"],
    default: "pending",
    index: true,
  },

  // ── Wave payment fields ──────────────────────────────────────────────────
  paymentMethod: {
    type: String,
    enum: ["wave", "cash", "card", null],
    default: null,
  },

  paymentStatus: {
    type: String,
    // 'payment_failed' is canonical. 'failed' is a backward-compat alias — do not remove.
    enum: ["unpaid", "payment_pending_verification", "paid", "payment_failed", "failed", "refunded", null],
    default: "unpaid",
  },

  // URL or WhatsApp media ID of the payment screenshot the customer sends
  paymentProof: {
    type: String,
    default: null,
  },

  // Timestamps for payment lifecycle
  paymentInitiatedAt: { type: Date, default: null },
  proofReceivedAt:    { type: Date, default: null },

  // Who reviewed the payment and when (set by admin confirm/reject)
  paymentReviewedBy: { type: String, default: null },
  paymentReviewedAt: { type: Date,   default: null },

  // Legacy aliases (ordersController uses verifiedBy/verifiedAt)
  verifiedBy:   { type: String, default: null },
  verifiedAt:   { type: Date,   default: null },
  rejectedNote: { type: String, default: null },

  // Free-text notes — editable via PATCH /business/orders/:id
  notes: { type: String, default: null },

  // Last 6 hex chars of _id, stored at creation time for O(1) admin lookups.
  // Admin commands like "APPROVE ABC123" resolve against this field via an index
  // instead of an unindexed $expr/$regexMatch scan on the ObjectId string.
  shortId: { type: String, index: true, default: null },

}, { timestamps: true });

// Compound index for admin queries: all pending-verification orders per tenant
orderSchema.index({ tenantId: 1, paymentStatus: 1, createdAt: -1 });

// Idempotency index — must be unique so duplicate button taps don't create double orders.
// The default: randomUUID() on the field means this is always populated and always unique.
orderSchema.index({ tenantId: 1, customerPhone: 1, idempotencyKey: 1 }, { unique: true });

// Compound index for fast admin commands: "APPROVE <shortId>" / "REJECT <shortId>".
// Covers the (tenantId, paymentStatus, shortId) triple used in adminPaymentHandler.
orderSchema.index({ tenantId: 1, paymentStatus: 1, shortId: 1 });

// Populate shortId (last 6 hex chars of _id) before the first save so admin commands
// like "APPROVE ABC123" can resolve via a simple indexed findOne({ shortId }) instead
// of an unindexed $expr/$regexMatch scan across the _id string.
orderSchema.pre('save', function (next) {
  if (!this.shortId) {
    this.shortId = String(this._id).slice(-6).toUpperCase();
  }
  next();
});

export default mongoose.model("Order", orderSchema);
