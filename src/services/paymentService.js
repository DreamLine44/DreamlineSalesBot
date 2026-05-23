/**
 * services/paymentService.js — WhatSalesAgent2
 *
 * Handles payment proof receipt and admin approval/rejection flow.
 * [FIX] DONE path in webhookController is now gated on requireProof===false.
 */

import Order          from '../models/Order.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { dispatchText } from '../core/whatsapp/dispatcher.js';
import { buildAdminBookingAlert } from './adminCommandService.js';
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

  // Notify admin
  const business = await BusinessConfig.findOne({ tenantId }).lean();
  const adminPhone = business?.adminPhone || tenantDoc?.adminPhone;
  if (adminPhone && tenantDoc) {
    const adminMsg =
      `📸 *Payment Proof Received*\n\n` +
      `Order: *${order.item}* × ${order.quantity}\n` +
      `Amount: *D${order.totalPrice || '—'}*\n` +
      `Customer: ${customerPhone}\n` +
      `Ref: \`${order.shortId}\`\n\n` +
      `Reply:\n✅ \`APPROVE ${order.shortId}\`\n❌ \`REJECT ${order.shortId}\``;
    dispatchText(adminPhone, adminMsg, tenantDoc).catch(() => {});
  }

  return `✅ *Screenshot received!*\n\nWe'll verify your payment and confirm your order shortly. Thank you! 🙏`;
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

  if (!order) return `⚠️ No pending order found. Type *Order* to start a new order.`;

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
export function buildPaymentInstructionsUI(business, totalPrice, last4) {
  const payment = business?.payment || {};
  const waveNo  = payment.wavePhone || payment.phone || '—';
  const currency= payment.currency || 'D';

  return {
    type: 'text',
    body:
      `💳 *Payment Details*\n\n` +
      `💰 Total: *${currency}${totalPrice}*\n` +
      `📲 Send via *Wave* to: *${waveNo}*\n\n` +
      `After payment, send your *screenshot* here. 📸\n\n` +
      `_(Reference: ends in ${last4})_`,
  };
}
