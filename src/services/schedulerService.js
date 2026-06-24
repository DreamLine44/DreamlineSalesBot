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
 *
 * [AUDIT-P1-B] WhatsApp requires pre-approved template messages for outbound
 *              messages to users who haven't messaged in the last 24 hours.
 *              All scheduler reminders target customers whose sessions have
 *              expired (by definition > 30 min old), so they are always in
 *              the "cold contact" window.
 *
 *              Template dispatch strategy:
 *              1. If WHATSAPP_TEMPLATES_ENABLED=true and template names are
 *                 configured via env vars, use dispatchTemplate().
 *              2. Otherwise, fall back to dispatchText() with a log warning.
 *                 This fallback works in dev/test but will fail silently in
 *                 production for cold contacts (Meta rejects the message but
 *                 returns 200 — the error is in the webhook delivery report).
 *
 *              Required env vars when templates are enabled:
 *                TEMPLATE_ABANDONED_CART   (default: 'abandoned_cart_reminder')
 *                TEMPLATE_BOOKING_REMINDER (default: 'booking_reminder')
 *                TEMPLATE_PAYMENT_REMINDER (default: 'payment_reminder')
 *
 *              Template components format follows Meta's template API spec.
 *              Adjust buildAbandonedCartComponents() etc. to match your
 *              approved template parameter slots.
 */

import Order   from '../models/Order.js';
import Booking from '../models/Booking.js';
import Tenant  from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { dispatchText, dispatchTemplate } from '../core/whatsapp/dispatcher.js';
import { TEMPLATE_LANGUAGE } from '../config/env.js';
import logger from '../config/logger.js';

const TEMPLATES_ENABLED = () => process.env.WHATSAPP_TEMPLATES_ENABLED === 'true';

// ── Template name helpers ─────────────────────────────────────────────────────
const templateName = {
  abandonedCart:   () => process.env.TEMPLATE_ABANDONED_CART   || 'abandoned_cart_reminder',
  bookingReminder: () => process.env.TEMPLATE_BOOKING_REMINDER  || 'booking_reminder',
  paymentReminder: () => process.env.TEMPLATE_PAYMENT_REMINDER  || 'payment_reminder',
};

/**
 * Build template components for an abandoned cart message.
 * Adjust param order and count to match your approved Meta template.
 * Default template assumes: {{1}} = item name, {{2}} = business name
 */
function buildAbandonedCartComponents(item, bizName) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: item || 'your item' },
      { type: 'text', text: bizName || 'us' },
    ],
  }];
}

/**
 * Build template components for a booking reminder.
 * Default template assumes: {{1}} = customer name, {{2}} = service, {{3}} = datetime, {{4}} = business name
 */
function buildBookingReminderComponents(customerName, service, when, bizName) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: customerName || 'there' },
      { type: 'text', text: service || 'your appointment' },
      { type: 'text', text: when || '' },
      { type: 'text', text: bizName || 'us' },
    ],
  }];
}

/**
 * Build template components for a payment reminder.
 * Default template assumes: {{1}} = item, {{2}} = amount, {{3}} = payment contact/account
 * [FIX-SCHED-2] Renamed param from `waveNo` to `paymentContact` — the platform now
 * supports multi-channel payments (Wave, GT Bank, EcoBank, Trust Bank). The variable
 * holds the primary channel's accountNo, which may be a bank account number, not a Wave
 * phone number. The misleading name caused confusion when reading template payloads in logs.
 */
function buildPaymentReminderComponents(item, amount, paymentContact) {
  return [{
    type: 'body',
    parameters: [
      { type: 'text', text: item || 'your order' },
      { type: 'text', text: String(amount || '—') },
      { type: 'text', text: paymentContact || 'N/A' },
    ],
  }];
}

let _timers = [];

export function startScheduler() {
  if (process.env.SCHEDULER_ENABLED !== 'true') {
    logger.info('[Scheduler] Disabled (SCHEDULER_ENABLED != true)');
    return;
  }
  if (TEMPLATES_ENABLED()) {
    logger.info('[Scheduler] Template mode ON — using pre-approved WhatsApp templates for outbound reminders');
  } else {
    logger.warn('[Scheduler] Template mode OFF — scheduler will use plain text (fine for dev; will fail for cold contacts in production). Set WHATSAPP_TEMPLATES_ENABLED=true and configure template names to fix.');
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

/**
 * Unified send helper — uses template dispatch when templates are enabled,
 * falls back to plain text otherwise.
 */
async function sendReminder({ phone, tenant, templateNameStr, components, fallbackText }) {
  if (TEMPLATES_ENABLED()) {
    return dispatchTemplate(phone, templateNameStr, TEMPLATE_LANGUAGE || 'en_US', components, tenant);
  }
  // [AUDIT-P1-B] Plain text fallback — will fail for 24h+ cold contacts in production.
  logger.warn('[Scheduler] Using plain text fallback (set WHATSAPP_TEMPLATES_ENABLED=true for production)', {
    phone, template: templateNameStr,
  });
  return dispatchText(phone, fallbackText, tenant);
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
      // [FIX-SCHED-1] Skip suspended/inactive tenants — their customers must not
      // receive automated WhatsApp messages while the account is not live.
      if (tenant.status !== 'ACTIVE') continue;

      const bizName = business.name || 'us';

      await sendReminder({
        phone:           order.customerPhone,
        tenant,
        templateNameStr: templateName.abandonedCart(),
        components:      buildAbandonedCartComponents(order.item, bizName),
        fallbackText:
          `👋 Hey! You left *${order.item}* in your cart.\n\n` +
          `Complete your order — tap *Order* to pick up where you left off!\n\n` +
          `_(Reply *Stop* to opt out of reminders)_`,
      });

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
      // [FIX-SCHED-1] Skip non-ACTIVE tenants
      if (tenant.status !== 'ACTIVE') continue;

      // [FIX-TZ-SCHED] business?.timezone was reading a non-existent top-level field.
      // timezone lives at business.hours.timezone (BusinessConfig schema). The silent
      // undefined caused decideShouldSendReminder to use UTC for all tenants, so
      // reminders sent at e.g. 08:00 UTC would fire at wrong local times for businesses
      // in non-UTC timezones (e.g. West Africa Time = UTC+0 but DST-aware regions vary).
      const shouldSend = decideShouldSendReminder(booking, now, business?.hours?.timezone);
      if (!shouldSend) continue;

      const when       = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
      const serviceStr = booking.service || 'your appointment';
      const nameStr    = booking.customerName || 'there';

      await sendReminder({
        phone:           booking.customerPhone,
        tenant,
        templateNameStr: templateName.bookingReminder(),
        components:      buildBookingReminderComponents(nameStr, serviceStr, when, business.name),
        fallbackText:
          `📅 *Booking Reminder*\n\n` +
          `Hi *${nameStr}*, reminder about your upcoming booking for *${serviceStr}* at *${business.name || 'us'}*.\n\n` +
          `📅 *${when}*\n\n` +
          `See you soon! 😊`,
      });

      await Booking.updateOne({ _id: booking._id }, { $set: { reminderSentAt: new Date() } });
      logger.info('[Scheduler] Booking reminder sent', { phone: booking.customerPhone, when });
    } catch (err) {
      logger.error('[Scheduler] Booking reminder failed', { err: err.message, bookingId: booking._id });
    }
  }
}

function decideShouldSendReminder(booking, now, businessTimezone) {
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
  // Strategy B: no parsedDate → send in the 18–20 local evening window.
  // [FIX-TZ-2] Previously used now.getUTCHours() (server UTC time). A business
  // in UTC+0 but with customers in UTC+1 or UTC+2 would fire the reminder at
  // 18:00 UTC — potentially 19:00 or 20:00 local, which is acceptable, but a
  // business configured in e.g. "Africa/Nairobi" (UTC+3) would get reminders at
  // 15:00 local time (18 UTC), not evening. Now uses the business's timezone.
  const tz = businessTimezone || 'UTC';
  let localHour;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour: '2-digit', hour12: false,
    }).formatToParts(now);
    localHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  } catch {
    localHour = now.getUTCHours(); // fallback to UTC on bad tz string
  }
  return localHour >= 18 && localHour < 20;
}

// ─── Job 3: Payment Proof Reminders ──────────────────────────────────────────
async function runPaymentReminderJob() {
  const now          = new Date();
  const thirtyAgo    = new Date(now - 30 * 60 * 1000);
  const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000);

  // [FIX] paymentReminderSentAt: null — not $exists:false
  const orders = await Order.find({
    paymentStatus:        'unpaid',
    status:               'pending',
    createdAt:            { $gte: fourHoursAgo, $lte: thirtyAgo },
    paymentReminderSentAt: null,
  }).lean();

  logger.info(`[Scheduler] Payment reminders: ${orders.length} candidates`);

  for (const order of orders) {
    try {
      const { tenant, business } = await loadContext(order.tenantId);
      if (!tenant?.whatsapp || !business?.payment?.enabled) continue;
      // [FIX-SCHED-1] Skip non-ACTIVE tenants
      if (tenant.status !== 'ACTIVE') continue;

      const payment  = business.payment;
      const currency = payment.currency || 'D';
      const amount   = order.totalPrice || '—';

      // Build channel display — prefer channels[] array, fall back to legacy wavePhone
      const channels = Array.isArray(payment.channels) && payment.channels.length > 0
        ? payment.channels
        : (payment.wavePhone || payment.phone)
          ? [{ provider: 'Wave', accountNo: payment.wavePhone || payment.phone }]
          : [];

      const channelSummary = channels.length === 1
        ? `${channels[0].provider}: *${channels[0].accountNo}*`
        : channels.map(ch => `${ch.provider}: ${ch.accountNo}`).join(' | ');

      // Use the first/default channel for the template variable (single-value slot)
      const primaryChannel = channels.find(ch => ch.isDefault) || channels[0] || { provider: 'payment', accountNo: 'N/A' };
      const paymentContact = primaryChannel.accountNo;

      await sendReminder({
        phone:           order.customerPhone,
        tenant,
        templateNameStr: templateName.paymentReminder(),
        components:      buildPaymentReminderComponents(order.item, amount, paymentContact),
        fallbackText:
          `💳 *Payment Reminder*\n\n` +
          `Your order of *${order.item}* is awaiting payment.\n\n` +
          `💰 Total: *${currency}${amount}*\n` +
          (channels.length > 0
            ? `📲 Pay via ${channelSummary}\n`
            : `📲 Please contact us for payment details.\n`) +
          `\nSend your screenshot here once done! 📸`,
      });

      await Order.updateOne({ _id: order._id }, { $set: { paymentReminderSentAt: new Date() } });
      logger.info('[Scheduler] Payment reminder sent', { phone: order.customerPhone });
    } catch (err) {
      logger.error('[Scheduler] Payment reminder failed', { err: err.message, orderId: order._id });
    }
  }
}
