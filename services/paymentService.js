/**
 * services/paymentService.js — WhatsBotLyn v5.0
 *
 * Wave mobile money payment flow — WhatsApp only.
 *
 * Flow:
 *  1. Order confirmed in flowService → paymentService.initiatePayment()
 *     Bot sends Wave instructions + payment reference to customer
 *  2. Customer sends Wave screenshot image
 *     webhookController routes image → paymentService.receiveProof()
 *  3. Order status → payment_pending_verification
 *     Admin gets WhatsApp alert with order details
 *  4. Admin calls POST /business/payment/:orderId/confirm or /reject
 *  5. On confirm: order = paid, customer notified via WhatsApp
 *  6. On reject:  order = payment_failed, customer asked to retry
 *
 * v5.0 improvements:
 * [PAY-1] Payment reference includes date prefix (e.g. WBL-0501-AB12) for easier tracking.
 * [PAY-2] initiatePayment is idempotent — calling it twice doesn't double-create.
 * [PAY-3] receiveProof auto-expires stale unpaid orders older than 24h.
 * [PAY-4] confirmPayment broadcasts to admin channel (log) with reviewer identity.
 * [PAY-5] getPendingPayments returns enriched objects with age (minutes pending).
 * [PAY-6] Exported buildPaymentInstructions for use in messageBuilders too.
 * [PAY-7] requireProof=false path: customer types DONE and order is verified inline.
 */

import Order          from '../models/Order.js';
import BusinessConfig from '../models/BusinessConfig.js';
import Tenant         from '../models/Tenant.js';
import { updateSession } from './sessionService.js';
import { getLabel }   from '../config/modes.js';
import logger         from '../config/logger.js';
// Lazy import to avoid circular dep (adminPaymentHandler → messageService → paymentService)
const getAdminHandler = () => import('./adminPaymentHandler.js');

// ─── Payment reference generator ─────────────────────────────────────────────
// [PAY-1] Format: WBL-MMDD-XXXX (date + last 4 of ObjectId)
const buildRef = (order) => {
  const now   = new Date();
  const mmdd  = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  const tail  = String(order._id).slice(-4).toUpperCase();
  return `WBL-${mmdd}-${tail}`;
};

// ─── BUILD PAYMENT INSTRUCTIONS MESSAGE ──────────────────────────────────────
export const buildPaymentInstructions = (order, business) => {
  const currency     = business?.payment?.currency    || 'GMD';
  // [FIX-5] payment.wavePhone is canonical; top-level wavePhone is the legacy fallback
  // used by createBusiness/updateBusiness. Check both so neither path silently fails.
  const wavePhone    = business?.payment?.wavePhone?.trim()
                    || business?.wavePhone?.trim()
                    || 'Not configured — contact the business';
  const requireProof = business?.payment?.requireProof !== false;
  const amount       = order.totalPrice || 0;
  const ref          = buildRef(order);

  let msg =
    `💳 *Payment Instructions*\n\n` +
    `📦 *${order.item}* × ${order.quantity}\n` +
    `💰 Total: *${currency} ${amount}*\n` +
    `🔖 Reference: *${ref}*\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `📲 Send *${currency} ${amount}* via *Wave* to:\n\n` +
    `📱 *${wavePhone}*\n\n` +
    `⚠️ Use *${ref}* as your payment reference.\n` +
    `━━━━━━━━━━━━━━━━\n`;

  if (requireProof) {
    msg +=
      `\nAfter sending, please *reply with a screenshot* of your Wave confirmation.\n\n` +
      `We'll verify and confirm your order shortly ✅`;
  } else {
    msg +=
      `\nOnce you've sent the payment, reply *DONE* and we'll confirm your order ✅`;
  }

  return msg;
};

// ─── INITIATE PAYMENT ─────────────────────────────────────────────────────────
// [PAY-2] Idempotent — if already initiated, just returns current instructions.
export const initiatePayment = async (orderId, business) => {
  const existing = await Order.findById(orderId);
  if (!existing) throw new Error(`Order not found: ${orderId}`);

  // Already initiated — return current instructions without re-setting
  if (existing.paymentStatus === 'payment_pending_verification') {
    return buildPaymentInstructions(existing, business);
  }

  const order = await Order.findByIdAndUpdate(
    orderId,
    { $set: { paymentMethod: 'wave', paymentStatus: 'unpaid', paymentInitiatedAt: new Date() } },
    { new: true }
  );

  logger.info('[PaymentService] Payment initiated', { orderId, amount: order.totalPrice });
  return buildPaymentInstructions(order, business);
};

// ─── RECEIVE PROOF (screenshot from customer) ─────────────────────────────────
// [PAY-3] Ignores orders older than 24h to prevent ghost proof submissions.
// [PAY-8] Notifies admin via WhatsApp with proof image + Approve/Reject buttons.
export const receiveProof = async (customerPhone, tenantId, imageUrl, tenant = null, business = null) => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const order = await Order.findOneAndUpdate(
    {
      tenantId,
      customerPhone,
      // [A-2] Only accept proof when order is unpaid or already pending (idempotent re-upload)
      paymentStatus: { $in: ['unpaid', 'payment_pending_verification'] },
      // [A-2] Prevent re-uploading proof if already accepted
      paymentProof:  null,
      createdAt:     { $gte: cutoff },
    },
    {
      $set: {
        paymentProof:  imageUrl,
        paymentStatus: 'payment_pending_verification',
        status:        'pending',
        proofReceivedAt: new Date(),
      },
    },
    { new: true, sort: { createdAt: -1 } }
  );

  if (!order) {
    // Check if there's a pending order that already has a proof (duplicate upload)
    const existing = await Order.findOne({
      tenantId,
      customerPhone,
      paymentStatus: 'payment_pending_verification',
      paymentProof:  { $ne: null },
      createdAt:     { $gte: cutoff },
    }).lean();

    if (existing) {
      return (
        `✅ We already received your payment screenshot!\n\n` +
        `⏳ Your order *${existing.item} × ${existing.quantity}* is still being verified.\n\n` +
        `Please wait — we'll notify you shortly 🙏`
      );
    }

    return (
      `We couldn't find an active order for your account.\n\n` +
      `If your order is more than 24 hours old, please type *Order* to place a new one.`
    );
  }

  logger.info('[PaymentService] Screenshot received', { orderId: order._id, customerPhone });

  // [PAY-8] Notify admin(s) via WhatsApp with proof image + action buttons
  if (tenant) {
    try {
      let biz = business;
      if (!biz) {
        biz = await BusinessConfig.findOne({ tenantId }).lean();
      }
      const { notifyAdminOfPayment } = await getAdminHandler();
      // Fire-and-forget — don't block customer reply
      notifyAdminOfPayment(order, imageUrl, tenant, biz).catch((err) =>
        logger.error('[PaymentService] Admin notification failed', { err: err.message })
      );
    } catch (err) {
      logger.error('[PaymentService] Could not import adminPaymentHandler', { err: err.message });
    }
  }

  return (
    `✅ *Payment proof received!*\n\n` +
    `⏳ Your order *${order.item} × ${order.quantity}* is now awaiting verification.\n\n` +
    `We'll confirm shortly 🙏`
  );
};

// ─── HANDLE "DONE" (no-proof flow) ───────────────────────────────────────────
// [PAY-7] For businesses with requireProof=false — customer types DONE.
export const handleDonePayment = async (customerPhone, tenantId) => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const order  = await Order.findOneAndUpdate(
    {
      tenantId,
      customerPhone,
      paymentStatus: 'unpaid',
      createdAt:     { $gte: cutoff },
    },
    {
      $set: {
        paymentStatus: 'payment_pending_verification',
        status:        'pending',
        proofReceivedAt: new Date(),
      },
    },
    { new: true, sort: { createdAt: -1 } }
  );

  if (!order) {
    return `We couldn't find an active unpaid order. Type *Order* to start a new order.`;
  }

  logger.info('[PaymentService] Customer confirmed payment (no-proof)', { orderId: order._id });
  return (
    `✅ Got it! We'll verify your Wave payment for *${order.item}* shortly.\n\n` +
    `You'll receive confirmation here once approved 🙏`
  );
};

// ─── CONFIRM PAYMENT (admin action) ──────────────────────────────────────────
// [PAY-4] Logs reviewer identity for audit trail.
export const confirmPayment = async (orderId, tenantId, adminIdentifier) => {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, tenantId },
    {
      $set: {
        paymentStatus:     'paid',
        status:            'confirmed',
        paymentReviewedBy: adminIdentifier || 'admin',
        paymentReviewedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!order) throw new Error('Order not found or already processed');

  let business = null;
  try { business = await BusinessConfig.findOne({ tenantId }).lean(); } catch { /* use default */ }

  const customerMessage =
    getLabel(business, 'paymentConfirmed') ||
    `🎉 *Payment confirmed!*\n\n` +
    `Your order *${order.item} × ${order.quantity}* has been verified and confirmed!\n\n` +
    `We're now preparing it for you. Thank you! 😊`;

  logger.info('[PaymentService] Payment confirmed', { orderId, reviewer: adminIdentifier });
  return { order, customerMessage };
};

// ─── REJECT PAYMENT (admin action) ───────────────────────────────────────────
export const rejectPayment = async (orderId, tenantId, reason, adminIdentifier) => {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, tenantId },
    {
      $set: {
        paymentStatus:     'payment_failed', // [FIX-A] 'failed' NOT in Order.paymentStatus enum
        status:            'payment_failed', // [FIX-F] 'pending' left order in limbo
        paymentReviewedBy: adminIdentifier || 'admin',
        paymentReviewedAt: new Date(),
        rejectedNote:      reason || null,
      },
    },
    { new: true }
  );

  if (!order) throw new Error('Order not found');

  let business = null;
  try { business = await BusinessConfig.findOne({ tenantId }).lean(); } catch { /* use default */ }

  const base = getLabel(business, 'paymentRejected') ||
    `❌ *Payment not verified*\n\nWe couldn't verify your Wave payment for *${order.item}*.`;

  const customerMessage = reason
    ? `${base}\n\n📋 Reason: ${reason}\n\nPlease retry or type *Order* to start again.`
    : `${base}\n\nPlease check the amount and Wave number, then send your screenshot again.`;

  logger.warn('[PaymentService] Payment rejected', { orderId, reason, reviewer: adminIdentifier });
  return { order, customerMessage };
};

// ─── LIST PENDING PAYMENTS ────────────────────────────────────────────────────
// [PAY-5] Returns enriched objects with pending age in minutes.
export const getPendingPayments = async (tenantId) => {
  const orders = await Order.find({ tenantId, paymentStatus: 'payment_pending_verification' })
    .sort({ createdAt: -1 })
    .lean();

  const now = Date.now();
  return orders.map(o => ({
    ...o,
    minutesPending: Math.round((now - new Date(o.proofReceivedAt || o.createdAt).getTime()) / 60000),
  }));
};
