/**
 * services/paymentService.js — WhatSalesAgent2
 *
 * Handles payment proof receipt and admin approval/rejection flow.
 *
 * [FIX] DONE path in webhookController is gated on requireProof===false.
 *
 * [FIX #5a] buildPaymentInstructionsUI accepts a storedRef param. When the order
 *           already has a paymentReference in DB, that value is used instead of
 *           recomputing it — avoids day-boundary mismatch (order at 23:55, reminder
 *           at 00:05 generates a different reference than the stored one).
 *
 * [FIX #5b] Date formatting uses explicit zero-padded arithmetic (padStart) rather
 *           than Intl.DateTimeFormat or toLocaleDateString, both of which vary across
 *           Node.js ICU builds and locale environments.
 *
 * [FIX-IMG-ORDER] receiveProof forwards the payment proof image to the admin BEFORE
 *                 the approval card, then waits 500 ms. The old code sent them
 *                 concurrently so the card often arrived before the image.
 */

import Order          from '../models/Order.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { dispatchText } from '../core/whatsapp/dispatcher.js';
import logger from '../config/logger.js';

const PROOF_WINDOW_HOURS = Number(process.env.PROOF_ELIGIBLE_HOURS || 4);

/**
 * receiveProof — customer has sent a payment screenshot.
 */
export async function receiveProof(customerPhone, tenantId, imageId, tenantDoc) {
  const windowStart = new Date(Date.now() - PROOF_WINDOW_HOURS * 60 * 60 * 1000);

  const order = await Order.findOne({
    customerPhone, tenantId,
    paymentStatus: 'unpaid',
    createdAt:     { $gte: windowStart },
  }).sort({ createdAt: -1 });

  if (!order) {
    return `⚠️ We couldn't find a pending order to attach this payment to.\n\nIf you believe this is an error, please contact us directly.`;
  }

  await Order.updateOne({ _id: order._id }, {
    $set: {
      paymentStatus:   'proof_received',
      paymentProof:    imageId,         // [FIX] schema field is paymentProof, not proofImageId
      proofReceivedAt: new Date(),
    },
  });

  // Notify admin
  const business  = await BusinessConfig.findOne({ tenantId }).lean();
  const adminPhone = business?.adminPhone || tenantDoc?.adminPhone;
  if (adminPhone && tenantDoc) {
    const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');
    const currency = business?.payment?.currency || 'D';

    // [FIX-IMG-ORDER] Forward the image FIRST (awaited), then the approval card.
    // Previously both were fire-and-forget so the card often arrived before the image,
    // making "Screenshot sent above ↑" incorrect.
    if (imageId) {
      // [FIX-PAY-IMG] Fall back to global META_WHATSAPP_TOKEN when no per-tenant
      // accessToken is set — consistent with dispatcher.js shared-app architecture.
      // Previously this used tenantDoc?.whatsapp?.accessToken only, so image forwarding
      // silently broke for all tenants relying on the global system-user token.
      const token   = tenantDoc?.whatsapp?.accessToken || process.env.META_WHATSAPP_TOKEN;
      const phoneId = tenantDoc?.whatsapp?.phoneNumberId;
      const version = tenantDoc?.whatsapp?.apiVersion || process.env.META_API_VERSION || 'v21.0';
      if (token && phoneId) {
        const imgPayload = {
          messaging_product: 'whatsapp', recipient_type: 'individual',
          to: adminPhone, type: 'image',
          image: { id: imageId, caption: `📸 Payment proof from ${customerPhone} — Order #${order.shortId}` },
        };
        try {
          await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body:    JSON.stringify(imgPayload),
          });
        } catch (imgErr) {
          logger.warn('[PaymentService] Image forward failed (non-fatal)', { err: imgErr.message });
        }
        // Brief gap so WhatsApp delivers the image before the interactive card
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Send interactive approval card — image guaranteed to be above this
    await dispatchMessage(adminPhone, {
      type: 'buttons',
      body:
        `💳 *New Payment Submission*\n\n` +
        `🆔 Order: *#${order.shortId}*\n` +
        `👤 Customer: *${customerPhone}*\n` +
        `🛒 Items: *${order.item}* × ${order.quantity}\n` +
        `💰 Amount: *${currency}${order.totalPrice || '—'}*\n\n` +
        `Screenshot sent above ↑\nPlease approve or reject:`,
      buttons: [
        { id: `APPROVE_${order.shortId}`, title: '✅ Approve' },
        { id: `REJECT_${order.shortId}`,  title: '❌ Reject'  },
      ],
    }, tenantDoc).catch(() => {});
  }

  return (
    `✅ *Payment proof received!*\n\n` +
    `⏳ Your order *${order.item}* × ${order.quantity} is now awaiting verification.\n\n` +
    `We'll confirm shortly 🙏`
  );
}

/**
 * handleDonePayment — for businesses where requireProof=false.
 * Customer types DONE to self-confirm without a screenshot.
 * This is only called when requireProof===false (gated in webhookController).
 *
 * [FIX-PAY-1] Now accepts tenantDoc so it can notify the admin when a customer
 *             self-confirms. Previously the admin was never told, so cash orders
 *             silently appeared in the DB with no admin alert.
 */
export async function handleDonePayment(customerPhone, tenantId, tenantDoc) {
  const order = await Order.findOne({
    customerPhone, tenantId, paymentStatus: 'unpaid', status: 'pending',
  }).sort({ createdAt: -1 });

  if (!order) return `⚠️ No pending payment found. Please start a new order to continue.`;

  await Order.updateOne({ _id: order._id }, {
    $set: {
      paymentStatus:   'self_confirmed', // in enum
      status:          'confirmed',
      proofReceivedAt: new Date(),       // reuse as self-confirm timestamp
    },
  });

  // [FIX-PAY-1] Notify admin on self-confirm (cash/no-proof orders)
  if (tenantDoc) {
    try {
      const business   = await BusinessConfig.findOne({ tenantId }).lean();
      const adminPhone = business?.adminPhone || tenantDoc?.adminPhone;
      if (adminPhone) {
        const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');
        const currency = business?.payment?.currency || 'D';
        await dispatchMessage(adminPhone, {
          type: 'buttons',
          body:
            `✅ *Self-Confirmed Order*\n\n` +
            `👤 Customer: *${customerPhone}*\n` +
            `🛒 Item: *${order.item}* × ${order.quantity}\n` +
            `💰 Total: *${currency}${order.totalPrice || '—'}*\n` +
            `🔖 Ref: \`${order.shortId}\`\n\n` +
            `Customer has confirmed payment (cash/self-confirm). Please prepare.`,
          buttons: [
            { id: `APPROVE_${order.shortId}`, title: '✅ Mark Done' },
            { id: `REJECT_${order.shortId}`,  title: '❌ Cancel'    },
          ],
        }, tenantDoc).catch(() => {});
      }
    } catch (err) {
      logger.warn('[PaymentService] Admin notification for self-confirm failed (non-fatal)', { err: err.message });
    }
  }

  return `✅ *Thank you!* Your order of *${order.item}* has been received.\n\nWe'll process it shortly. 🙏`;
}

/**
 * buildPaymentInstructionsUI — shown after order confirm when payment is enabled.
 *
 * [FIX #5a] Accept storedRef and use it when available. Only generate a new reference
 *           when none exists yet (first call from orderFlow).
 *
 * [FIX #5b] Use explicit zero-padded arithmetic for the date prefix — avoids ICU
 *           separator variance (Intl '/' vs '-' across Node builds) and locale
 *           unpredictability of toLocaleDateString.
 *
 * [FIX #5c] Date format standardised to MMDD to match orderFlow.js reference generator.
 *           Was DDMM here vs MMDD there — now consistent everywhere.
 *
 * @param {object} business
 * @param {number} totalPrice
 * @param {string} shortId
 * @param {string|null} storedRef  - existing paymentReference from the Order doc, if any
 */
export function buildPaymentInstructionsUI(business, totalPrice, shortId, storedRef = null) {
  const payment  = business?.payment || {};
  const waveNo   = payment.wavePhone || payment.phone || '—';
  const currency = payment.currency || 'D';

  // Prefer the stored reference; only compute a new one when none exists
  let ref = storedRef || null;
  if (!ref && shortId) {
    // [FIX #5b,5c] Explicit arithmetic — ICU-independent, MMDD format (month-day)
    const now = new Date();
    const mm  = String(now.getMonth() + 1).padStart(2, '0');
    const dd  = String(now.getDate()).padStart(2, '0');
    ref = `DSB-${mm}${dd}-${shortId}`;
  }

  return {
    type: 'text',
    body:
      `💳 *Payment Instructions*\n\n` +
      `🛒 Total: *${currency}${totalPrice}*` +
      (ref ? `\n📝 Reference: *${ref}*` : '') +
      `\n\n─────────────────────\n` +
      `📲 Send *${currency}${totalPrice}* via *Wave* to:\n\n` +
      `📱 *${waveNo}*\n` +
      (ref ? `\n⚠️ Use *${ref}* as your payment reference.\n` : '') +
      `─────────────────────\n\n` +
      `After sending, please *reply with a screenshot* of your Wave confirmation.\n\n` +
      `We'll verify and confirm your order shortly ✅`,
  };
}
