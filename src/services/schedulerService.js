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
import { formatMoney } from '../utils/formatCurrency.js';

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

// [FIX-SCHED-OVERLAP] Each job below marks an order/booking "reminded" only
// AFTER awaiting the WhatsApp send, one record at a time in a sequential
// for-loop. None of that work was previously guarded against re-entrancy, so
// if a single run ever took longer than its own setInterval period (a slow
// Meta API response, a large candidate batch, a transient network stall),
// the next tick started a SECOND overlapping run of the same job. That
// second run's query would still see every record the first run hadn't
// reached yet as unmarked, and would send the exact same customer the exact
// same reminder a second time — an abandoned-cart nudge, booking reminder,
// or payment reminder arriving twice in quick succession. wrapWithGuard()
// makes each job a no-op re-entry (skip + log) while a previous invocation
// of THAT SAME job is still in flight, so a slow run delays the next run
// instead of doubling up on customer messages.
const _runningJobs = new Set();

// Exported so the re-entrancy guard itself can be unit-tested directly
// (schedulerJobOverlapGuard.test.mjs) without needing to mock Mongoose models
// or fake setInterval timing to exercise the overlap scenario end-to-end.
export function wrapWithGuard(name, fn) {
  return async () => {
    if (_runningJobs.has(name)) {
      logger.warn(`[Scheduler] ${name} skipped — previous run still in progress`);
      return;
    }
    _runningJobs.add(name);
    try {
      await fn();
    } finally {
      _runningJobs.delete(name);
    }
  };
}

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
  const guardedAbandonedCart      = wrapWithGuard('abandoned cart',           runAbandonedCartJob);
  const guardedBookingReminder    = wrapWithGuard('booking reminder',         runBookingReminderJob);
  const guardedPaymentReminder    = wrapWithGuard('payment reminder',         runPaymentReminderJob);
  const guardedPostAppointmentFU  = wrapWithGuard('post-appointment follow-up', runPostAppointmentFollowUpJob);
  _timers.push(setInterval(() => guardedAbandonedCart().catch(e => logger.error('[Scheduler] abandoned cart', { e: e.message })), 15 * 60 * 1000));
  _timers.push(setInterval(() => guardedBookingReminder().catch(e => logger.error('[Scheduler] booking reminder', { e: e.message })), 60 * 60 * 1000));
  _timers.push(setInterval(() => guardedPaymentReminder().catch(e => logger.error('[Scheduler] payment reminder', { e: e.message })), 20 * 60 * 1000));
  // [v15-FOLLOWUP] Post-appointment follow-up: 3 days after a completed booking,
  // check in with the customer and offer to rebook. Runs every 6 hours.
  _timers.push(setInterval(() => guardedPostAppointmentFU().catch(e => logger.error('[Scheduler] post-appointment follow-up', { e: e.message })), 6 * 60 * 60 * 1000));
  logger.info('[Scheduler] 4 jobs running');
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
  // [FIX-WALKIN-SCHED] Exclude walk-in bookings: bookingType='walkin' entries have
  // date=today and time='Walk-In' with no parsedDate, so Strategy A never fires and
  // Strategy B would send a nonsensical "reminder about your upcoming booking" the
  // same evening the customer already walked in. Walk-ins are transient queue entries
  // — not scheduled appointments — so they should never receive date-based reminders.
  const bookings = await Booking.find({
    status:         { $in: ['pending', 'confirmed'] },
    bookingType:    { $ne: 'walkin' },
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
      const mode       = (business?.businessMode || '').toUpperCase();
      const isSalon    = mode === 'SALON' || mode === 'BARBERSHOP';
      const staffStr   = (isSalon && booking.staff) ? `\n👤 ${mode === 'BARBERSHOP' ? 'Barber' : 'Stylist'}: *${booking.staff}*` : '';

      // [v14-PREP] Include service-specific prep tip in the reminder for salon bookings
      let prepLine = '';
      if (isSalon) {
        try {
          const { getSalonPrepTip } = await import('../modules/salon/salonHelpers.js');
          const tip = getSalonPrepTip(booking.service, business);
          if (tip) prepLine = `\n\n💡 *Tip:* ${tip}`;
        } catch {}
      }

      const fallbackText = isSalon
        ? `📅 *Appointment Reminder*\n\nHi *${nameStr}*! Just a reminder about your upcoming *${serviceStr}* at *${business.name || 'us'}*.${staffStr}\n\n📅 *${when}*${prepLine}\n\nSee you soon! 💇`
        : `📅 *Booking Reminder*\n\nHi *${nameStr}*, reminder about your upcoming booking for *${serviceStr}* at *${business.name || 'us'}*.\n\n📅 *${when}*\n\nSee you soon! 😊`;

      await sendReminder({
        phone:           booking.customerPhone,
        tenant,
        templateNameStr: templateName.bookingReminder(),
        components:      buildBookingReminderComponents(nameStr, serviceStr, when, business.name),
        fallbackText,
      });

      await Booking.updateOne({ _id: booking._id }, { $set: { reminderSentAt: new Date() } });

      // [v14-POSTFLOW] Set postFlowAck so that when the customer replies to the reminder,
      // postFlowHandler routes them to the APPOINTMENT_REMINDER case which shows
      // confirm/reschedule/cancel buttons — not generic intent detection.
      // Without this, any reply to the reminder (even "ok 👍") would fall through to
      // AI classify and potentially trigger a SUPPORT escalation.
      const { updateSession: _updateSess } = await import('../core/sessions/sessionService.js');
      await _updateSess(booking.customerPhone, booking.tenantId, {
        postFlowAck:  'APPOINTMENT_REMINDER',
        postFlowData: {
          service:     booking.service || null,
          date:        booking.date    || null,
          time:        booking.time    || null,
          staff:       booking.staff   || null,
          shortId:     booking.shortId || null,
          bookingType: booking.bookingType || 'appointment',
        },
      }).catch(() => {});

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
          `💰 Total: *${currency}${formatMoney(amount)}*\n` +
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

// ─── Job 4: Post-Appointment Follow-Up ───────────────────────────────────────
// [v15-FOLLOWUP] Sends a follow-up message ~3 days after a completed/confirmed
// salon appointment to check in and offer to rebook. Increases retention.
// Only fires for SALON and BARBERSHOP businesses.
async function runPostAppointmentFollowUpJob() {
  const now         = new Date();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const fourDaysAgo  = new Date(now - 4 * 24 * 60 * 60 * 1000);

  // Find confirmed salon bookings 3–4 days old that haven't had a follow-up sent.
  // We check for confirmed (admin approved) appointments only — not declined.
  // The follow-up window is 3–4 days to avoid sending too early or too late.
  const bookings = await Booking.find({
    status:              'confirmed',
    bookingType:         { $ne: 'walkin' },
    followUpSentAt:      null,  // [FIX-SCHED-FU-2] field default is null, $exists:false never matches
    adminConfirmedAt:    { $gte: fourDaysAgo, $lte: threeDaysAgo },
  }).lean();

  if (!bookings.length) return;
  logger.info(`[Scheduler] Post-appointment follow-up: ${bookings.length} candidates`);

  for (const booking of bookings) {
    try {
      const { tenant, business } = await loadContext(booking.tenantId);
      if (!tenant || !business) continue;
      if (tenant.status !== 'ACTIVE') continue;

      // Only fire for salon/barbershop businesses
      const mode = (business?.businessMode || '').toUpperCase();
      if (mode !== 'SALON' && mode !== 'BARBERSHOP') continue;

      const isBarbershop = mode === 'BARBERSHOP';
      const emoji        = isBarbershop ? '✂️' : '💇';
      const nameStr      = booking.customerName || 'there';
      const serviceStr   = booking.service || 'your appointment';
      const bizName      = business.name || (isBarbershop ? 'the barbershop' : 'the salon');
      const staffStr     = booking.staff ? ` with *${booking.staff}*` : '';

      const followUpText =
        `${emoji} *How are you feeling after your ${serviceStr}?*\n\n` +
        `Hi *${nameStr}*! We hope you loved the results${staffStr} at *${bizName}*. 😊\n\n` +
        `💬 We'd love to hear your feedback — just reply here!\n\n` +
        `Ready to book your next appointment? We're here whenever you are 🙏`;

      // [FIX-SCHED] Send interactive follow-up first (rebook button), fall back to template
      const { dispatchMessage: _dispFU } = await import('../core/whatsapp/dispatcher.js');
      const _isBarbershopFU = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
      // [AUDIT-FIX-3] dispatchMessage() never rejects — it catches its own fetch/network
      // errors internally and, on a non-2xx Meta response (e.g. the 24h-window rejection
      // this fallback exists to catch), logs and resolves with the Response object instead
      // of throwing. The previous `.catch(async () => {...})` here could therefore never
      // run: a failed interactive send would resolve normally, the template fallback would
      // never fire, and the customer outside the 24h window would silently get nothing —
      // while followUpSentAt still gets stamped below, so the job never retries either.
      // Fixed by inspecting the resolved result instead of relying on rejection: SIM mode
      // returns {simulated:true}, a genuine success returns a Response with ok:true: both
      // are treated as delivered. Anything else (undefined, or a Response with ok:false)
      // triggers the template fallback exactly as originally intended.
      const _dispFUResult = await _dispFU(booking.customerPhone, {
        type:    'buttons',
        body:    followUpText,
        buttons: [
          { id: 'BOOK',     title: `${_isBarbershopFU ? '💈' : '💇'} Book Again` },
          { id: 'QUESTION', title: '❓ Ask a Question'                            },
        ],
      }, tenant).catch(() => null);
      const _dispFUDelivered = !!_dispFUResult && (_dispFUResult.simulated === true || _dispFUResult.ok === true);
      if (!_dispFUDelivered) {
        // Plain-text interactive failed (24h window) — fall back to template.
        await sendReminder({
          phone:           booking.customerPhone,
          tenant,
          templateNameStr: 'appointment_follow_up',
          components:      buildBookingReminderComponents(nameStr, serviceStr, 'your recent visit', bizName),
          fallbackText:    followUpText,
        });
      }
      // [FIX-SCHED-FU-1] Mark follow-up sent and set postFlowAck OUTSIDE the .catch() block
      // so they always run on success, not only when dispatchMessage fails.
      // Previously the closing }) for sendReminder was misplaced — all post-send
      // bookkeeping (Booking.updateOne, updateSession, logger.info) was inside the
      // .catch() handler and therefore only ran when the primary dispatchMessage threw.
      // On a successful send nothing was persisted, causing the job to re-fire every 6h.
      await Booking.updateOne(
        { _id: booking._id },
        { $set: { followUpSentAt: now } }
      );

      // Set postFlowAck so any reply is handled contextually
      const { updateSession: _updSess } = await import('../core/sessions/sessionService.js');
      await _updSess(booking.customerPhone, booking.tenantId, {
        postFlowAck:  'BOOKING_CONFIRMED',
        postFlowData: {
          service:     booking.service    || null,
          date:        booking.date       || null,
          time:        booking.time       || null,
          staff:       booking.staff      || null,
          bookingType: booking.bookingType || 'appointment',
        },
      }).catch(() => {});

      logger.info('[Scheduler] Post-appointment follow-up sent', {
        phone: booking.customerPhone, service: booking.service,
      });
    } catch (err) {
      logger.error('[Scheduler] Post-appointment follow-up failed', {
        err: err.message, bookingId: booking._id,
      });
    }
  }
}
