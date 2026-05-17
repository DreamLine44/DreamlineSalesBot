/**
 * services/adminPaymentHandler.js — Dreamline Sales Bot v5.1
 *
 * WhatsApp-only admin payment approval flow.
 * NO frontend required — admins approve/reject via WhatsApp button messages.
 *
 * Flow:
 *   1. Customer uploads payment screenshot
 *   2. paymentService.receiveProof() stores proof, updates order
 *   3. notifyAdminOfPayment() sends proof image + Approve/Reject buttons to admin
 *   4. Admin taps ✅ Approve or ❌ Reject
 *   5. handleAdminButtonReply() processes the decision
 *   6. Customer gets real-time notification
 *
 * Safety guarantees:
 *   [A-1] isAdminPhone()  — sender must be in ADMIN_PHONES list or business.adminPhone
 *   [A-2] Double-approve guard — only processes orders in payment_pending_verification
 *   [A-3] Idempotent — approve/reject on already-processed order returns graceful error
 *   [A-4] orderId always embedded in button IDs — no session state needed
 *   [A-5] Proof image forwarded as-is (WhatsApp media ID) — no re-upload needed
 */

import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { confirmPayment, rejectPayment } from './paymentService.js';
import { sendMessage, sendButtonMessage, dispatch } from './messageService.js';
import { updateSession, createSession, getSession } from './sessionService.js';
import { decrypt } from './cryptoService.js';
import axios          from 'axios';
import logger from '../config/logger.js';

// ─── ADMIN PHONE LIST ─────────────────────────────────────────────────────────
// Primary source: ADMIN_PHONES env var (comma-separated E.164 without +)
// Secondary source: business.adminPhone per-tenant
// Example: ADMIN_PHONES=2207123456,2207654321

const getEnvAdmins = () => {
  const raw = process.env.ADMIN_PHONES || '';
  return raw
    .split(',')
    .map((p) => p.trim().replace(/^\+/, ''))
    .filter(Boolean);
};

/**
 * Check if a sender phone is an admin for this tenant.
 * @param {string} senderPhone  - Incoming WhatsApp sender (E.164 without +)
 * @param {string} tenantId     - Tenant ObjectId
 * @returns {Promise<boolean>}
 */
export const isAdminPhone = async (senderPhone, tenantId) => {
  const normalised = String(senderPhone).replace(/^\+/, '');

  // [A-1a] Global env-level admins
  if (getEnvAdmins().includes(normalised)) return true;

  // [A-1b] Per-tenant adminPhone from BusinessConfig
  try {
    const business = await BusinessConfig.findOne({ tenantId }).select('adminPhone').lean();
    if (business?.adminPhone) {
      const bizAdmin = String(business.adminPhone).replace(/^\+/, '');
      if (bizAdmin === normalised) return true;
    }
  } catch (err) {
    logger.warn('[AdminPaymentHandler] isAdminPhone: DB error', { err: err.message });
  }

  // [A-1c] Tenant-level adminPhone
  try {
    const tenant = await Tenant.findById(tenantId).select('adminPhone').lean();
    if (tenant?.adminPhone) {
      const tenantAdmin = String(tenant.adminPhone).replace(/^\+/, '');
      if (tenantAdmin === normalised) return true;
    }
  } catch (err) {
    logger.warn('[AdminPaymentHandler] isAdminPhone: Tenant DB error', { err: err.message });
  }

  return false;
};

// ─── BUTTON ID HELPERS ────────────────────────────────────────────────────────
// Button IDs encode action + orderId so we never need admin session state.
// Format: "PAY_APPROVE:{orderId}" or "PAY_REJECT:{orderId}"
// WhatsApp button IDs are max 256 chars — MongoDB ObjectIds are 24 chars ✓

const APPROVE_PREFIX = 'PAY_APPROVE:';
const REJECT_PREFIX  = 'PAY_REJECT:';

export const buildApproveId = (orderId) => `${APPROVE_PREFIX}${orderId}`;
export const buildRejectId  = (orderId) => `${REJECT_PREFIX}${orderId}`;

export const parseButtonId = (buttonId) => {
  if (!buttonId) return null;
  if (buttonId.startsWith(APPROVE_PREFIX)) {
    return { action: 'APPROVE', orderId: buttonId.slice(APPROVE_PREFIX.length) };
  }
  if (buttonId.startsWith(REJECT_PREFIX)) {
    return { action: 'REJECT', orderId: buttonId.slice(REJECT_PREFIX.length) };
  }
  return null;
};

// ─── NOTIFY ADMIN OF NEW PAYMENT ─────────────────────────────────────────────

/**
 * Send a payment notification to ALL configured admins.
 * Sends the proof image followed by an interactive button message.
 *
 * @param {object} order      - Mongoose Order document (lean or full)
 * @param {string} imageUrl   - WhatsApp media ID or URL of proof screenshot
 * @param {object} tenant     - Tenant document (for sendMessage credentials)
 * @param {object} business   - BusinessConfig (for adminPhone)
 */
export const notifyAdminOfPayment = async (order, imageUrl, tenant, business) => {
  const admins = collectAdmins(tenant, business);
  if (!admins.length) {
    logger.warn('[AdminPaymentHandler] No admin phones configured — proof received but no one notified', {
      orderId: order._id,
    });
    return;
  }

  const orderId    = String(order._id);
  const customer   = order.customerPhone;
  const amount     = order.totalPrice != null ? `D${order.totalPrice}` : 'N/A';
  const item       = order.item || 'Unknown item';
  const qty        = order.quantity || 1;

  const alertText =
    `💳 *New Payment Submission*\n\n` +
    `🆔 Order: #${orderId.slice(-6).toUpperCase()}\n` +
    `👤 Customer: ${customer}\n` +
    `🛒 Items: ${item} × ${qty}\n` +
    `💰 Amount: *${amount}*\n\n` +
    `Please review this payment and tap a button to approve or reject:`;

  const buttons = [
    { id: buildApproveId(orderId), title: '✅ Approve' },
    { id: buildRejectId(orderId),  title: '❌ Reject'  },
  ];

  for (const adminPhone of admins) {
    try {
      // Step 1: Forward the proof image
      if (imageUrl) {
        await forwardProofImage(adminPhone, imageUrl, order, tenant);
      }

      // Step 2: Send interactive Approve / Reject buttons
      const sent = await sendButtonMessage(adminPhone, alertText, buttons, tenant);
      if (!sent) {
        // Fallback: plain text with manual instructions
        const fallback =
          alertText +
          `\n\nReply:\n` +
          `✅ APPROVE ${orderId.slice(-6).toUpperCase()}\n` +
          `❌ REJECT ${orderId.slice(-6).toUpperCase()}`;
        await sendMessage(adminPhone, fallback, tenant);
      }

      logger.info('[AdminPaymentHandler] Admin notified of payment', { adminPhone, orderId });
    } catch (err) {
      logger.error('[AdminPaymentHandler] Failed to notify admin', {
        adminPhone, orderId, err: err.message,
      });
    }
  }
};

// ─── FORWARD PROOF IMAGE TO ADMIN ────────────────────────────────────────────

async function forwardProofImage(adminPhone, mediaIdOrUrl, order, tenant) {
  const phoneNumberId = tenant?.whatsapp?.phoneNumberId || tenant?.phoneNumberId;
  const accessToken   = decrypt(tenant?.whatsapp?.accessToken   || tenant?.accessToken);
  const apiVersion    = tenant?.whatsapp?.apiVersion    || process.env.WA_API_VERSION || 'v21.0';

  if (!phoneNumberId || !accessToken) return;

  // If it looks like a WhatsApp media ID (no http), use image.id
  const isMediaId = !mediaIdOrUrl.startsWith('http') && !mediaIdOrUrl.startsWith('wa-media:');
  const rawId     = mediaIdOrUrl.startsWith('wa-media:')
    ? mediaIdOrUrl.replace('wa-media:', '')
    : mediaIdOrUrl;

  const payload = {
    messaging_product: 'whatsapp',
    to:   adminPhone,
    type: 'image',
    image: isMediaId || mediaIdOrUrl.startsWith('wa-media:')
      ? { id: rawId, caption: `Payment proof — Order #${String(order._id).slice(-6).toUpperCase()}` }
      : { link: mediaIdOrUrl, caption: `Payment proof — Order #${String(order._id).slice(-6).toUpperCase()}` },
  };

  try {
    await axios.post(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      payload,
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
      },
    );
    logger.debug('[AdminPaymentHandler] Proof image forwarded to admin', { adminPhone });
  } catch (err) {
    // Non-fatal — the text alert still goes through
    logger.warn('[AdminPaymentHandler] Could not forward proof image', { err: err.response?.data || err.message });
  }
}

// ─── HANDLE ADMIN BUTTON REPLY ────────────────────────────────────────────────

/**
 * Process an admin's Approve or Reject button tap.
 *
 * @param {string} buttonId      - The interactive button reply ID from WhatsApp
 * @param {string} adminPhone    - Admin's phone number
 * @param {string} tenantId      - Tenant ObjectId
 * @param {object} tenant        - Tenant document (for sendMessage credentials)
 * @param {object} business      - BusinessConfig (for customer messages)
 * @returns {Promise<string|null>} Reply text to send back to admin, or null if not a payment button
 */
export const handleAdminButtonReply = async (buttonId, adminPhone, tenantId, tenant, business) => {
  const parsed = parseButtonId(buttonId);
  if (!parsed) return null; // Not a payment admin button — let normal flow handle it

  const { action, orderId } = parsed;

  // [A-2] Fetch order and verify it's still in pending_verification state
  let order;
  try {
    order = await Order.findOne({ _id: orderId, tenantId }).lean();
  } catch (err) {
    logger.error('[AdminPaymentHandler] DB error fetching order', { orderId, err: err.message });
    return '⚠️ Database error. Please try again.';
  }

  if (!order) {
    return `⚠️ Order #${orderId.slice(-6).toUpperCase()} not found.`;
  }

  // [A-3] Idempotency — prevent double processing
  if (order.paymentStatus === 'paid') {
    return `ℹ️ Order #${orderId.slice(-6).toUpperCase()} already *approved*. No action taken.`;
  }
  if (order.paymentStatus === 'payment_failed') { // [FIX-B] 'failed' not in enum; use 'payment_failed'
    return `ℹ️ Order #${orderId.slice(-6).toUpperCase()} already *rejected*. No action taken.`;
  }
  if (order.paymentStatus !== 'payment_pending_verification') {
    return `⚠️ Order #${orderId.slice(-6).toUpperCase()} is in an unexpected state (${order.paymentStatus}). No action taken.`;
  }

  if (action === 'APPROVE') {
    return await processApproval(orderId, tenantId, adminPhone, tenant, business, order);
  }

  if (action === 'REJECT') {
    return await processRejection(orderId, tenantId, adminPhone, tenant, business, order);
  }

  return null;
};

// ─── APPROVAL ─────────────────────────────────────────────────────────────────

async function processApproval(orderId, tenantId, adminPhone, tenant, business, order) {
  try {
    const { order: updatedOrder, customerMessage } = await confirmPayment(
      orderId,
      tenantId,
      adminPhone,
    );

    // Notify customer
    await sendMessage(updatedOrder.customerPhone, customerMessage, tenant);
    logger.info('[AdminPaymentHandler] Payment approved — customer notified', {
      orderId, customer: updatedOrder.customerPhone, admin: adminPhone,
    });

    return (
      `✅ *Order Approved*\n\n` +
      `Order #${orderId.slice(-6).toUpperCase()} approved successfully.\n` +
      `Customer notification sent to ${updatedOrder.customerPhone}.`
    );
  } catch (err) {
    logger.error('[AdminPaymentHandler] Approval failed', { orderId, err: err.message });
    return `❌ Approval failed: ${err.message}`;
  }
}

// ─── REJECTION ────────────────────────────────────────────────────────────────

async function processRejection(orderId, tenantId, adminPhone, tenant, business, order) {
  try {
    const { order: updatedOrder, customerMessage } = await rejectPayment(
      orderId,
      tenantId,
      null,      // reason — WhatsApp flow doesn't collect reason text (keep it simple)
      adminPhone,
    );

    // Notify customer with the improved rejection message
    await sendMessage(updatedOrder.customerPhone, customerMessage, tenant);

    // [v12 FIX] Follow the rejection text with WhatsApp action buttons.
    // This replaces the old typed-number instructions (1/2/3) with a
    // button-first UX consistent with the rest of the platform.
    try {
      await sendButtonMessage(
        updatedOrder.customerPhone,
        `What would you like to do?`,
        [
          { id: 'REJECTION_RESEND',  title: '📸 Resend Proof'    },
          { id: 'REJECTION_SUPPORT', title: '🤝 Contact Support' },
          { id: 'REJECTION_CANCEL',  title: '❌ Cancel Order'    },
        ],
        tenant,
      );
    } catch (btnErr) {
      logger.warn('[AdminPaymentHandler] Could not send rejection buttons — plain text already sent', { btnErr: btnErr.message });
    }

    // ── Set awaiting_rejection_action state ──────────────────────────────
    // This prevents the bot from jumping to unrelated flows (menus, ordering)
    // when the customer's next message arrives. The webhookController will
    // check this mode and handle Resend / Support / Cancel options correctly.
    try {
      let sess = await getSession(updatedOrder.customerPhone, String(tenantId));
      if (!sess) {
        sess = await createSession(updatedOrder.customerPhone, String(tenantId), {
          customerPhone: updatedOrder.customerPhone,
        });
      }
      await updateSession(updatedOrder.customerPhone, String(tenantId), {
        mode:    'awaiting_rejection_action',
        data:    { ...(sess?.data || {}), rejectedOrderId: orderId },
      });
    } catch (sessErr) {
      logger.warn('[AdminPaymentHandler] Could not set awaiting_rejection_action', { sessErr: sessErr.message });
    }

    logger.info('[AdminPaymentHandler] Payment rejected — customer notified', {
      orderId, customer: updatedOrder.customerPhone, admin: adminPhone,
    });

    return (
      `❌ *Order Rejected*\n\n` +
      `Order #${orderId.slice(-6).toUpperCase()} has been marked as unverified.\n` +
      `Customer ${updatedOrder.customerPhone} has been notified and given options to retry or cancel.`
    );
  } catch (err) {
    logger.error('[AdminPaymentHandler] Rejection failed', { orderId, err: err.message });
    return `⚠️ Rejection failed: ${err.message}`;
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function collectAdmins(tenant, business) {
  const phones = new Set();

  // Global env admins
  for (const p of getEnvAdmins()) phones.add(p);

  // Per-business adminPhone
  if (business?.adminPhone) {
    phones.add(String(business.adminPhone).replace(/^\+/, ''));
  }

  // Per-tenant adminPhone
  if (tenant?.adminPhone) {
    phones.add(String(tenant.adminPhone).replace(/^\+/, ''));
  }

  return [...phones];
}

/**
 * Handle admin text commands as fallback when buttons aren't supported.
 * Syntax: "APPROVE abc123" or "REJECT abc123" (case-insensitive)
 *
 * @param {string} messageText  - Raw message from admin
 * @param {string} tenantId
 * @param {string} adminPhone
 * @param {object} tenant
 * @param {object} business
 * @returns {Promise<string|null>}  Reply for admin, or null if not a command
 */
export const handleAdminTextCommand = async (messageText, tenantId, adminPhone, tenant, business) => {
  const upper = (messageText || '').trim().toUpperCase();

  // ── [FIX] Admin RESUME BOT command ────────────────────────────────────────
  // Problem: there was no WhatsApp command to exit human-handoff mode.
  // The only way was the REST API — useless when the admin is on their phone.
  //
  // Syntax (case-insensitive):
  //   RESUME BOT <phone>         — resume bot for a specific customer
  //   RESUME BOT +220XXXXXXXX   — works with or without leading +
  //
  // The command clears session.humanMode so the bot resumes responding normally.
  // Admin receives confirmation. Customer receives a "bot is back" message.
  // Safe to call repeatedly (idempotent).
  //
  // Example (admin types in WhatsApp):
  //   "RESUME BOT 2207654321"
  //   "resume bot +2207654321"
  // ─────────────────────────────────────────────────────────────────────────
  const resumeMatch = upper.match(/^RESUME\s+BOT\s+([\d+]+)$/);
  if (resumeMatch) {
    // Normalise phone: strip leading + for internal storage consistency
    const rawPhone     = resumeMatch[1].replace(/^\+/, '');
    const customerPhone = rawPhone;

    try {
      // Lazy import to avoid circular dep (sessionService → webhookController)
      const { getSession, updateSession } = await import('./sessionService.js');

      const session = await getSession(customerPhone, tenantId);
      if (!session) {
        return `⚠️ No active session found for +${customerPhone}. Bot may already be inactive for this customer.`;
      }

      if (!session.humanMode) {
        return `ℹ️ Bot is already active for +${customerPhone} — no change needed.`;
      }

      await updateSession(customerPhone, tenantId, {
        humanMode:         false,
        humanModeNotified: false,
      });

      // Notify the customer that the bot has resumed
      const { dispatch } = await import('./messageService.js');
      const businessName = business?.name || 'us';
      await dispatch(
        customerPhone,
        {
          type: 'text',
          body:
            `✅ You've been reconnected to the *${businessName}* assistant.\n\n` +
            `Type *Hi* or *Menu* to continue.`,
        },
        tenant,
      ).catch((err) =>
        logger.warn('[AdminCmd] RESUME BOT — could not notify customer', { err: err.message }),
      );

      logger.info('[AdminCmd] RESUME BOT executed', { adminPhone, customerPhone, tenantId });
      return `✅ Bot resumed for +${customerPhone}. Customer has been notified.`;

    } catch (err) {
      logger.error('[AdminCmd] RESUME BOT failed', { err: err.message, customerPhone });
      return `⚠️ Could not resume bot for +${customerPhone}: ${err.message}`;
    }
  }

  // ── [FIX-3] CONFIRM BOOK / DECLINE BOOK booking commands ──────────────────
  // Syntax (case-insensitive):
  //   CONFIRM BOOK <shortId>   — marks booking as confirmed, notifies customer
  //   DECLINE BOOK <shortId>   — marks booking as cancelled, notifies customer
  //
  // shortId is the last 6 hex chars of the Booking._id (pre-populated by
  // Booking pre-save hook, matches the ID shown in admin booking alerts).
  //
  // The commands mirror APPROVE/REJECT for orders so admins have a symmetric
  // WhatsApp-only workflow for both flows without needing the dashboard.
  const confirmBookMatch = upper.match(/^CONFIRM\s+BOOK\s+([A-F0-9]{6,24})$/);
  const declineBookMatch = upper.match(/^DECLINE\s+BOOK\s+([A-F0-9]{6,24})$/);

  if (confirmBookMatch || declineBookMatch) {
    const bookShortId = (confirmBookMatch || declineBookMatch)[1].toUpperCase();
    const bookAction  = confirmBookMatch ? 'CONFIRM' : 'DECLINE';

    let booking;
    try {
      booking = await Booking.findOne({ tenantId, shortId: bookShortId })
        .select('_id customerPhone date time service status customerName')
        .lean();
    } catch (err) {
      return `⚠️ DB error: ${err.message}`;
    }

    if (!booking) {
      return `⚠️ No booking found matching ID: ${bookShortId}`;
    }

    if (booking.status === 'cancelled') {
      return `ℹ️ Booking #${bookShortId} is already *cancelled*. No action taken.`;
    }
    if (booking.status === 'confirmed' && bookAction === 'CONFIRM') {
      return `ℹ️ Booking #${bookShortId} is already *confirmed*. No action taken.`;
    }

    const bookingId  = String(booking._id);
    const when       = booking.time ? `${booking.date} at ${booking.time}` : (booking.date || 'TBD');
    const serviceStr = booking.service ? ` (${booking.service})` : '';
    const nameStr    = booking.customerName ? ` *${booking.customerName}*` : '';

    if (bookAction === 'CONFIRM') {
      try {
        await Booking.updateOne(
          { _id: bookingId },
          {
            $set: {
              status:             'confirmed',
              adminConfirmedAt:   new Date(),
              adminConfirmedBy:   adminPhone,
            },
          },
        );

        const customerMsg =
          `✅ *Booking Confirmed!*\n\n` +
          `Your booking${serviceStr} for *${when}* has been confirmed.\n\n` +
          `We look forward to seeing you! 😊`;

        await sendMessage(booking.customerPhone, customerMsg, tenant);

        logger.info('[AdminCmd] CONFIRM BOOK executed', { adminPhone, bookingId, tenantId });
        return (
          `✅ *Booking Confirmed*\n\n` +
          `Booking #${bookShortId} for${nameStr} (${when}${serviceStr}) confirmed.\n` +
          `Customer ${booking.customerPhone} has been notified.`
        );
      } catch (err) {
        logger.error('[AdminCmd] CONFIRM BOOK failed', { err: err.message, bookingId });
        return `⚠️ Could not confirm booking: ${err.message}`;
      }
    }

    // DECLINE
    try {
      await Booking.updateOne(
        { _id: bookingId },
        {
          $set: {
            status:           'cancelled',
            adminDeclinedAt:  new Date(),
            adminDeclinedBy:  adminPhone,
          },
        },
      );

      const customerMsg =
        `❌ *Booking Unavailable*\n\n` +
        `Unfortunately we're unable to confirm your booking${serviceStr} for *${when}*.\n\n` +
        `Please contact us to arrange an alternative time. We apologise for the inconvenience.`;

      await sendMessage(booking.customerPhone, customerMsg, tenant);

      logger.info('[AdminCmd] DECLINE BOOK executed', { adminPhone, bookingId, tenantId });
      return (
        `❌ *Booking Declined*\n\n` +
        `Booking #${bookShortId} for${nameStr} (${when}${serviceStr}) has been cancelled.\n` +
        `Customer ${booking.customerPhone} has been notified.`
      );
    } catch (err) {
      logger.error('[AdminCmd] DECLINE BOOK failed', { err: err.message, bookingId });
      return `⚠️ Could not decline booking: ${err.message}`;
    }
  }

  // ── APPROVE / REJECT payment commands ──────────────────────────────────────
  // [FIX-13] Use [a-fA-F0-9] instead of /i on [A-F0-9].
  // The /i flag does NOT expand character classes — [A-F0-9] only matches
  // uppercase hex regardless of the /i flag. The code works today because
  // `upper = ...toUpperCase()` is applied first, but the /i was a false safety
  // net that would silently fail if the pre-processing was ever removed.
  // Now the regex is self-documenting and correct without relying on caller behaviour.
  const approveMatch = upper.match(/^APPROVE\s+([a-fA-F0-9]{6,24})$/);
  const rejectMatch  = upper.match(/^REJECT\s+([a-fA-F0-9]{6,24})$/);

  if (!approveMatch && !rejectMatch) return null;

  const shortId  = (approveMatch || rejectMatch)[1].toUpperCase();
  const action   = approveMatch ? 'APPROVE' : 'REJECT';

  // [FIX-8 v2] Use the pre-stored `shortId` field (last 6 hex chars of _id, indexed)
  // for O(1) admin lookups. The previous approach used $expr/$regexMatch on the
  // ObjectId string, which is a post-filter scan that cannot use any index.
  // shortId is populated by the Order pre-save hook and indexed on { tenantId, shortId }.
  let order;
  try {
    order = await Order.findOne({
      tenantId,
      paymentStatus: 'payment_pending_verification',
      shortId: shortId,  // fully indexed — no $expr needed
    }).select('_id customerPhone item quantity totalPrice paymentStatus').lean();
  } catch (err) {
    return `⚠️ DB error: ${err.message}`;
  }

  if (!order) {
    return `⚠️ No pending order found matching ID: ${shortId}`;
  }

  const orderId = String(order._id);

  if (action === 'APPROVE') {
    return await processApproval(orderId, tenantId, adminPhone, tenant, business, order);
  }
  return await processRejection(orderId, tenantId, adminPhone, tenant, business, order);
};
