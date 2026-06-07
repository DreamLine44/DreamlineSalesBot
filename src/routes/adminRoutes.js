/**
 * routes/adminRoutes.js
 *
 * [FIX] All handlers now have try/catch — previously an unhandled DB error
 *       would crash the response with an uncaught exception.
 * [FIX] All handlers enforce tenantId ownership: non-superadmins can only
 *       access sessions/orders/bookings belonging to their own tenantId.
 *
 * [FIX-ADMIN-1] PATCH /orders/:id/status — added status enum validation +
 *               customer WhatsApp notification on status change (was silently
 *               updating DB only, unlike the dashboard equivalent).
 * [FIX-ADMIN-2] PATCH /bookings/:id/status — same: validation + notification.
 * [FIX-ADMIN-3] PATCH /sessions/:tenantId/:phone/human — now notifies the
 *               customer when humanMode is switched OFF (bot resumed), matching
 *               dashboardController.setHumanMode behaviour.
 * [FIX-ADMIN-4] GET /sessions/:tenantId — added ?limit and ?page pagination;
 *               previously hard-capped at 100 with no way to page beyond that.
 */
import { Router } from 'express';
import Order    from '../models/Order.js';
import Booking  from '../models/Booking.js';
import Session  from '../models/Session.js';
import Tenant   from '../models/Tenant.js';
import { updateSession } from '../core/sessions/sessionService.js';
import { dispatchText }  from '../core/whatsapp/dispatcher.js';
import { humanModeLimiter } from '../middleware/rateLimiter.js';
import logger from '../config/logger.js';

const r = Router();

// [FIX-ADMIN-7] payment_pending_verification is a valid Order.status value (in schema enum)
// but was absent here — any admin PATCH to set that status got a 400 "Invalid status" error.
const VALID_ORDER_STATUSES   = ['pending', 'payment_pending_verification', 'confirmed', 'completed', 'cancelled', 'payment_failed', 'rejected'];
const VALID_BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];

/** Reject non-superadmins accessing another tenant's data */
function assertTenant(req, res, tenantId) {
  if (req.isSuperAdmin) return true;
  if (!req.tenantId || req.tenantId !== tenantId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

/** Load tenant doc for WhatsApp dispatch */
async function loadTenant(tenantId) {
  return Tenant.findById(tenantId).lean().catch(() => null);
}

// ── Human mode toggle ─────────────────────────────────────────────────────────
// [FIX-ADMIN-5] Apply a dedicated humanModeLimiter (5 req/min) that is stricter than
// the global adminLimiter (30 req/min). The toggle directly silences/restores the bot —
// rapid toggling could expose a customer to the bot mid-human-mode handoff.
r.patch('/sessions/:tenantId/:phone/human', humanModeLimiter, async (req, res) => {
  const { tenantId, phone } = req.params;
  if (!assertTenant(req, res, tenantId)) return;
  try {
    const { humanMode } = req.body;
    if (typeof humanMode !== 'boolean') {
      return res.status(400).json({ error: 'humanMode must be a boolean' });
    }
    // [FIX-ADMIN-NULL] Capture updateSession result — returns null when no active session
    // exists (TTL-expired). Only dispatch the resume notification when the session was
    // actually updated; firing it on a null return sends a confusing message to a customer
    // whose session is already expired and who may have moved on entirely.
    const updatedSession = await updateSession(phone, tenantId, { humanMode: Boolean(humanMode) });

    // [FIX-ADMIN-3] Notify customer when bot is resumed (humanMode OFF)
    if (!humanMode && updatedSession) {
      try {
        const tenant = await loadTenant(tenantId);
        if (tenant) {
          await dispatchText(
            phone,
            `✅ Our team has finished assisting you. Our automated assistant is back and ready to help! 😊`,
            tenant,
          );
        }
      } catch (notifyErr) {
        logger.warn('[Admin] Bot-resume notify failed (non-fatal)', { err: notifyErr.message });
      }
    }

    res.json({ ok: true, humanMode: Boolean(humanMode) });
  } catch (err) {
    logger.error('[Admin] setHumanMode failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Order status update ───────────────────────────────────────────────────────
r.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status, notes } = req.body;

    // [FIX-ADMIN-6] Explicit early guard: non-super-admins must have a resolved
    // tenantId from requireApiKey. Without this, a middleware bug that sets
    // req.tenantId to undefined would produce filter.tenantId=undefined, which
    // MongoDB silently treats as {tenantId: null} — matching no document but
    // returning 404 rather than 403, masking the auth gap in logs.
    if (!req.isSuperAdmin && !req.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // [FIX-ADMIN-1] Validate status before touching DB
    if (!VALID_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_ORDER_STATUSES.join(', ')}`,
      });
    }

    const filter = { _id: req.params.id };
    if (!req.isSuperAdmin) filter.tenantId = req.tenantId;

    const order = await Order.findOneAndUpdate(
      filter,
      { $set: { status, ...(notes ? { notes } : {}) } },
      { new: true },
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // [FIX-ADMIN-1] Notify customer on meaningful status changes
    try {
      const tenant = await loadTenant(String(order.tenantId));
      if (tenant && order.customerPhone) {
        if (status === 'confirmed') {
          await dispatchText(
            order.customerPhone,
            `✅ *Your order is confirmed!*\n\n🍽 *${order.item}* × ${order.quantity}\n\nThank you for your patience! 😊`,
            tenant,
          );
        } else if (status === 'cancelled' || status === 'rejected') {
          await dispatchText(
            order.customerPhone,
            `❌ *Order update*\n\nUnfortunately your order (*${order.item}*) has been ${status}.${notes ? `\n\nNote: ${notes}` : ''}\n\nPlease contact us if you have questions.`,
            tenant,
          );
        } else if (status === 'completed') {
          await dispatchText(
            order.customerPhone,
            `🎉 *Order completed!*\n\nYour order of *${order.item}* is done. Enjoy! 😊`,
            tenant,
          );
        }
      }
    } catch (notifyErr) {
      logger.warn('[Admin] Order status notify failed (non-fatal)', { err: notifyErr.message });
    }

    res.json({ order });
  } catch (err) {
    logger.error('[Admin] updateOrderStatus failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Booking status update ─────────────────────────────────────────────────────
r.patch('/bookings/:id/status', async (req, res) => {
  try {
    const { status, adminNote } = req.body;

    // [FIX-ADMIN-6] Same defence-in-depth guard as order status route.
    if (!req.isSuperAdmin && !req.tenantId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // [FIX-ADMIN-2] Validate status
    if (!VALID_BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_BOOKING_STATUSES.join(', ')}`,
      });
    }

    const filter = { _id: req.params.id };
    if (!req.isSuperAdmin) filter.tenantId = req.tenantId;

    const booking = await Booking.findOneAndUpdate(
      filter,
      { $set: { status, ...(adminNote ? { adminNote } : {}) } },
      { new: true },
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // [FIX-ADMIN-2] Notify customer on meaningful status changes
    try {
      const tenant = await loadTenant(String(booking.tenantId));
      if (tenant && booking.customerPhone) {
        const when    = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
        const svcStr  = booking.service ? ` (${booking.service})` : '';
        const noteStr = adminNote ? `\n\nNote: ${adminNote}` : '';

        if (status === 'confirmed') {
          await dispatchText(
            booking.customerPhone,
            `✅ *Booking Confirmed!*\n\n📅 *${when}*${svcStr}\n\nWe look forward to seeing you! 😊`,
            tenant,
          );
        } else if (status === 'cancelled') {
          await dispatchText(
            booking.customerPhone,
            `❌ *Booking Cancelled*\n\nSorry, your booking${svcStr} for *${when}* has been cancelled.${noteStr}\n\nPlease contact us to reschedule.`,
            tenant,
          );
        } else if (status === 'completed') {
          await dispatchText(
            booking.customerPhone,
            `🎉 Thank you for visiting${svcStr ? ` for your ${booking.service}` : ''}! We hope to see you again soon. 😊`,
            tenant,
          );
        }
      }
    } catch (notifyErr) {
      logger.warn('[Admin] Booking status notify failed (non-fatal)', { err: notifyErr.message });
    }

    res.json({ booking });
  } catch (err) {
    logger.error('[Admin] updateBookingStatus failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Active sessions list ──────────────────────────────────────────────────────
// [FIX-ADMIN-4] Added ?limit and ?page query params for pagination
r.get('/sessions/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  if (!assertTenant(req, res, tenantId)) return;
  try {
    const limit  = Math.min(Number(req.query.limit)  || 50, 200); // cap at 200
    const page   = Math.max(Number(req.query.page)   || 1, 1);
    const skip   = (page - 1) * limit;
    const filter = { tenantId };

    // Optional humanMode filter (?humanOnly=true)
    if (req.query.humanOnly === 'true') filter.humanMode = true;

    const [sessions, total] = await Promise.all([
      Session.find(filter)
        .sort({ lastSeen: -1 })
        .skip(skip)
        .limit(limit)
        .select('customerPhone customerName humanMode currentFlow step lastSeen messageCount')
        .lean(),
      Session.countDocuments(filter),
    ]);

    res.json({
      sessions,
      total,
      page,
      pages: Math.ceil(total / limit),
      limit,
    });
  } catch (err) {
    logger.error('[Admin] getSessions failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default r;
