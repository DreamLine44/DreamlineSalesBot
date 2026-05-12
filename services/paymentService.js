/**
 * services/paymentService.js — DreamLine SalesBot v13.0
 *
 * Wave mobile money payment flow — WhatsApp only.
 *
 * v13.0 FIXES over v5.0:
 * [PAY-F1] rejectPayment() now resets paymentProof → null so the customer can
 *          re-upload a screenshot after rejection. Previously paymentProof stayed
 *          set, causing receiveProof's `paymentProof: null` guard to silently miss
 *          the order on retry → "couldn't find an active order" error.
 *
 * [PAY-F2] receiveProof() query now includes `payment_failed` in the status filter.
 *          After a rejection, status is set to `payment_failed` — the old query only
 *          accepted `unpaid` and `payment_pending_verification`, so rejected-then-
 *          retried uploads always fell through to the "no active order" branch.
 *
 * [PAY-F3] receiveProof() falls back to conversationMemoryService when the primary
 *          query finds nothing — catches orders where TTL expired the session but
 *          the order is still active. Provides a graceful "We found your order"
 *          path instead of "couldn't find an active order."
 *
 * [PAY-F4] buildPaymentInstructions() now includes the order ID in an internal
 *          anchor comment so admin-side tooling can cross-reference screenshots.
 *
 * [PAY-F5] initiatePayment() persists the paymentReference on the Order document
 *          so downstream code (admin alerts, re-prompts) always shows a consistent
 *          reference rather than regenerating it with a different timestamp.
 *
 * Original v5.0 features preserved:
 * [PAY-1] Payment reference date prefix (DSB-MMDD-XXXX)
 * [PAY-2] initiatePayment is idempotent
 * [PAY-3] receiveProof auto-expires stale unpaid orders older than cutoff
 * [PAY-4] confirmPayment logs reviewer identity
 * [PAY-5] getPendingPayments returns enriched objects with age (minutes pending)
 * [PAY-6] Exported buildPaymentInstructions
 * [PAY-7] requireProof=false path: customer types DONE
 * [PAY-8] Admin notified via WhatsApp with proof image + Approve/Reject buttons
 */

import Order          from '../models/Order.js';
import BusinessConfig from '../models/BusinessConfig.js';
import Tenant         from '../models/Tenant.js';
import { getLabel }   from '../config/modes.js';
import logger         from '../config/logger.js';
import {
  findActiveOrderForProof,
  findPendingVerification,
} from './conversationMemoryService.js';

// Lazy import to avoid circular dep (adminPaymentHandler → messageService → paymentService)
const getAdminHandler = () => import('./adminPaymentHandler.js');

// ─── Proof eligibility window ─────────────────────────────────────────────────
// [PAY-F3] Extended from 24h to match conversationMemoryService.PROOF_ELIGIBLE_HOURS.
// Env var PROOF_ELIGIBLE_HOURS controls both services in sync.
const PROOF_ELIGIBLE_HOURS = parseInt(process.env.PROOF_ELIGIBLE_HOURS, 10) || 48;

// ─── Payment reference generator ─────────────────────────────────────────────
// [PAY-1] Format: DSB-MMDD-XXXX (date + last 4 of ObjectId)
const buildRef = (order) => {
  const now   = new Date();
  const mmdd  = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  const tail  = String(order._id).slice(-4).toUpperCase();
  return `DSB-${mmdd}-${tail}`;
};

// ─── BUILD PAYMENT INSTRUCTIONS MESSAGE ──────────────────────────────────────
export const buildPaymentInstructions = (order, business) => {
  const currency     = business?.payment?.currency    || 'GMD';
  const wavePhone    = business?.payment?.wavePhone?.trim()
                    || business?.wavePhone?.trim()
                    || 'Not configured — contact the business';
  const requireProof = business?.payment?.requireProof !== false;
  const amount       = order.totalPrice || 0;
  // [PAY-F5] Use stored reference if already set, otherwise generate one
  const ref          = order.paymentReference || buildRef(order);

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
// [PAY-2] Idempotent — if already initiated, returns current instructions.
// [PAY-F5] Stores the generated reference on the Order so it never changes.
export const initiatePayment = async (orderId, business) => {
  const existing = await Order.findById(orderId);
  if (!existing) throw new Error(`Order not found: ${orderId}`);

  // Already initiated — return current instructions without re-setting
  if (existing.paymentStatus === 'payment_pending_verification') {
    return buildPaymentInstructions(existing, business);
  }

  // [PAY-F5] Generate and persist the reference at initiation time
  const ref = buildRef(existing);
  const order = await Order.findByIdAndUpdate(
    orderId,
    {
      $set: {
        paymentMethod:       'wave',
        paymentStatus:       'unpaid',
        paymentInitiatedAt:  new Date(),
        paymentReference:    ref,   // [PAY-F5] stored so it never drifts
      },
    },
    { new: true }
  );

  logger.info('[PaymentService] Payment initiated', { orderId, amount: order.totalPrice, ref });
  return buildPaymentInstructions(order, business);
};

// ─── RECEIVE PROOF (screenshot from customer) ─────────────────────────────────
// [PAY-F1] Status filter expanded to include 'payment_failed' (retry after rejection)
// [PAY-F2] paymentProof: null check preserved to prevent double-acceptance
// [PAY-F3] Falls back to conversationMemoryService if primary query finds nothing
export const receiveProof = async (customerPhone, tenantId, imageUrl, tenant = null, business = null, sessionOrderId = null) => {
  const cutoff = new Date(Date.now() - PROOF_ELIGIBLE_HOURS * 60 * 60 * 1000);

  // ── Primary query: use session-anchored orderId when available ────────────
  // sessionOrderId is passed from webhookController when the session still has
  // the orderId stored (active PAYMENT_PROOF step or rejection-resend). Using
  // _id is the most precise lookup — prevents any cross-customer collisions
  // when two customers of the same tenant place orders close together.
  const primaryFilter = sessionOrderId
    ? {
        _id:           sessionOrderId,
        tenantId,
        customerPhone,
        paymentStatus: { $in: ['unpaid', 'payment_failed', 'payment_pending_verification'] },
        paymentProof:  null,
      }
    : {
        tenantId,
        customerPhone,
        // [PAY-F1] Include payment_failed so rejected orders can receive a new proof
        paymentStatus: { $in: ['unpaid', 'payment_failed', 'payment_pending_verification'] },
        paymentProof:  null,   // [PAY-F2] only if no proof stored yet
        createdAt:     { $gte: cutoff },
      };

  const order = await Order.findOneAndUpdate(
    primaryFilter,
    {
      $set: {
        paymentProof:    imageUrl,
        paymentStatus:   'payment_pending_verification',
        status:          'pending',
        proofReceivedAt: new Date(),
      },
    },
    { new: true, sort: { createdAt: -1 } }
  );

  if (!order) {
    // ── Duplicate-upload guard ────────────────────────────────────────────
    const alreadyPending = await findPendingVerification(customerPhone, tenantId);
    if (alreadyPending) {
      return (
        `✅ We already received your payment screenshot!\n\n` +
        `⏳ Your order *${alreadyPending.item} × ${alreadyPending.quantity}* is still being verified.\n\n` +
        `Please wait — we'll notify you shortly 🙏`
      );
    }

    // ── [PAY-F3] Memory fallback: session expired but order still active ──
    // This handles the case where a customer takes >30 min (session TTL) to
    // pay and then sends their screenshot. Their session is gone but the order
    // is still in the DB and eligible. We use conversationMemoryService to find
    // it, then do the update manually.
    const memOrder = await findActiveOrderForProof(customerPhone, tenantId);
    if (memOrder) {
      logger.info('[PaymentService] Proof linked via memory fallback', {
        orderId: memOrder._id,
        customerPhone,
      });

      const updated = await Order.findByIdAndUpdate(
        memOrder._id,
        {
          $set: {
            paymentProof:    imageUrl,
            paymentStatus:   'payment_pending_verification',
            status:          'pending',
            proofReceivedAt: new Date(),
          },
        },
        { new: true }
      );

      if (updated) {
        await _notifyAdmin(updated, imageUrl, tenant, tenantId, business);
        return (
          `✅ *Payment proof received!*\n\n` +
          `⏳ Your order *${updated.item} × ${updated.quantity}* is now awaiting verification.\n\n` +
          `We'll confirm shortly 🙏`
        );
      }
    }

    // ── No order found at all ────────────────────────────────────────────
    return (
      `I couldn't reconnect your latest order 😅\n\n` +
      `If your order is more than ${PROOF_ELIGIBLE_HOURS} hours old, please type *Order* to place a new one.\n\n` +
      `Or type *support* if you need help.`
    );
  }

  logger.info('[PaymentService] Screenshot received', { orderId: order._id, customerPhone });

  await _notifyAdmin(order, imageUrl, tenant, tenantId, business);

  return (
    `✅ *Payment proof received!*\n\n` +
    `⏳ Your order *${order.item} × ${order.quantity}* is now awaiting verification.\n\n` +
    `We'll confirm shortly 🙏`
  );
};

// ─── Admin notification (shared by receiveProof paths) ────────────────────────
async function _notifyAdmin(order, imageUrl, tenant, tenantId, business) {
  if (!tenant) return;
  try {
    let biz = business;
    if (!biz) biz = await BusinessConfig.findOne({ tenantId }).lean();
    const { notifyAdminOfPayment } = await getAdminHandler();
    notifyAdminOfPayment(order, imageUrl, tenant, biz).catch((err) =>
      logger.error('[PaymentService] Admin notification failed', { err: err.message })
    );
  } catch (err) {
    logger.error('[PaymentService] Could not import adminPaymentHandler', { err: err.message });
  }
}

// ─── HANDLE "DONE" (no-proof flow) ───────────────────────────────────────────
// [PAY-7] For businesses with requireProof=false — customer types DONE.
export const handleDonePayment = async (customerPhone, tenantId) => {
  const cutoff = new Date(Date.now() - PROOF_ELIGIBLE_HOURS * 60 * 60 * 1000);
  const order  = await Order.findOneAndUpdate(
    {
      tenantId,
      customerPhone,
      paymentStatus: 'unpaid',
      createdAt:     { $gte: cutoff },
    },
    {
      $set: {
        paymentStatus:   'payment_pending_verification',
        status:          'pending',
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

  if (!order) {
    const err = new Error('Order not found or already processed');
    err.statusCode = 404;
    throw err;
  }

  // Clear memory anchor — order is now in terminal state
  const { clearOrderAnchor } = await import('./conversationMemoryService.js');
  clearOrderAnchor(order._id).catch(() => {});

  let business = null;
  try { business = await BusinessConfig.findOne({ tenantId }).lean(); } catch { /* use default */ }

  const customerMessage =
    getLabel(business, 'paymentConfirmed') ||
    `✅ *Payment Confirmed*\n\n` +
    `Thank you — your payment has been verified successfully.\n\n` +
    `🍽️ Your order *${order.item} × ${order.quantity}* is now being prepared.\n` +
    `📦 Estimated preparation time: *20–30 minutes*.\n\n` +
    `We'll notify you once your order is ready. Thank you for choosing us! 🙏`;

  logger.info('[PaymentService] Payment confirmed', { orderId, reviewer: adminIdentifier });
  return { order, customerMessage };
};

// ─── REJECT PAYMENT (admin action) ───────────────────────────────────────────
// [PAY-F1] Critical fix: reset paymentProof → null so the customer can re-upload.
//          Without this, the next receiveProof() call would find `paymentProof: { $ne: null }`
//          and silently miss the order, returning "couldn't find an active order."
export const rejectPayment = async (orderId, tenantId, reason, adminIdentifier) => {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, tenantId },
    {
      $set: {
        paymentStatus:     'payment_failed',
        status:            'payment_failed',
        paymentReviewedBy: adminIdentifier || 'admin',
        paymentReviewedAt: new Date(),
        rejectedNote:      reason || null,
        // [PAY-F1] CRITICAL: reset proof so customer can re-upload
        paymentProof:      null,
      },
    },
    { new: true }
  );

  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }

  let business = null;
  try { business = await BusinessConfig.findOne({ tenantId }).lean(); } catch { /* use default */ }

  const base = getLabel(business, 'paymentRejected') ||
    `❌ *Payment Could Not Be Verified*\n\nUnfortunately, we could not confirm your payment for *${order.item} × ${order.quantity}* (Order #${String(order._id).slice(-6).toUpperCase()}).`;

  const reasonLine = reason ? `\n\n📋 *Reason:* ${reason}` : '';

  const customerMessage =
    `${base}${reasonLine}\n\n` +
    `Please choose what you'd like to do:`;

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
