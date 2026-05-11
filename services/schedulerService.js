/**
 * services/schedulerService.js — Dreamline Sales Bot v11.0
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  BACKGROUND JOB SCHEDULER                                       ║
 * ║                                                                 ║
 * ║  Runs lightweight in-process jobs that power WhatsApp-native    ║
 * ║  re-engagement flows.                                           ║
 * ║                                                                 ║
 * ║  Jobs:                                                          ║
 * ║  1. Abandoned cart recovery   — every 15 minutes               ║
 * ║     Finds sessions that expired with an active ORDER flow       ║
 * ║     and sends a WhatsApp template follow-up.                    ║
 * ║                                                                 ║
 * ║  2. Booking reminder          — once daily (evening before)     ║
 * ║     Finds bookings scheduled for tomorrow and sends a           ║
 * ║     WhatsApp reminder template to each customer.                ║
 * ║                                                                 ║
 * ║  3. Payment reminder          — every 20 minutes               ║
 * ║     Finds orders stuck at payment_pending_verification for      ║
 * ║     > 30 minutes and nudges customer via template.              ║
 * ║                                                                 ║
 * ║  RULES:                                                         ║
 * ║  ✅ Each job is idempotent — safe to run multiple times         ║
 * ║  ✅ Sent flags prevent double-sending                           ║
 * ║  ✅ All jobs fail-silent (never crash the server)               ║
 * ║  ✅ Only runs if SCHEDULER_ENABLED=true env var is set          ║
 * ╚══════════════════════════════════════════════════════════════════╝
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

// ─── Feature gate ─────────────────────────────────────────────────────────────
// Set SCHEDULER_ENABLED=true in your env to activate background jobs.
// Disabled by default so existing deployments aren't affected on upgrade.

const ENABLED = process.env.SCHEDULER_ENABLED === 'true';

// ─── Intervals ────────────────────────────────────────────────────────────────

const CART_INTERVAL_MS            = 15 * 60 * 1000;  // 15 min
const PAYMENT_REMINDER_INTERVAL_MS = 20 * 60 * 1000; // 20 min
const BOOKING_REMINDER_INTERVAL_MS = 60 * 60 * 1000; // 1 hour (runs hourly, checks date)

// ─── Job 1: Abandoned cart recovery ──────────────────────────────────────────

async function runAbandonedCartJob() {
  logger.info('[Scheduler] Running abandoned cart job...');

  const cutoff    = new Date(Date.now() - 60 * 60 * 1000); // sessions expired > 1h ago
  const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000); // but within last 24h

  try {
    // Find orders that are still "pending" (never confirmed) created within the window
    // and haven't had an abandoned cart message sent yet.
    const staleOrders = await Order.find({
      status:          'pending',
      createdAt:       { $lt: cutoff, $gt: threshold },
      abandonedCartAt: { $exists: false }, // not yet messaged
    }).lean();

    if (!staleOrders.length) {
      logger.info('[Scheduler] Abandoned cart: no pending orders found.');
      return;
    }

    logger.info(`[Scheduler] Abandoned cart: found ${staleOrders.length} stale orders.`);

    for (const order of staleOrders) {
      try {
        // Load tenant for this order
        const tenant = await Tenant.findById(order.tenantId).lean();
        if (!tenant || tenant.status !== 'ACTIVE') continue;

        const business = await BusinessConfig.findOne({ tenantId: order.tenantId }).lean();

        const sent = await sendAbandonedCartTemplate({
          to:           order.customerPhone,
          customerName: null, // no name in Order model — template uses 'there'
          business,
          tenant,
        });

        if (sent) {
          // Mark so we don't send again
          await Order.updateOne(
            { _id: order._id },
            { $set: { abandonedCartAt: new Date() } }
          );
          logger.info(`[Scheduler] Abandoned cart sent to ${order.customerPhone} for order ${order._id}`);
        }
      } catch (innerErr) {
        logger.error(`[Scheduler] Abandoned cart failed for order ${order._id}: ${innerErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`[Scheduler] Abandoned cart job error: ${err.message}`);
  }
}

// ─── Job 2: Booking reminder ──────────────────────────────────────────────────

async function runBookingReminderJob() {
  const now   = new Date();
  const hour  = now.getHours();

  // Only run between 18:00–20:00 (evening before appointments)
  if (hour < 18 || hour > 20) return;

  logger.info('[Scheduler] Running booking reminder job...');

  try {
    const tomorrow      = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStart = new Date(tomorrow.setHours(0, 0, 0, 0));
    const tomorrowEnd   = new Date(tomorrow.setHours(23, 59, 59, 999));

    const bookings = await Booking.find({
      date:           { $gte: tomorrowStart.toISOString().split('T')[0],
                        $lte: tomorrowEnd.toISOString().split('T')[0] },
      status:         'confirmed',
      reminderSentAt: { $exists: false },
    }).lean();

    if (!bookings.length) {
      logger.info('[Scheduler] Booking reminder: no upcoming bookings.');
      return;
    }

    logger.info(`[Scheduler] Booking reminder: found ${bookings.length} bookings.`);

    for (const booking of bookings) {
      try {
        const tenant = await Tenant.findById(booking.tenantId).lean();
        if (!tenant || tenant.status !== 'ACTIVE') continue;

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
      } catch (innerErr) {
        logger.error(`[Scheduler] Booking reminder failed for booking ${booking._id}: ${innerErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`[Scheduler] Booking reminder job error: ${err.message}`);
  }
}

// ─── Job 3: Payment proof reminder ───────────────────────────────────────────

async function runPaymentReminderJob() {
  logger.info('[Scheduler] Running payment reminder job...');

  // Orders awaiting payment for > 30 min but < 3 hours (not yet timed out)
  const minAge = new Date(Date.now() - 30  * 60 * 1000); // 30 min ago
  const maxAge = new Date(Date.now() - 3   * 60 * 60 * 1000); // 3 hours ago

  try {
    const pendingOrders = await Order.find({
      status:          'pending',
      paymentStatus:   'unpaid',
      createdAt:       { $lt: minAge, $gt: maxAge },
      paymentReminderSentAt: { $exists: false },
    }).lean();

    if (!pendingOrders.length) {
      logger.info('[Scheduler] Payment reminder: no pending orders.');
      return;
    }

    logger.info(`[Scheduler] Payment reminder: ${pendingOrders.length} orders need nudge.`);

    for (const order of pendingOrders) {
      try {
        const tenant = await Tenant.findById(order.tenantId).lean();
        if (!tenant || tenant.status !== 'ACTIVE') continue;

        const business = await BusinessConfig.findOne({ tenantId: order.tenantId }).lean();

        // Only remind if business has Wave configured
        if (!business?.payment?.wavePhone && !business?.wavePhone) continue;

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
      } catch (innerErr) {
        logger.error(`[Scheduler] Payment reminder failed for order ${order._id}: ${innerErr.message}`);
      }
    }
  } catch (err) {
    logger.error(`[Scheduler] Payment reminder job error: ${err.message}`);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Start all background jobs.
 * Called once from app.js after DB connects.
 *
 * Usage in app.js:
 *   import { startScheduler } from './services/schedulerService.js';
 *   // After connectToDB():
 *   startScheduler();
 */
export function startScheduler() {
  if (!ENABLED) {
    logger.info('[Scheduler] Disabled (set SCHEDULER_ENABLED=true to enable).');
    return;
  }

  logger.info('[Scheduler] Starting background jobs...');

  // Stagger starts to avoid simultaneous DB hits at boot
  setTimeout(() => {
    runAbandonedCartJob();
    setInterval(runAbandonedCartJob, CART_INTERVAL_MS);
  }, 5_000);

  setTimeout(() => {
    runPaymentReminderJob();
    setInterval(runPaymentReminderJob, PAYMENT_REMINDER_INTERVAL_MS);
  }, 15_000);

  setTimeout(() => {
    runBookingReminderJob();
    setInterval(runBookingReminderJob, BOOKING_REMINDER_INTERVAL_MS);
  }, 30_000);

  logger.info('[Scheduler] Jobs registered: abandoned_cart, booking_reminder, payment_reminder');
}
