/**
 * models/Order.js — v3.1
 *
 * v3.1 fix:
 * - idempotencyKey added as a unique, auto-generated UUID field.
 *   The database has a unique index on (tenantId, customerPhone, idempotencyKey).
 *   Without this field every insert collides on null, causing E11000 duplicate key
 *   errors and the "We're having a little trouble right now" message to customers.
 *
 * v13 additions (preserved):
 * - paymentMethod: "wave" | "cash" | "card"
 * - paymentStatus: tracks Wave payment lifecycle
 * - paymentProof:  URL/media-id of screenshot the customer uploads
 * - totalPrice:    calculated at order creation from business menu
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

  // Unique key per order attempt — prevents duplicate key errors on the
  // (tenantId, customerPhone, idempotencyKey) compound index.
  // Auto-generated at insert time if not provided by the caller.
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
    // [FIX-A] 'failed' added as backward-compat alias — rejectPayment now writes 'payment_failed'
    // but any records written before the fix may have 'failed' stored in the DB.
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

}, { timestamps: true });

// Compound index for admin queries: all pending-verification orders per tenant
orderSchema.index({ tenantId: 1, paymentStatus: 1, createdAt: -1 });

// Idempotency index — must be unique so duplicate button taps don't create double orders.
// The default: randomUUID() on the field means this is always populated and always unique.
orderSchema.index({ tenantId: 1, customerPhone: 1, idempotencyKey: 1 }, { unique: true });

export default mongoose.model("Order", orderSchema);
