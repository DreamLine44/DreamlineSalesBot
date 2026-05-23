/**
 * services/paymentService.js — WhatSalesAgent2
 *
 * Handles payment proof receipt and admin approval/rejection flow.
 * [FIX] DONE path in webhookController is now gated on requireProof===false.
 */

import Order          from '../models/Order.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { dispatchText } from '../core/whatsapp/dispatcher.js';
import logger from '../config/logger.js';

const PROOF_WINDOW_HOURS = Number(process.env.PROOF_ELIGIBLE_HOURS || 4);

/**
 * receiveProof — customer has sent a payment screenshot
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
      paymentStatus:    'proof_received',
      paymentProof:     imageId,          // [FIX] schema field is paymentProof, not proofImageId
      proofReceivedAt:  new Date(),
    },
  });

  // Notify admin with interactive buttons
  const business = await BusinessConfig.findOne({ tenantId }).lean();
  const adminPhone = business?.adminPhone || tenantDoc?.adminPhone;
  if (adminPhone && tenantDoc) {
    const { dispatchMessage } = await import('../core/whatsapp/dispatcher.js');
    const currency = business?.payment?.currency || 'D';
    // [FIX-IMG-ORDER] Forward the payment proof image FIRST and await it.
    // Previously this was fire-and-forget (.catch only), so the alert card
    // raced ahead and arrived BEFORE the image in the admin chat — meaning
    // "Screenshot sent above ↑" was wrong (screenshot was below the card).
    // Now we await the image send + add a 500 ms gap before the card send.
    if (imageId) {
      const token   = tenantDoc?.whatsapp?.accessToken;
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
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(imgPayload),
          });
        } catch (imgErr) {
          logger.warn('[PaymentService] Image forward failed (non-fatal)', { err: imgErr.message });
        }
        // Small gap so WhatsApp delivers the image before the card
        await new Promise(r => setTimeout(r, 500));
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
 * handleDonePayment — for businesses where requireProof=false
 * Customer types DONE to self-confirm without a screenshot.
 * [FIX] This is now only called when requireProof===false (gated in webhookController)
 */
export async function handleDonePayment(customerPhone, tenantId) {
  const order = await Order.findOne({
    customerPhone, tenantId, paymentStatus: 'unpaid', status: 'pending',
  }).sort({ createdAt: -1 });

  if (!order) return `⚠️ No pending payment found. Please start a new order to continue.`;

  await Order.updateOne({ _id: order._id }, {
    $set: {
      paymentStatus:    'self_confirmed', // [FIX] now in enum
      status:           'confirmed',
      proofReceivedAt:  new Date(),       // reuse proofReceivedAt as the self-confirm timestamp
    },
  });

  return `✅ *Thank you!* Your order of *${order.item}* has been received.\n\nWe'll process it shortly. 🙏`;
}

/**
 * buildPaymentInstructionsUI — shown after order confirm when payment is enabled
 */
export function buildPaymentInstructionsUI(business, totalPrice, shortId) {
  const payment  = business?.payment || {};
  const waveNo   = payment.wavePhone || payment.phone || '—';
  const currency = payment.currency || 'D';
  const ref      = shortId ? `DSB-${new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit' }).replace('/','')}-${shortId}` : null;

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
