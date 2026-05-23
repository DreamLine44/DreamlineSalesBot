/**
 * services/adminCommandService.js
 *
 * WhatsApp-only admin commands:
 *   APPROVE <shortId>                 — approve payment proof
 *   REJECT <shortId>                  — reject payment proof
 *   CONFIRM BOOK <shortId>            — confirm a booking
 *   DECLINE BOOK <shortId> [reason]   — decline a booking
 *   RESUME BOT <phone>                — exit human handoff mode
 *
 * [FIX-BUG2] resumeBot() now dispatches a WhatsApp message to the customer so
 *            they know the bot is active again. Previously session was reset but
 *            the customer sat silently waiting with no indication.
 */

import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { updateSession } from '../core/sessions/sessionService.js';
import { dispatchText, dispatchMessage } from '../core/whatsapp/dispatcher.js';
import logger            from '../config/logger.js';

// ── Admin phone check ─────────────────────────────────────────────────────────
export async function isAdminPhone(senderPhone, tenantId) {
  const norm = String(senderPhone).replace(/^\+/, '');

  const envAdmins = (process.env.ADMIN_PHONES || '').split(',')
    .map(p => p.trim().replace(/^\+/, '')).filter(Boolean);
  if (envAdmins.includes(norm)) return true;

  const biz = await BusinessConfig.findOne({ tenantId }).select('adminPhone').lean().catch(() => null);
  if (biz?.adminPhone && String(biz.adminPhone).replace(/^\+/, '') === norm) return true;

  const tenant = await Tenant.findById(tenantId).select('adminPhone').lean().catch(() => null);
  if (tenant?.adminPhone && String(tenant.adminPhone).replace(/^\+/, '') === norm) return true;

  return false;
}

// ── Admin button reply ─────────────────────────────────────────────────────────
export async function handleAdminButtonReply(buttonId, tenantId, adminPhone, tenantDoc, business) {
  const upper = String(buttonId).toUpperCase();

  if (upper.startsWith('APPROVE_'))      return confirmPayment(upper.replace('APPROVE_', ''),      tenantId, adminPhone, tenantDoc, business);
  if (upper.startsWith('REJECT_'))       return rejectPayment(upper.replace('REJECT_', ''),        tenantId, adminPhone, tenantDoc, business);
  if (upper.startsWith('CONFIRM_BOOK_')) return confirmBooking(upper.replace('CONFIRM_BOOK_', ''), tenantId, adminPhone, tenantDoc);
  if (upper.startsWith('DECLINE_BOOK_')) return declineBooking(upper.replace('DECLINE_BOOK_', ''), null, tenantId, adminPhone, tenantDoc);
  return null;
}

// ── Admin text command router ─────────────────────────────────────────────────
export async function handleAdminTextCommand(text, tenantId, adminPhone, tenantDoc, business) {
  const upper = text.trim().toUpperCase();

  const approveMatch = upper.match(/^APPROVE\s+([A-F0-9]{4,24})$/);
  if (approveMatch) return confirmPayment(approveMatch[1], tenantId, adminPhone, tenantDoc, business);

  const rejectMatch = upper.match(/^REJECT\s+([A-F0-9]{4,24})$/);
  if (rejectMatch) return rejectPayment(rejectMatch[1], tenantId, adminPhone, tenantDoc, business);

  const confirmBookMatch = upper.match(/^CONFIRM\s+BOOK\s+([A-Z0-9]{4,8})$/);
  if (confirmBookMatch) return confirmBooking(confirmBookMatch[1], tenantId, adminPhone, tenantDoc);

  const declineBookMatch = text.trim().match(/^DECLINE\s+BOOK\s+([A-Za-z0-9]{4,8})(?:\s+(.+))?$/i);
  if (declineBookMatch) return declineBooking(declineBookMatch[1], declineBookMatch[2] || null, tenantId, adminPhone, tenantDoc);

  const resumeMatch = upper.match(/^RESUME BOT\s+(\d+)$/);
  if (resumeMatch) return resumeBot(resumeMatch[1], tenantId, tenantDoc);

  return null;
}

// ── Confirm payment ───────────────────────────────────────────────────────────
async function confirmPayment(shortId, tenantId, adminPhone, tenantDoc, business) {
  const order = await Order.findOne({
    $or: [{ shortId }, { _id: shortId.length === 24 ? shortId : undefined }],
    tenantId,
  }).select('_id customerPhone status paymentStatus item quantity totalPrice shortId').lean();

  if (!order) return `⚠️ No order found: ${shortId}`;
  if (order.paymentStatus === 'confirmed') return `ℹ️ Order #${shortId} already confirmed.`;

  await Order.updateOne({ _id: order._id }, { $set: {
    paymentStatus:     'confirmed',
    status:            'confirmed',
    paymentReviewedBy: adminPhone,
    paymentReviewedAt: new Date(),
  }});

  // Send proactive interactive message — customer doesn't need to reply first
  const biz      = await BusinessConfig.findOne({ tenantId }).lean().catch(() => null);
  const canBook  = (biz?.services || []).length > 0;
  const custBtns = [
    { id: 'ORDER',    title: '🛒 Place New Order'  },
    canBook ? { id: 'BOOK', title: '📅 Make a Booking' } : null,
    { id: 'QUESTION', title: '❓ Ask a Question'   },
  ].filter(Boolean).slice(0, 3);

  await dispatchMessage(order.customerPhone, {
    type:    'buttons',
    body:
      `✅ *Payment Confirmed!*\n\n` +
      `Your order of *${order.item}* × ${order.quantity} has been verified and is now being prepared.\n\n` +
      `🍽 Thank you for your order! We'll have it ready shortly. 🙏\n\n` +
      `_(Ref: #${order.shortId || shortId})_`,
    buttons: custBtns,
  }, tenantDoc).catch(() => {});

  // Clear session state — customer already has action buttons
  updateSession(order.customerPhone, tenantId, {
    currentFlow: null, step: null, postFlowAck: null,
  }).catch(() => {});

  logger.info('[AdminCmd] Payment confirmed', { shortId, adminPhone });
  return `✅ *Payment confirmed*\n\nOrder #${shortId} — ${order.item}\nCustomer ${order.customerPhone} notified.`;
}

// ── Reject payment ────────────────────────────────────────────────────────────
async function rejectPayment(shortId, tenantId, adminPhone, tenantDoc, business) {
  const order = await Order.findOne({
    $or: [{ shortId }, { _id: shortId.length === 24 ? shortId : undefined }],
    tenantId,
  }).select('_id customerPhone status paymentStatus item shortId').lean();

  if (!order) return `⚠️ No order found: ${shortId}`;
  if (order.status === 'cancelled') return `ℹ️ Order #${shortId} already cancelled.`;

  // Reset paymentStatus to 'unpaid' so the customer CAN retry their screenshot
  // (receiveProof looks for paymentStatus:'unpaid' — this keeps that path open)
  await Order.updateOne({ _id: order._id }, { $set: {
    paymentStatus:     'unpaid',
    status:            'payment_failed',
    paymentReviewedBy: adminPhone,
    paymentReviewedAt: new Date(),
  }});

  // Put customer session back into PAYMENT_PROOF so a new screenshot is accepted
  updateSession(order.customerPhone, tenantId, {
    currentFlow: 'ORDER',
    step:        'PAYMENT_PROOF',
  }).catch(() => {});

  // Interactive rejection message — customer can resend or cancel
  await dispatchMessage(order.customerPhone, {
    type:    'buttons',
    body:
      `❌ *Payment Verification Failed*\n\n` +
      `We could not verify your Wave payment for order *#${order.shortId || shortId}*.\n\n` +
      `*Possible reasons:*\n` +
      `• Incorrect amount sent\n` +
      `• Payment sent to the wrong number\n` +
      `• Screenshot was unclear or incomplete\n\n` +
      `Please send a *new, clear screenshot* of your Wave confirmation, or cancel the order below.`,
    buttons: [
      { id: 'CANCEL', title: '❌ Cancel Order' },
    ],
  }, tenantDoc).catch(() => {});

  logger.info('[AdminCmd] Payment rejected', { shortId, adminPhone });
  return `❌ *Payment rejected*\n\nOrder #${shortId} — ${order.item}\nCustomer ${order.customerPhone} notified. Retry window open.`;
}

// ── Confirm booking ───────────────────────────────────────────────────────────
async function confirmBooking(shortId, tenantId, adminPhone, tenantDoc) {
  const booking = await Booking.findOne({ shortId: shortId.toUpperCase(), tenantId })
    .select('_id customerPhone date time service status customerName').lean();

  if (!booking) return `⚠️ No booking found: ${shortId}`;
  if (booking.status === 'confirmed') return `ℹ️ Booking #${shortId} already confirmed.`;

  await Booking.updateOne({ _id: booking._id }, { $set: {
    status:            'confirmed',
    adminConfirmedAt:  new Date(),
    adminConfirmedBy:  adminPhone,
  }});

  const when       = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
  const serviceStr = booking.service ? ` (${booking.service})` : '';

  await dispatchText(booking.customerPhone,
    `✅ *Booking Confirmed!*\n\nYour booking${serviceStr} for *${when}* is confirmed.\n\nWe look forward to seeing you! 😊`,
    tenantDoc);

  logger.info('[AdminCmd] Booking confirmed', { shortId, adminPhone });
  return `✅ *Booking confirmed*\n\nBooking #${shortId} — ${when}${serviceStr}\nCustomer ${booking.customerPhone} notified.`;
}

// ── Decline booking ───────────────────────────────────────────────────────────
async function declineBooking(shortId, reason, tenantId, adminPhone, tenantDoc) {
  const booking = await Booking.findOne({ shortId: shortId.toUpperCase(), tenantId })
    .select('_id customerPhone date time service status customerName').lean();

  if (!booking) return `⚠️ No booking found: ${shortId}`;
  if (booking.status === 'cancelled') return `ℹ️ Booking #${shortId} already cancelled.`;

  await Booking.updateOne({ _id: booking._id }, { $set: {
    status:           'cancelled',
    adminDeclinedAt:  new Date(),
    adminDeclinedBy:  adminPhone,
    adminNote:        reason || null,
  }});

  const when       = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
  const serviceStr = booking.service ? ` (${booking.service})` : '';
  const reasonStr  = reason ? `\n\n*Reason:* ${reason}` : '';

  await dispatchText(booking.customerPhone,
    `❌ *Booking Unavailable*\n\nUnfortunately we can't confirm your booking${serviceStr} for *${when}*.${reasonStr}\n\nPlease contact us to arrange an alternative time.`,
    tenantDoc);

  logger.info('[AdminCmd] Booking declined', { shortId, adminPhone, reason });
  return `❌ *Booking declined*\n\nBooking #${shortId} — ${when}${serviceStr}${reason ? `\nReason: ${reason}` : ''}\nCustomer ${booking.customerPhone} notified.`;
}

// ── Resume bot ────────────────────────────────────────────────────────────────
// [FIX-BUG2] Now dispatches a WhatsApp message to the customer confirming the
// bot is active again. Previously the session was reset silently — customers
// had no idea the bot was back and often thought the conversation was dead.
async function resumeBot(customerPhone, tenantId, tenantDoc) {
  await updateSession(customerPhone, tenantId, {
    humanMode: false,
    humanModeNotified: false,
  });

  if (tenantDoc) {
    dispatchText(
      customerPhone,
      `✅ Our team has finished assisting you. Our automated assistant is back! 😊`,
      tenantDoc
    ).catch(() => {});
  }

  return `✅ Bot resumed for *${customerPhone}*. Automation is active again.`;
}

// ── Admin alert builders ──────────────────────────────────────────────────────
export function buildAdminBookingAlertBody({ customerPhone, date, time, service, partySize, business, shortId }) {
  const bizName    = business?.name || 'Business';
  const serviceStr = service   ? `\n🗓 Service: *${service}*`     : '';
  const timeStr    = time      ? `\n⏰ Time: *${time}*`           : '';
  const partyStr   = partySize ? `\n👥 Party size: *${partySize}*`: '';
  const idStr      = shortId   ? `\n🔖 Ref: \`${shortId}\``       : '';

  return (
    `🔔 *New Booking — ${bizName}*\n\n` +
    `👤 Customer: *${customerPhone}*\n` +
    `📅 Date: *${date}*${timeStr}${serviceStr}${partyStr}${idStr}\n\n` +
    `Status: *Pending* — please confirm.`
  );
}

/** Backward-compat alias — includes CONFIRM/DECLINE commands in footer */
export function buildAdminBookingAlert(args) {
  const body = buildAdminBookingAlertBody(args);
  return (
    body +
    `\n\nReply:\n` +
    `✅ \`CONFIRM BOOK ${args.shortId || '?'}\`\n` +
    `❌ \`DECLINE BOOK ${args.shortId || '?'} <reason>\``
  );
}
