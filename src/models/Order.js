/**
 * models/Order.js
 *
 * Stores customer orders with full payment lifecycle support.
 *
 * idempotencyKey: auto-generated UUID per order — prevents duplicate key errors
 * on the (tenantId, customerPhone, idempotencyKey) compound index.
 *
 * paymentStatus tracks payment lifecycle (screenshot-based, admin-confirmed):
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

  // [FIX-SAVE-1] customerName — supplied by all module saveOrder() callers but
  // previously absent from this schema. Mongoose strict mode silently dropped the
  // field on every Order.create(), so customer names were never persisted.
  // Used for admin alerts ("New order from Fatou") and dashboard order lists.
  customerName: { type: String, default: null, trim: true, maxlength: 80 },

  // Auto-generated UUID per order — ensures the unique (tenantId, customerPhone, idempotencyKey)
  // index is always satisfied. Prevents duplicate orders from button double-taps.
  idempotencyKey: {
    type:    String,
    default: () => randomUUID(),
  },

  item:     { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },

  // [FIX-I] addOns was written by orderService.saveOrder() and orderFlow.js
  // (data.addOns) but was absent from the schema — Mongoose strict mode silently
  // dropped every write. Upsell add-on names were never persisted to the order record.
  addOns: { type: [String], default: [] },

  // [FIX-CATALOG-CART-2] Multi-item cart line items — populated when an order
  // was placed via a cart flow (e.g. WA Catalog consolidation) rather than a
  // single item/quantity pair. item/quantity/addOns on the parent order still
  // mirror items[0] (see orderService.resolveOrderFields()) so every existing
  // dashboard/analytics/getLastOrderItem reader keeps working unchanged.
  items: {
    type: [{
      item:     { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      unitPrice: { type: Number, default: null },
      addOns:   { type: [String], default: [] },
      // menuItemId — produced by every cart-line builder (waCatalogHelpers.
      // buildCatalogCartItems(), and the CATALOG-STOCK-1 menuItemId every
      // per-vertical orderFlow.js passes) but previously missing from this
      // subdocument schema — Mongoose strict mode silently dropped it on
      // every save. Same recurring "field missing from schema" bug class as
      // variants/customerName/notes/addOns/staff earlier in this codebase's
      // history.
      menuItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    }],
    default: [],
  },

  totalPrice: { type: Number, default: null },

  // [AUDIT-FIX-PROMO-SCHEMA] Set by saveOrder() when a caller supplies a valid
  // promoCode (see promoService.js). null/0 for every order that doesn't use one —
  // zero behavior or schema change for existing callers.
  promoCode:      { type: String, default: null },
  discountAmount: { type: Number, default: 0 },

  status: {
    type: String,
    // [FIX-4] Added 'ready', 'preparing', 'out_for_delivery', 'delivered' — all four were
    // used in activeOrderResolver queries and/or written by adminCommandService.markOrderReady
    // but absent from the enum. Mongoose strict mode silently drops $set operations that use
    // a value not in the enum — so markOrderReady()'s `status: 'ready'` write was a no-op,
    // leaving every "marked ready" order permanently stuck at 'confirmed' in the DB.
    // 'preparing', 'out_for_delivery', 'delivered' are queried by activeOrderResolver and
    // planned admin command paths — including them now prevents the same silent-drop bug
    // when those paths are implemented.
    enum: [
      "pending",
      "payment_pending_verification",
      "confirmed",
      "preparing",          // [FIX-4] order in kitchen
      "ready",              // [FIX-4] ready for collection (written by markOrderReady)
      "out_for_delivery",   // [FIX-4] dispatched for delivery
      "delivered",          // [FIX-4] delivered to customer
      "completed",
      "cancelled",
      "rejected",
      "payment_failed",
    ],
    default: "pending",
    index: true,
  },

  // ── Payment fields — supports multi-channel screenshot-based verification ───
  paymentMethod: {
    type: String,
    // Supported channels: customer sends screenshot, admin confirms manually.
    // "wave" kept as canonical value; new channels added alongside it.
    enum: ["wave", "gt_bank", "ecobank", "trust_bank", "cash", "card", "other", null],
    default: null,
  },

  paymentStatus: {
    type: String,
    // Keep ALL values that are written anywhere in the codebase.
    // Mongoose strict mode silently drops $set operations that use a value
    // not in this enum — which breaks every payment state transition.
    //   proof_received      — paymentService.receiveProof (customer sent screenshot)
    //   self_confirmed      — paymentService.handleDonePayment (requireProof=false)
    //   confirmed           — adminCommandService.confirmPayment (admin approved)
    //   rejected            — adminCommandService.rejectPayment (admin rejected)
    //   payment_failed      — canonical failure status
    //   failed              — backward-compat alias; do not remove
    //   cancelled           — set when customer cancels at PAYMENT_PROOF step
    //                         (webhookController step 10.5). Without this value
    //                         Mongoose strict mode silently drops the $set and
    //                         the order stays 'unpaid', causing the scheduler to
    //                         send payment reminders for cancelled orders.
    enum: [
      'unpaid',
      'proof_received',
      'payment_pending_verification',
      'self_confirmed',
      'confirmed',
      'paid',
      'rejected',
      'payment_failed',
      'failed',
      'refunded',
      'cancelled',
      null,
    ],
    default: 'unpaid',
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

  // [FIX] Stored payment reference (DSB-MMDD-XXXX) generated at initiation time.
  // paymentService.initiatePayment() writes this so the reference never drifts
  // between the initial instructions and any follow-up messages. Without this
  // field in the schema, Mongoose strict mode silently drops the $set and the
  // stored reference is always null — falling back to a freshly-generated ref
  // that may differ from the one already shown to the customer.
  paymentReference: { type: String, default: null },

  // [FIX] Set by schedulerService when a payment-reminder WhatsApp template is sent.
  // Acts as an idempotency flag — without this in the schema, Mongoose strict
  // mode drops the $set, causing the scheduler to re-message every run.
  paymentReminderSentAt: { type: Date, default: null },

  // Set by schedulerService when an abandoned-cart WhatsApp template is sent.
  // Acts as an idempotency flag — without this in the schema, Mongoose strict
  // mode drops the $set, causing the scheduler to re-message the same customer
  // on every run.
  abandonedCartAt: { type: Date, default: null },

  // [FIX-5] Lifecycle timestamps written by adminCommandService and webhookController.
  // Previously absent from schema — Mongoose strict mode silently dropped every write,
  // so readyAt and completedAt were always null in the DB even when set by admin commands.
  preparingAt:    { type: Date, default: null }, // set when status → preparing
  readyAt:        { type: Date, default: null }, // set by markOrderReady()
  outForDeliveryAt: { type: Date, default: null }, // set when status → out_for_delivery
  completedAt:    { type: Date, default: null }, // set by COLLECTED_* handler / admin
  deliveredAt:    { type: Date, default: null }, // set when out_for_delivery → delivered

  // Last 6 hex chars of _id, stored at creation time for O(1) admin lookups.
  // Admin commands like "APPROVE ABC123" resolve against this field via an index
  // instead of an unindexed $expr/$regexMatch scan on the ObjectId string.
  // [AUDIT-FIX-1] cancelledBy / cancelledAt — written by moduleRouter.js's CANCEL
  // handler and flowEngine.js's cancelFlow() whenever a customer cancels an order,
  // but previously absent from this schema. Mongoose strict mode silently dropped
  // both fields on every cancel $set — status:'cancelled' saved correctly, but the
  // who/when audit trail was always lost. Admin dashboards and support tooling that
  // expect to see who cancelled an order and when got null/undefined forever.
  cancelledBy: { type: String, default: null }, // 'customer' | admin phone
  cancelledAt: { type: Date,   default: null },

  // Customer-initiated cash payment request (PAYMENT_PROOF step, requireProof=true).
  // cashRequestStatus tracks admin review; paymentStatus stays 'unpaid' until
  // payment is actually received (admin APPROVE_ on AWAIT_ADMIN_CONFIRM).
  cashRequestStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected', null],
    default: null,
  },
  cashRequestRequestedAt: { type: Date, default: null },
  cashRequestReviewedBy:  { type: String, default: null },
  cashRequestReviewedAt:  { type: Date, default: null },

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

// [AUDIT-FIX-TRACE-7] Compound index for customer-facing status lookups —
// activeOrderResolver.resolveActiveOrder(), the TRACK_ORDER action handler, and the
// step-14.6 quick STATUS command in webhookController all query
// Order.find/findOne({ customerPhone, tenantId, status: ... }).sort({ createdAt: -1 }).
// Without this index those queries fall back to the (tenantId, customerPhone,
// idempotencyKey) unique index, which does not cover a createdAt sort — Mongo
// would do an in-memory sort per lookup. This mirrors the equivalent index already
// present on the Booking model (bookingSchema.index({ tenantId, customerPhone,
// createdAt: -1 })) so both collections are indexed the same way for the same
// "does this customer have anything active?" access pattern.
orderSchema.index({ tenantId: 1, customerPhone: 1, createdAt: -1 });

// Populate shortId (last 6 hex chars of _id) before the first save so admin commands
// like "APPROVE ABC123" can resolve via a simple indexed findOne({ shortId }) instead
// of an unindexed $expr/$regexMatch scan across the _id string.
orderSchema.pre('save', function (next) {
  if (!this.shortId) {
    this.shortId = String(this._id).slice(-6).toUpperCase();
  }
  next();
});

// [FIX-8] pre('save') does not fire on insertMany(). Add a pre('insertMany') hook as
// a defensive measure so bulk-created orders still get shortIds. Currently no code
// path calls Order.insertMany(), but this prevents a future silent shortId=null bug
// if bulk creation is ever added (e.g. import tooling, seed scripts, migration jobs).
orderSchema.pre('insertMany', function (next, docs) {
  if (Array.isArray(docs)) {
    for (const doc of docs) {
      if (!doc.shortId && doc._id) {
        doc.shortId = String(doc._id).slice(-6).toUpperCase();
      }
    }
  }
  next();
});

export default mongoose.model("Order", orderSchema);
