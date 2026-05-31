/**
 * services/schedulerService.js — WhatSalesAgent2
 *
 * Three background jobs (all opt-in via SCHEDULER_ENABLED=true):
 *   1. Abandoned cart reminders  — every 15 min
 *   2. Booking reminders         — every 60 min
 *   3. Payment proof reminders   — every 20 min
 *
 * [FIX] All three jobs previously used { $exists: false } on fields with
 *       default:null in their schemas. MongoDB writes null on create, so
 *       $exists:false never matched anything. Changed to null queries.
 * [FIX] sendBookingReminderTemplate now receives customerName.
 * [FIX] Strategy A (parsedDate) runs for all bookings — ordinal stripping
 *       ensures parsedDate is populated correctly at create time.
 */

import Order   from '../models/Order.js';
import Booking from '../models/Booking.js';
import Tenant  from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { dispatchText } from '../core/whatsapp/dispatcher.js';
import logger from '../config/logger.js';

let _timers = [];

export function startScheduler() {
  if (process.env.SCHEDULER_ENABLED !== 'true') {
    logger.info('[Scheduler] Disabled (SCHEDULER_ENABLED != true)');
    return;
  }
  logger.info('[Scheduler] Starting jobs...');
  _timers.push(setInterval(() => runAbandonedCartJob().catch(e => logger.error('[Scheduler] abandoned cart', { e: e.message })), 15 * 60 * 1000));
  _timers.push(setInterval(() => runBookingReminderJob().catch(e => logger.error('[Scheduler] booking reminder', { e: e.message })), 60 * 60 * 1000));
  _timers.push(setInterval(() => runPaymentReminderJob().catch(e => logger.error('[Scheduler] payment reminder', { e: e.message })), 20 * 60 * 1000));
  logger.info('[Scheduler] 3 jobs running');
}

export function stopScheduler() {
  _timers.forEach(t => clearInterval(t));
  _timers = [];
}

// ── Helper: load tenant + business for a phone number ───────────────────────
async function loadContext(tenantId) {
  const [tenant, business] = await Promise.all([
    Tenant.findById(tenantId).lean(),
    BusinessConfig.findOne({ tenantId }).lean(),
  ]);
  return { tenant, business };
}

// ─── Job 1: Abandoned Cart ────────────────────────────────────────────────────
async function runAbandonedCartJob() {
  const now     = new Date();
  const hourAgo = new Date(now - 60 * 60 * 1000);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  // [FIX] abandonedCartAt: null — not $exists:false
  const orders = await Order.find({
    status:         'pending',
    paymentStatus:  'unpaid',
    createdAt:      { $gte: weekAgo, $lte: hourAgo },
    abandonedCartAt: null,
  }).lean();

  logger.info(`[Scheduler] Abandoned cart: ${orders.length} candidates`);

  for (const order of orders) {
    try {
      const { tenant, business } = await loadContext(order.tenantId);
      if (!tenant || !business) continue;

      const bizName = business.name || 'us';
      const msg =
        `👋 Hey! You left *${order.item}* in your cart.\n\n` +
        `Complete your order — tap *Order* to pick up where you left off!\n\n` +
        `_(Reply *Stop* to opt out of reminders)_`;

      await dispatchText(order.customerPhone, msg, tenant);
      await Order.updateOne({ _id: order._id }, { $set: { abandonedCartAt: new Date() } });
      logger.info('[Scheduler] Abandoned cart sent', { phone: order.customerPhone });
    } catch (err) {
      logger.error('[Scheduler] Abandoned cart send failed', { err: err.message, orderId: order._id });
    }
  }
}

// ─── Job 2: Booking Reminders ─────────────────────────────────────────────────
async function runBookingReminderJob() {
  const now     = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  // [FIX] Status includes both pending and confirmed (bookings are created as pending)
  // [FIX] reminderSentAt: null — not $exists:false
  const bookings = await Booking.find({
    status:         { $in: ['pending', 'confirmed'] },
    createdAt:      { $gte: weekAgo },
    reminderSentAt: null,
  }).lean();

  logger.info(`[Scheduler] Booking reminders: ${bookings.length} candidates`);

  for (const booking of bookings) {
    try {
      const { tenant, business } = await loadContext(booking.tenantId);
      if (!tenant || !business) continue;

      const shouldSend = decideShouldSendReminder(booking, now);
      if (!shouldSend) continue;

      const when       = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
      const serviceStr = booking.service ? ` for *${booking.service}*` : '';
      // [FIX] customerName now populated at booking creation — use it here
      const nameStr    = booking.customerName ? `Hi *${booking.customerName}*, r` : 'R';

      const msg =
        `📅 *Booking Reminder*\n\n` +
        `${nameStr}eminder about your upcoming booking${serviceStr} at *${business.name || 'us'}*.\n\n` +
        `📅 *${when}*\n\n` +
        `See you soon! 😊`;

      await dispatchText(booking.customerPhone, msg, tenant);
      await Booking.updateOne({ _id: booking._id }, { $set: { reminderSentAt: new Date() } });
      logger.info('[Scheduler] Booking reminder sent', { phone: booking.customerPhone, when });
    } catch (err) {
      logger.error('[Scheduler] Booking reminder failed', { err: err.message, bookingId: booking._id });
    }
  }
}

function decideShouldSendReminder(booking, now) {
  // Strategy A: parsedDate known → remind 24–36h before appointment.
  // [FIX-7] Add 30-min tolerance on the upper bound too: a job that runs
  // a minute early would otherwise miss a booking at exactly 36h01m.
  if (booking.parsedDate) {
    const msUntil = new Date(booking.parsedDate).getTime() - now.getTime();
    const h24     = 24 * 60 * 60 * 1000;
    const h36     = 36 * 60 * 60 * 1000;
    const slack   = 30 * 60 * 1000; // 30 minutes
    return msUntil > 0 && msUntil <= h36 + slack && msUntil >= h24 - slack;
  }
  // Strategy B: no parsedDate → send in the 18–20 UTC evening window
  const hour = now.getUTCHours();
  return hour >= 18 && hour < 20;
}

// ─── Job 3: Payment Proof Reminders ──────────────────────────────────────────
async function runPaymentReminderJob() {
  const now         = new Date();
  const thirtyAgo   = new Date(now - 30 * 60 * 1000);
  const fourHoursAgo= new Date(now - 4 * 60 * 60 * 1000);

  // [FIX] paymentReminderSentAt: null — not $exists:false
  const orders = await Order.find({
    paymentStatus:       'unpaid',
    status:              'pending',
    createdAt:           { $gte: fourHoursAgo, $lte: thirtyAgo },
    paymentReminderSentAt: null,
  }).lean();

  logger.info(`[Scheduler] Payment reminders: ${orders.length} candidates`);

  for (const order of orders) {
    try {
      const { tenant, business } = await loadContext(order.tenantId);
      if (!tenant?.whatsapp || !business?.payment?.enabled) continue;

      const waveNo = business.payment.wavePhone || business.payment.phone || 'N/A';
      const msg =
        `💳 *Payment Reminder*\n\n` +
        `Your order of *${order.item}* is awaiting payment.\n\n` +
        `💰 Total: *D${order.totalPrice || '—'}*\n` +
        `📲 Pay via Wave to: *${waveNo}*\n\n` +
        `Send your screenshot here once done! 📸`;

      await dispatchText(order.customerPhone, msg, tenant);
      await Order.updateOne({ _id: order._id }, { $set: { paymentReminderSentAt: new Date() } });
      logger.info('[Scheduler] Payment reminder sent', { phone: order.customerPhone });
    } catch (err) {
      logger.error('[Scheduler] Payment reminder failed', { err: err.message, orderId: order._id });
    }
  }
}
