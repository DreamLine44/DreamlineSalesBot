/**
 * services/adminCommandService.js
 *
 * WhatsApp-only admin commands. No dashboard needed.
 *
 * Supported commands (case-insensitive):
 *   APPROVE <shortId>           — approve payment proof
 *   REJECT <shortId>            — reject payment proof
 *   CONFIRM BOOK <shortId>      — confirm a booking
 *   DECLINE BOOK <shortId> [reason] — decline a booking (reason appended to customer message)
 *   RESUME BOT <phone>          — exit human handoff mode for a customer
 *
 * [FIX] buildAdminBookingAlert now includes shortId so CONFIRM/DECLINE BOOK work.
 * [FIX] DONE payment gated on requireProof=false (in webhookController).
 */

import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { updateSession } from '../core/sessions/sessionService.js';
import { dispatchText }  from '../core/whatsapp/dispatcher.js';
import logger            from '../config/logger.js';

// ── Admin phone check ─────────────────────────────────────────────────────────
export async function isAdminPhone(senderPhone, tenantId) {
  const norm = String(senderPhone).replace(/^\+/, '');

  // Global env admins
  const envAdmins = (process.env.ADMIN_PHONES || '').split(',').map(p => p.trim().replace(/^\+/, '')).filter(Boolean);
  if (envAdmins.includes(norm)) return true;

  // Per-business admin
  const biz = await BusinessConfig.findOne({ tenantId }).select('adminPhone').lean().catch(() => null);
  if (biz?.adminPhone && String(biz.adminPhone).replace(/^\+/, '') === norm) return true;

  // Tenant-level admin
  const tenant = await Tenant.findById(tenantId).select('adminPhone').lean().catch(() => null);
  if (tenant?.adminPhone && String(tenant.adminPhone).replace(/^\+/, '') === norm) return true;

  return false;
}

// ── Admin button reply (APPROVE_xxx / REJECT_xxx) ─────────────────────────────
export async function handleAdminButtonReply(buttonId, tenantId, adminPhone, tenantDoc, business) {
  const upper = String(buttonId).toUpperCase();

  if (upper.startsWith('APPROVE_')) {
    const orderId = upper.replace('APPROVE_', '');
    return confirmPayment(orderId, tenantId, adminPhone, tenantDoc, business);
  }
  if (upper.startsWith('REJECT_')) {
    const orderId = upper.replace('REJECT_', '');
    return rejectPayment(orderId, tenantId, adminPhone, tenantDoc, business);
  }
  return null;
}

// ── Admin text command router ─────────────────────────────────────────────────
export async function handleAdminTextCommand(text, tenantId, adminPhone, tenantDoc, business) {
  const upper = text.trim().toUpperCase();

  // APPROVE <shortId>
  const approveMatch = upper.match(/^APPROVE\s+([A-F0-9]{4,24})$/);
  if (approveMatch) return confirmPayment(approveMatch[1], tenantId, adminPhone, tenantDoc, business);

  // REJECT <shortId>
  const rejectMatch = upper.match(/^REJECT\s+([A-F0-9]{4,24})$/);
  if (rejectMatch) return rejectPayment(rejectMatch[1], tenantId, adminPhone, tenantDoc, business);

  // CONFIRM BOOK <shortId>
  const confirmBookMatch = upper.match(/^CONFIRM\s+BOOK\s+([A-Z0-9]{4,8})$/);
  if (confirmBookMatch) return confirmBooking(confirmBookMatch[1], tenantId, adminPhone, tenantDoc);

  // DECLINE BOOK <shortId> [optional reason]
  const declineBookMatch = text.trim().match(/^DECLINE\s+BOOK\s+([A-Za-z0-9]{4,8})(?:\s+(.+))?$/i);
  if (declineBookMatch) return declineBooking(declineBookMatch[1], declineBookMatch[2] || null, tenantId, adminPhone, tenantDoc);

  // RESUME BOT <phone>
  const resumeMatch = upper.match(/^RESUME BOT\s+(\d+)$/);
  if (resumeMatch) return resumeBot(resumeMatch[1], tenantId, tenantDoc);

  return null;
}

// ── Confirm payment ───────────────────────────────────────────────────────────
async function confirmPayment(shortId, tenantId, adminPhone, tenantDoc, business) {
  const order = await Order.findOne({ $or: [{ shortId }, { _id: shortId.length === 24 ? shortId : undefined }], tenantId })
    .select('_id customerPhone status paymentStatus item quantity totalPrice').lean();
  if (!order) return `⚠️ No order found: ${shortId}`;
  if (order.paymentStatus === 'confirmed') return `ℹ️ Order #${shortId} already confirmed.`;

  await Order.updateOne({ _id: order._id }, { $set: {
    paymentStatus:     'confirmed',       // [FIX] now in enum
    status:            'confirmed',
    paymentReviewedBy: adminPhone,        // [FIX] schema field (was confirmedBy — not in schema)
    paymentReviewedAt: new Date(),        // [FIX] schema field (was confirmedAt — not in schema)
  } });
  await dispatchText(order.customerPhone, `✅ *Payment confirmed!*\n\nYour order *${order.item}* is now being processed. Thank you! 🙏`, tenantDoc);
  logger.info('[AdminCmd] Payment confirmed', { shortId, adminPhone });
  return (
    `✅ *Payment confirmed*\n\n` +
    `Order #${shortId} — ${order.item} × ${order.quantity || 1}\n` +
    `Amount: D${order.totalPrice || '—'}\n` +
    `Customer ${order.customerPhone} notified.`
  );
}

// ── Reject payment ────────────────────────────────────────────────────────────
async function rejectPayment(shortId, tenantId, adminPhone, tenantDoc, business) {
  const order = await Order.findOne({ $or: [{ shortId }, { _id: shortId.length === 24 ? shortId : undefined }], tenantId })
    .select('_id customerPhone status paymentStatus item').lean();
  if (!order) return `⚠️ No order found: ${shortId}`;
  if (order.status === 'cancelled') return `ℹ️ Order #${shortId} already cancelled.`;

  await Order.updateOne({ _id: order._id }, { $set: {
    paymentStatus:     'rejected',        // [FIX] now in enum (was 'rejected' which was missing)
    status:            'payment_failed',
    paymentReviewedBy: adminPhone,        // [FIX] schema field (was rejectedBy — not in schema)
    paymentReviewedAt: new Date(),        // [FIX] schema field (was rejectedAt — not in schema)
  } });
  await dispatchText(order.customerPhone,
    `❌ *Payment could not be verified.*\n\nPlease check the amount and Wave number, then resend your screenshot, or type *Order* to start again.`, tenantDoc);
  logger.info('[AdminCmd] Payment rejected', { shortId, adminPhone });
  return (
    `❌ *Payment rejected*\n\n` +
    `Order #${shortId} — ${order.item}\n` +
    `Customer ${order.customerPhone} notified to resend.`
  );
}

// ── Confirm booking ───────────────────────────────────────────────────────────
async function confirmBooking(shortId, tenantId, adminPhone, tenantDoc) {
  const booking = await Booking.findOne({ shortId: shortId.toUpperCase(), tenantId })
    .select('_id customerPhone date time service status customerName').lean();
  if (!booking) return `⚠️ No booking found: ${shortId}`;
  if (booking.status === 'confirmed') return `ℹ️ Booking #${shortId} already confirmed.`;

  await Booking.updateOne({ _id: booking._id }, { $set: { status: 'confirmed', adminConfirmedAt: new Date(), adminConfirmedBy: adminPhone } });
  const when = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
  const serviceStr = booking.service ? ` (${booking.service})` : '';
  await dispatchText(booking.customerPhone,
    `✅ *Booking Confirmed!*\n\nYour booking${serviceStr} for *${when}* is confirmed.\n\nWe look forward to seeing you! 😊`, tenantDoc);
  logger.info('[AdminCmd] Booking confirmed', { shortId, adminPhone });
  return (
    `✅ *Booking confirmed*\n\n` +
    `Booking #${shortId} — ${when}${serviceStr}\n` +
    `Customer ${booking.customerPhone} notified.`
  );
}

// ── Decline booking ───────────────────────────────────────────────────────────
async function declineBooking(shortId, reason, tenantId, adminPhone, tenantDoc) {
  const booking = await Booking.findOne({ shortId: shortId.toUpperCase(), tenantId })
    .select('_id customerPhone date time service status customerName').lean();
  if (!booking) return `⚠️ No booking found: ${shortId}`;
  if (booking.status === 'cancelled') return `ℹ️ Booking #${shortId} already cancelled.`;

  await Booking.updateOne({ _id: booking._id }, { $set: { status: 'cancelled', adminDeclinedAt: new Date(), adminDeclinedBy: adminPhone, adminNote: reason || null } });
  const when = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
  const serviceStr = booking.service ? ` (${booking.service})` : '';
  const reasonStr  = reason ? `\n\n*Reason:* ${reason}` : '';
  await dispatchText(booking.customerPhone,
    `❌ *Booking Unavailable*\n\nUnfortunately we can't confirm your booking${serviceStr} for *${when}*.${reasonStr}\n\nPlease contact us to arrange an alternative time.`, tenantDoc);
  logger.info('[AdminCmd] Booking declined', { shortId, adminPhone, reason });
  return `❌ *Booking declined*\n\nBooking #${shortId} — ${when}${serviceStr}${reason ? `\nReason: ${reason}` : ''}\nCustomer ${booking.customerPhone} notified.`;
}

// ── Resume bot ────────────────────────────────────────────────────────────────
async function resumeBot(customerPhone, tenantId, tenantDoc) {
  await updateSession(customerPhone, tenantId, { humanMode: false, humanModeNotified: false });

  // Notify the customer that the bot is back
  if (tenantDoc) {
    dispatchText(
      customerPhone,
      `✅ Our team has finished assisting you. Our automated assistant is back and ready to help! 😊\n\nType *menu* or *hi* to continue.`,
      tenantDoc,
    ).catch(() => {});
  }

  return `✅ *Bot resumed for ${customerPhone}*. Automation is active again.`;
}

// ── Build admin booking alert (includes shortId) ──────────────────────────────
// [FIX] Added shortId to alert so admin can use CONFIRM BOOK / DECLINE BOOK commands
export function buildAdminBookingAlert({ customerPhone, date, time, service, business, shortId }) {
  const bizName    = business?.name || 'Business';
  const serviceStr = service ? `\n🗓 Service: *${service}*` : '';
  const timeStr    = time    ? `\n⏰ Time: *${time}*`       : '';
  const idStr      = shortId ? `\n🔖 ID: \`${shortId}\``   : '';

  return (
    `🔔 *New Booking — ${bizName}*\n\n` +
    `👤 ${customerPhone}\n` +
    `📅 ${date}${timeStr}${serviceStr}${idStr}\n\n` +
    `Reply:\n` +
    `✅ \`CONFIRM BOOK ${shortId || '?'}\`\n` +
    `❌ \`DECLINE BOOK ${shortId || '?'} <reason>\``
  );
}
