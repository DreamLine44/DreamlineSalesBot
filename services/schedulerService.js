/**
 * services/schedulerService.js — v13.0
 *
 * FIXES IN v13:
 * [SC-1] Abandoned cart job now queries by tenantId index and batches
 *        Tenant/BusinessConfig lookups per unique tenantId (not per order)
 *        to avoid N+2 DB round-trips under high order volume.
 * [SC-2] Booking reminder job: date comparison fixed. The stored booking.date
 *        is a free-text string (e.g. "25 June", "tomorrow") — comparing it
 *        against ISO date range was always wrong. Now the job looks for
 *        bookings where createdAt is within the next 24h AND reminderSentAt
 *        is not set, regardless of date format. A future improvement would
 *        parse and normalise booking dates at creation time.
 * [SC-3] Payment reminder job: updated cutoff window to 48h (aligns with
 *        paymentService.receiveProof's extended window in v13).
 * [SC-4] All jobs now use Promise.allSettled() for inner loops so a single
 *        failed order/booking doesn't abort the remaining batch.
 * [SC-5] startScheduler logs the exact intervals so ops can verify settings
 *        without reading source code.
 */

import mongoose       from 'mongoose';
import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Tenant         from '../models/Tenant.js';
import BusinessConfig from '../models/BusinessConfig.js';
import {
  sendAbandonedCartTemplate,
  sendBookingReminderTemplate,
  sendPaymentReminderTemplate,
} from './templateService.js';
import logger from '../config/logger.js';

const ENABLED = process.env.SCHEDULER_ENABLED === 'true';

const CART_INTERVAL_MS             = 15 * 60 * 1000;
const PAYMENT_REMINDER_INTERVAL_MS = 20 * 60 * 1000;
const BOOKING_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

// ─── Job 1: Abandoned cart recovery ──────────────────────────────────────────

async function runAbandonedCartJob() {
  logger.info('[Scheduler] Running abandoned cart job...');

  const cutoff    = new Date(Date.now() - 60 * 60 * 1000);       // > 1h ago
  const threshold = new Date(Date.now() - 48 * 60 * 60 * 1000);  // < 48h ago

  try {
    const staleOrders = await Order.find({
      status:          'pending',
      createdAt:       { $lt: cutoff, $gt: threshold },
      abandonedCartAt: { $exists: false },
    }).lean();

    if (!staleOrders.length) {
      logger.info('[Scheduler] Abandoned cart: no pending orders found.');
      return;
    }

    logger.info(`[Scheduler] Abandoned cart: found ${staleOrders.length} stale orders.`);

    // [SC-1] Group by tenantId to batch DB lookups
    const tenantIds = [...new Set(staleOrders.map(o => String(o.tenantId)))];
    const tenantMap = new Map();
    const bizMap    = new Map();

    await Promise.allSettled(tenantIds.map(async (tid) => {
      const tenant = await Tenant.findById(tid).lean().catch(() => null);
      if (tenant) tenantMap.set(tid, tenant);
      const biz = await BusinessConfig.findOne({ tenantId: tid }).lean().catch(() => null);
      if (biz) bizMap.set(tid, biz);
    }));

    // [SC-4] Process each order — failures don't abort the batch
    await Promise.allSettled(staleOrders.map(async (order) => {
      const tid     = String(order.tenantId);
      const tenant  = tenantMap.get(tid);
      const business = bizMap.get(tid);

      if (!tenant || tenant.status !== 'ACTIVE') return;

      try {
        const sent = await sendAbandonedCartTemplate({
          to:           order.customerPhone,
          customerName: null,
          business,
          tenant,
        });

        if (sent) {
          await Order.updateOne(
            { _id: order._id },
            { $set: { abandonedCartAt: new Date() } }
          );
          logger.info(`[Scheduler] Abandoned cart sent to ${order.customerPhone} for order ${order._id}`);
        }
      } catch (err) {
        logger.error(`[Scheduler] Abandoned cart failed for order ${order._id}: ${err.message}`);
      }
    }));

  } catch (err) {
    logger.error(`[Scheduler] Abandoned cart job error: ${err.message}`);
  }
}

// ─── Job 2: Booking reminder ──────────────────────────────────────────────────
// Fires for confirmed bookings that haven't yet received a reminder.
// Strategy (in priority order):
//   A) parsedDate is set → remind 24h before the booking date (accurate)
//   B) parsedDate is null → fall back to SC-2 createdAt window, evening window only
// This allows gradual migration: old bookings (no parsedDate) still get reminded;
// new bookings (parsedDate populated by tryParseDate) get reminded at the right time.

async function runBookingReminderJob() {
  logger.info('[Scheduler] Running booking reminder job...');

  const now     = new Date();
  const hour    = now.getUTCHours();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    // Fetch all unreminded confirmed bookings created in the last 7 days
    const bookings = await Booking.find({
      status:         'confirmed',
      createdAt:      { $gte: weekAgo },
      reminderSentAt: { $exists: false },
    }).lean();

    if (!bookings.length) {
      logger.info('[Scheduler] Booking reminder: no bookings to remind.');
      return;
    }

    logger.info(`[Scheduler] Booking reminder: found ${bookings.length} candidates.`);

    await Promise.allSettled(bookings.map(async (booking) => {
      try {
        // Decide whether this booking should be reminded now
        let shouldRemind = false;

        if (booking.parsedDate) {
          // Strategy A: remind in the 24h window before the parsed booking date
          const msUntil = booking.parsedDate.getTime() - now.getTime();
          shouldRemind  = msUntil > 0 && msUntil <= 24 * 60 * 60 * 1000;
        } else {
          // Strategy B (legacy): evening UTC window only
          shouldRemind = hour >= 18 && hour <= 20;
        }

        if (!shouldRemind) return;

        const tenant = await Tenant.findById(booking.tenantId).lean();
        if (!tenant || tenant.status !== 'ACTIVE') return;

        const business = await BusinessConfig.findOne({ tenantId: booking.tenantId }).lean();

        const sent = await sendBookingReminderTemplate({
          to:          booking.customerPhone,
          business,
          bookingTime: booking.time ? `${booking.date} at ${booking.time}` : booking.date,
          tenant,
        });

        if (sent) {
          await Booking.updateOne(
            { _id: booking._id },
            { $set: { reminderSentAt: new Date() } }
          );
          logger.info(`[Scheduler] Booking reminder sent to ${booking.customerPhone}`);
        }
      } catch (err) {
        logger.error(`[Scheduler] Booking reminder failed for booking ${booking._id}: ${err.message}`);
      }
    }));

  } catch (err) {
    logger.error(`[Scheduler] Booking reminder job error: ${err.message}`);
  }
}

// ─── Job 3: Payment proof reminder ───────────────────────────────────────────

async function runPaymentReminderJob() {
  logger.info('[Scheduler] Running payment reminder job...');

  const minAge = new Date(Date.now() - 30  * 60 * 1000);          // 30 min ago
  const maxAge = new Date(Date.now() - 48  * 60 * 60 * 1000);     // [SC-3] 48h ago

  try {
    const pendingOrders = await Order.find({
      status:                'pending',
      paymentStatus:         'unpaid',
      createdAt:             { $lt: minAge, $gt: maxAge },
      paymentReminderSentAt: { $exists: false },
    }).lean();

    if (!pendingOrders.length) {
      logger.info('[Scheduler] Payment reminder: no pending orders.');
      return;
    }

    logger.info(`[Scheduler] Payment reminder: ${pendingOrders.length} orders need nudge.`);

    // [SC-4] allSettled
    await Promise.allSettled(pendingOrders.map(async (order) => {
      try {
        const tenant = await Tenant.findById(order.tenantId).lean();
        if (!tenant || tenant.status !== 'ACTIVE') return;

        const business = await BusinessConfig.findOne({ tenantId: order.tenantId }).lean();

        if (!business?.payment?.wavePhone && !business?.wavePhone) return;

        const sent = await sendPaymentReminderTemplate({
          to:       order.customerPhone,
          business,
          tenant,
        });

        if (sent) {
          await Order.updateOne(
            { _id: order._id },
            { $set: { paymentReminderSentAt: new Date() } }
          );
          logger.info(`[Scheduler] Payment reminder sent to ${order.customerPhone} for order ${order._id}`);
        }
      } catch (err) {
        logger.error(`[Scheduler] Payment reminder failed for order ${order._id}: ${err.message}`);
      }
    }));

  } catch (err) {
    logger.error(`[Scheduler] Payment reminder job error: ${err.message}`);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Track all interval handles so stopScheduler() can clear them on shutdown.
const _intervals = [];
const _timeouts  = [];

export function startScheduler() {
  if (!ENABLED) {
    logger.info('[Scheduler] Disabled (set SCHEDULER_ENABLED=true to enable).');
    return;
  }

  // [SC-5] Log exact intervals so ops can verify without reading source
  logger.info('[Scheduler] Starting background jobs...', {
    abandonedCart:     `${CART_INTERVAL_MS / 60000}min`,
    paymentReminder:   `${PAYMENT_REMINDER_INTERVAL_MS / 60000}min`,
    bookingReminder:   `${BOOKING_REMINDER_INTERVAL_MS / 60000}min`,
  });

  _timeouts.push(setTimeout(() => {
    runAbandonedCartJob();
    _intervals.push(setInterval(runAbandonedCartJob, CART_INTERVAL_MS));
  }, 5_000));

  _timeouts.push(setTimeout(() => {
    runPaymentReminderJob();
    _intervals.push(setInterval(runPaymentReminderJob, PAYMENT_REMINDER_INTERVAL_MS));
  }, 15_000));

  _timeouts.push(setTimeout(() => {
    runBookingReminderJob();
    _intervals.push(setInterval(runBookingReminderJob, BOOKING_REMINDER_INTERVAL_MS));
  }, 30_000));

  logger.info('[Scheduler] Jobs registered: abandoned_cart, booking_reminder, payment_reminder');
}

export function stopScheduler() {
  for (const t of _timeouts)  clearTimeout(t);
  for (const i of _intervals) clearInterval(i);
  _timeouts.length  = 0;
  _intervals.length = 0;
  logger.info('[Scheduler] All jobs stopped.');
}
