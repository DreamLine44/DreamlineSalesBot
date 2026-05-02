/**
 * services/adminPaymentHandler.js — WhatsBotLyn v5.1
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
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { confirmPayment, rejectPayment } from './paymentService.js';
import { sendMessage, sendButtonMessage, dispatch } from './messageService.js';
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
    `📥 *New Payment Proof*\n\n` +
    `🆔 Order: #${orderId.slice(-6).toUpperCase()}\n` +
    `👤 Customer: ${customer}\n` +
    `🛒 ${item} × ${qty}\n` +
    `💰 Amount: *${amount}*\n\n` +
    `Tap a button to approve or reject:`;

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
  const accessToken   = tenant?.whatsapp?.accessToken   || tenant?.accessToken;
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
    const axios = (await import('axios')).default;
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
      `✅ *Approved!*\n\n` +
      `Order #${orderId.slice(-6).toUpperCase()} confirmed.\n` +
      `Customer ${updatedOrder.customerPhone} has been notified.`
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

    // Notify customer
    await sendMessage(updatedOrder.customerPhone, customerMessage, tenant);
    logger.info('[AdminPaymentHandler] Payment rejected — customer notified', {
      orderId, customer: updatedOrder.customerPhone, admin: adminPhone,
    });

    return (
      `❌ *Rejected.*\n\n` +
      `Order #${orderId.slice(-6).toUpperCase()} marked as failed.\n` +
      `Customer ${updatedOrder.customerPhone} has been asked to retry.`
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

  const approveMatch = upper.match(/^APPROVE\s+([A-F0-9]{6,24})$/i);
  const rejectMatch  = upper.match(/^REJECT\s+([A-F0-9]{6,24})$/i);

  if (!approveMatch && !rejectMatch) return null;

  const shortId  = (approveMatch || rejectMatch)[1].toUpperCase();
  const action   = approveMatch ? 'APPROVE' : 'REJECT';

  // Find order by last-6 suffix match within this tenant
  let order;
  try {
    // We store the full ObjectId; match orders where last 6 chars of _id match
    const allPending = await Order.find({
      tenantId,
      paymentStatus: 'payment_pending_verification',
    }).select('_id customerPhone item quantity totalPrice paymentStatus').lean();

    order = allPending.find((o) =>
      String(o._id).toUpperCase().endsWith(shortId) ||
      String(o._id).toUpperCase() === shortId,
    );
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
