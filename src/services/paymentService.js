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
import { decryptToken } from '../controllers/tenantController.js';
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
      // [FIX-32] Clear abandonedCartAt — customer has re-engaged and submitted payment proof.
      // Prevents the scheduler from sending an abandoned-cart nudge after proof submission.
      abandonedCartAt: null,
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
    // [FIX-SCOPE] imageForwarded is declared here (outer scope) so the approval card
    // template literal below can always read it. Previously it was declared inside
    // `if (token && phoneId)` — when token/phoneId was falsy the variable was undefined
    // at the point of use, causing the card to incorrectly say "Screenshot delivery failed."
    let imageForwarded = false;
    if (imageId) {
      // [FIX-PAY-2] decryptToken() must be called before using the stored access token.
      // tenantDoc.whatsapp.accessToken is AES-256-GCM encrypted (enc:<iv>:<tag>:<ct>)
      // in production. Sending the raw ciphertext to Meta results in a 400 auth error
      // on every image forward. All other Meta calls route through dispatcher.js which
      // calls decryptToken() — this direct fetch() was the only path that did not.
      const token   = decryptToken(tenantDoc?.whatsapp?.accessToken);
      const phoneId = tenantDoc?.whatsapp?.phoneNumberId;
      const version = tenantDoc?.whatsapp?.apiVersion || process.env.META_API_VERSION || 'v21.0';
      if (token && phoneId) {
        const imgPayload = {
          messaging_product: 'whatsapp', recipient_type: 'individual',
          to: adminPhone, type: 'image',
          image: { id: imageId, caption: `📸 Payment proof from ${customerPhone} — Order #${order.shortId}` },
        };
        // [FIX-PAY-3] Retry image forward up to 2 times on transient Meta 5xx.
        // Previously a single failed fetch() silently dropped the image — the admin
        // received the approval card with "Screenshot sent above ↑" but no image,
        // causing blind approve/reject decisions. On persistent failure, include an
        // explicit warning in the approval card body so the admin knows to ask the
        // customer to resend.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const imgRes = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body:    JSON.stringify(imgPayload),
            });
            if (imgRes.ok) { imageForwarded = true; break; }
            // Non-2xx from Meta — log and retry on 5xx only
            const status = imgRes.status;
            logger.warn('[PaymentService] Image forward non-OK', { attempt: attempt + 1, status, orderId: order._id });
            if (status < 500) break; // 4xx (bad token, bad media ID) — retrying won't help
          } catch (imgErr) {
            logger.warn('[PaymentService] Image forward network error', { attempt: attempt + 1, err: imgErr.message });
          }
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // 1s, 2s backoff
        }
        if (!imageForwarded) {
          logger.error('[PaymentService] Image forward failed after 3 attempts — admin will be warned', { orderId: order._id });
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
        (imageForwarded
          ? `Screenshot sent above ↑\nPlease approve or reject:`
          : `⚠️ *Screenshot delivery failed* — ask the customer to resend.\nYou may still approve or reject based on other confirmation:`),
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
            `Customer confirmed (cash/no-proof). Tap ✅ to confirm, then 🍽️ Mark Ready when done.`,
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
 * [FIX-MULTICHAN] Supports multiple payment channels (Wave, GT Bank, EcoBank, Trust Bank, etc.)
 *                 Clients send a screenshot; the tenant admin confirms it manually.
 *                 Falls back to legacy wavePhone if no channels[] configured.
 *
 * @param {object} business
 * @param {number} totalPrice
 * @param {string} shortId
 * @param {string|null} storedRef  - existing paymentReference from the Order doc, if any
 */
export function buildPaymentInstructionsUI(business, totalPrice, shortId, storedRef = null) {
  const payment  = business?.payment || {};
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

  // Build channel list — prefer channels[] array, fall back to legacy wavePhone
  const channels = Array.isArray(payment.channels) && payment.channels.length > 0
    ? payment.channels
    : (payment.wavePhone || payment.phone)
      ? [{ provider: 'Wave', accountNo: payment.wavePhone || payment.phone, isDefault: true }]
      : [];

  let channelBlock = '';
  if (channels.length === 1) {
    const ch = channels[0];
    channelBlock =
      `📲 Send *${currency}${totalPrice}* via *${ch.provider}* to:\n\n` +
      `📱 *${ch.accountNo}*${ch.label ? ` (${ch.label})` : ''}`;
  } else if (channels.length > 1) {
    const lines = channels.map((ch, i) =>
      `${i + 1}. *${ch.provider}* → \`${ch.accountNo}\`${ch.label ? ` (${ch.label})` : ''}${ch.isDefault ? ' ⭐' : ''}`
    ).join('\n');
    channelBlock =
      `📲 Send *${currency}${totalPrice}* to any of the following:\n\n${lines}`;
  } else {
    channelBlock = `📲 Please contact us to get payment details.`;
  }

  // [UX-2] Return as 'buttons' so customers have a clear tap-to-confirm next step.
  //
  // [FIX-PAY-5] When requireProof=true the "✅ Sent Screenshot" (DONE) button was
  // shown but served no purpose: tapping it sent the text "DONE" which was caught by
  // step 10.5 (PAYMENT_PROOF strict text guard) and responded with "awaiting your
  // payment screenshot" — contradicting the button label. The DONE button only has
  // meaning when requireProof=false (cash/self-confirm flow, gated at step 10).
  // When requireProof=true, remove it; only Support and Cancel are relevant.
  const requireProof = payment?.requireProof !== false; // default true
  const actionButtons = requireProof
    ? [
        { id: 'SUPPORT', title: '❓ Need Help'    },
        { id: 'CANCEL',  title: '❌ Cancel Order' },
      ]
    : [
        { id: 'DONE',    title: '✅ Sent Payment'  },
        { id: 'SUPPORT', title: '❓ Need Help'      },
        { id: 'CANCEL',  title: '❌ Cancel Order'   },
      ];

  const instructions = requireProof
    ? `Send your payment *screenshot* (image) directly in this chat. We'll verify and confirm your order shortly ✅`
    : `Tap *"✅ Sent Payment"* below once you've completed the payment. We'll process your order immediately ✅`;

  return {
    type: 'buttons',
    body:
      `💳 *Payment Instructions*\n\n` +
      `🛒 Total: *${currency}${totalPrice}*` +
      (ref ? `\n📝 Reference: *${ref}*` : '') +
      `\n\n─────────────────────\n` +
      `${channelBlock}\n` +
      (ref ? `\n⚠️ Use *${ref}* as your payment reference.\n` : '') +
      `─────────────────────\n\n` +
      instructions,
    buttons: actionButtons,
  };
}
