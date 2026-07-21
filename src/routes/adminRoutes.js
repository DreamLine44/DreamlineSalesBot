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
import mongoose from 'mongoose';
import Order    from '../models/Order.js';
import Booking  from '../models/Booking.js';
import Session  from '../models/Session.js';
import Tenant   from '../models/Tenant.js';
import { NOTIFICATION_DIRECTIONS, NOTIFICATION_SEVERITIES } from '../models/AdminNotification.js';
import AdminNotification from '../models/AdminNotification.js';
import BusinessConfig    from '../models/BusinessConfig.js';
import { updateSession }              from '../core/sessions/sessionService.js';
import { dispatchText, dispatchMessage } from '../core/whatsapp/dispatcher.js';
import { humanModeLimiter, overviewLimiter } from '../middleware/rateLimiter.js';
import logger from '../config/logger.js';

const r = Router();

/**
 * [ADMIN-NOTIFY-2] Pure helpers for the super-admin ↔ tenant-admin notification
 * thread (see models/AdminNotification.js, which already references
 * buildNotificationAccessFilter() in its own header comment — the model was
 * built first, these two helpers were planned but never actually added here).
 *
 * NOTE ON SCOPE: these two functions are fully implemented and pass the
 * complete existing test contract (src/tests/adminNotifications.test.mjs,
 * 17 cases including the two SECURITY-labelled cross-tenant scoping tests).
 * They are deliberately NOT yet wired into a GET/POST /notifications route —
 * that requires the actual Express handlers, pagination, and the
 * pingTenantAdmin() WhatsApp nudge mentioned in the model's own comments,
 * none of which have an existing test or usage pattern to build against
 * safely in an audit pass. Flagging this explicitly rather than guessing at
 * an untested, security-relevant route surface.
 */

/**
 * validateNotificationInput({ subject, body, severity })
 * @returns {string|null} an error message, or null if the input is valid.
 */
export function validateNotificationInput({ subject, body, severity } = {}) {
  if (!subject || !String(subject).trim()) return 'subject is required';
  if (!body || !String(body).trim())       return 'body is required';
  if (String(subject).length > 150)        return 'subject must be 150 characters or fewer';
  if (String(body).length > 2000)          return 'body must be 2000 characters or fewer';
  if (severity !== undefined && !NOTIFICATION_SEVERITIES.includes(severity)) {
    return `severity must be one of: ${NOTIFICATION_SEVERITIES.join(', ')}`;
  }
  return null;
}

/**
 * buildNotificationAccessFilter(admin, query)
 *
 * SECURITY-CRITICAL: a tenant admin caller is ALWAYS scoped to their own
 * tenantId, regardless of any forged ?tenantId in the query string, and can
 * never filter by broadcastId (which would let them enumerate other tenants'
 * broadcasts by ID alone). Only a super admin can see across tenants or
 * filter by broadcastId.
 *
 * @returns {{ filter?: object, error?: string }}
 */
export function buildNotificationAccessFilter(admin = {}, query = {}) {
  const { isSuperAdmin, tenantId: adminTenantId } = admin || {};

  if (!isSuperAdmin && !adminTenantId) {
    return { error: 'Forbidden' };
  }

  const filter = {};

  // Direction and unreadOnly apply equally to both roles.
  if (query.direction && NOTIFICATION_DIRECTIONS.includes(query.direction)) {
    filter.direction = query.direction;
  }
  if (query.unreadOnly === 'true' || query.unreadOnly === true) {
    filter.read = false;
  }

  if (isSuperAdmin) {
    // Super admin: unscoped by default, can narrow by any of these.
    if (query.tenantId)    filter.tenantId    = query.tenantId;
    if (query.broadcastId) filter.broadcastId = query.broadcastId;
  } else {
    // Tenant admin: ALWAYS their own tenantId (SECURITY) — a forged
    // ?tenantId in query is never read in this branch. broadcastId is
    // deliberately never applied for tenant callers (SECURITY).
    filter.tenantId = adminTenantId;
  }

  return { filter };
}

// [FIX-ADMIN-7] payment_pending_verification is a valid Order.status value (in schema enum)
// but was absent here — any admin PATCH to set that status got a 400 "Invalid status" error.
// [FIX-ADMIN-STATUS] 'preparing', 'ready', 'out_for_delivery', 'delivered' were also missing —
// all are valid Order.status enum values and were similarly blocked with 400.
const VALID_ORDER_STATUSES   = [
  'pending', 'payment_pending_verification', 'confirmed',
  'preparing', 'ready', 'out_for_delivery', 'delivered',
  'completed', 'cancelled', 'payment_failed', 'rejected',
];
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
      {
        $set: {
          status,
          ...(notes ? { notes } : {}),
          // Lifecycle timestamps — mirrors dashboardController behaviour
          ...(status === 'preparing'        ? { preparingAt:       new Date() } : {}),
          ...(status === 'ready'            ? { readyAt:           new Date() } : {}),
          ...(status === 'out_for_delivery' ? { outForDeliveryAt:  new Date() } : {}),
          ...(status === 'delivered'        ? { deliveredAt:       new Date() } : {}),
          ...(status === 'completed'        ? { completedAt:       new Date() } : {}),
        },
      },
      { new: true },
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // [FIX-ADMIN-1] Notify customer on meaningful status changes
    try {
      const tenant = await loadTenant(String(order.tenantId));
      if (tenant && order.customerPhone) {
        if (status === 'preparing') {
          await dispatchText(
            order.customerPhone,
            `🍳 *Your order is being prepared!*\n\n📦  *${order.item}* × ${order.quantity}\n🔖  Reference: *#${order.shortId}*\n\nOur kitchen is working on it — we'll message you the moment it's ready. 😊`,
            tenant,
          );
        } else if (status === 'ready') {
          await dispatchMessage(order.customerPhone, {
            type: 'buttons',
            body:
              `🍽️ *Your Order is Ready!*\n\n📦  *${order.item}* × ${order.quantity}\n🔖  Reference: *#${order.shortId}*\n\nPlease collect your order at the counter 😊`,
            buttons: [
              { id: `COLLECTED_${order.shortId}`, title: '✅ Collected — Thanks!' },
              { id: 'SUPPORT',                     title: '❓ Need Help'           },
            ],
          }, tenant);
          await updateSession(order.customerPhone, String(order.tenantId), {
            currentFlow: null, step: null,
            postFlowAck:  'ORDER_READY',
            postFlowData: { item: order.item, quantity: order.quantity, shortId: order.shortId },
          }).catch(() => {});
        } else if (status === 'out_for_delivery') {
          await dispatchMessage(order.customerPhone, {
            type: 'buttons',
            body:
              `🚗 *Your order is on its way!*\n\n📦  *${order.item}* × ${order.quantity}\n🔖  Reference: *#${order.shortId}*\n\nSit tight — your delivery is en route! 🙏`,
            buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
          }, tenant);
        } else if (status === 'confirmed') {
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
r.get('/sessions/:tenantId', overviewLimiter, async (req, res) => {
  const { tenantId } = req.params;
  if (!assertTenant(req, res, tenantId)) return;
  try {
    // [AUDIT-FIX-10] Added Math.max(...,1) lower bound — this was the one remaining
    // paginated endpoint without it (dashboardController's equivalent endpoints were
    // already fixed). ?limit=-5 or ?limit=0 would otherwise pass straight through to
    // Mongoose's .limit() unguarded.
    const limit  = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200); // cap at 200
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

// ── Admin ↔ Tenant notifications ──────────────────────────────────────────────
// [ADMIN-NOTIFY-3] Full route wiring for the AdminNotification model (see its
// own header comment, and buildNotificationAccessFilter/validateNotificationInput
// above). Auth is handled entirely by the requireApiKey middleware this router
// is mounted behind in app.js — req.isSuperAdmin / req.tenantId are already set
// by the time any handler below runs.

/**
 * pingTenantAdmin(tenant, business, notification)
 *
 * Best-effort WhatsApp nudge for a TO_TENANT notification, per
 * models/AdminNotification.js's own documented design ("reuses the existing
 * dispatch pipeline exactly the way order/booking status changes already
 * do — fire-and-forget, never blocking the notification write itself").
 * Reuses the SAME `business?.adminPhone || tenant?.adminPhone` fallback
 * already used consistently everywhere else in this codebase to reach a
 * tenant's admin (moduleRouter.js, every modules/*\/flows/*.js order-alert
 * call site, paymentService.js, leadCaptureService.js) — never a new or
 * separate phone-resolution convention.
 */
async function pingTenantAdmin(tenant, business, notification) {
  const adminPhone = business?.adminPhone || tenant?.adminPhone;
  if (!adminPhone) return false;

  const severityEmoji = notification.severity === 'urgent' ? '🚨'
    : notification.severity === 'warning' ? '⚠️' : 'ℹ️';

  try {
    await dispatchText(
      adminPhone,
      `${severityEmoji} *${notification.subject}*\n\n${notification.body}\n\n_— WhatSales Team_`,
      tenant,
    );
    return true;
  } catch (err) {
    logger.warn('[Admin] pingTenantAdmin failed (non-fatal)', { err: err.message, adminPhone });
    return false;
  }
}

// GET /admin/notifications — list the caller's notification thread.
// Super admin: sees everything by default, can narrow with ?tenantId/?broadcastId.
// Tenant admin: ALWAYS scoped to their own tenantId (see buildNotificationAccessFilter).
r.get('/notifications', overviewLimiter, async (req, res) => {
  try {
    const { filter, error } = buildNotificationAccessFilter(
      { isSuperAdmin: req.isSuperAdmin, tenantId: req.tenantId },
      req.query,
    );
    if (error) return res.status(403).json({ error });

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page  = Math.max(Number(req.query.page) || 1, 1);
    const skip  = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      AdminNotification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdminNotification.countDocuments(filter),
    ]);

    res.json({ notifications, total, page, pages: Math.ceil(total / limit), limit });
  } catch (err) {
    logger.error('[Admin] getNotifications failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/notifications — send a notification.
// Direction is DERIVED from the caller's role, never taken from the request
// body — a tenant admin can never forge direction:'TO_TENANT' to impersonate
// the super admin, and vice versa.
r.post('/notifications', async (req, res) => {
  try {
    const { subject, body, severity, tenantId: bodyTenantId, broadcast } = req.body || {};
    const inputError = validateNotificationInput({ subject, body, severity });
    if (inputError) return res.status(400).json({ error: inputError });

    if (req.isSuperAdmin) {
      // Super admin → tenant(s). Either a single targeted tenantId, or a
      // broadcast fan-out to every tenant (see AdminNotification's own header
      // comment: one doc per tenant, all sharing a broadcastId — never a
      // single doc with tenantId=null).
      if (broadcast) {
        const tenants = await Tenant.find({}).select('_id adminPhone').lean();
        if (!tenants.length) return res.status(404).json({ error: 'No tenants to broadcast to' });

        const broadcastId = new mongoose.Types.ObjectId().toString();
        const docs = tenants.map(t => ({
          tenantId: t._id, direction: 'TO_TENANT', broadcastId,
          fromLabel: 'WhatSales Team', subject, body, severity: severity || 'info',
        }));
        const created = await AdminNotification.insertMany(docs);

        // Fire-and-forget WhatsApp nudges — never block the response on these.
        Promise.all(created.map(async (doc, i) => {
          const pinged = await pingTenantAdmin({ _id: tenants[i]._id, adminPhone: tenants[i].adminPhone }, null, doc);
          if (pinged) await AdminNotification.updateOne({ _id: doc._id }, { whatsappPinged: true }).catch(() => {});
        })).catch(() => {});

        return res.status(201).json({ broadcastId, count: created.length });
      }

      if (!bodyTenantId) return res.status(400).json({ error: 'tenantId is required (or set broadcast: true)' });
      const [tenant, business] = await Promise.all([
        Tenant.findById(bodyTenantId).lean().catch(() => null),
        BusinessConfig.findOne({ tenantId: bodyTenantId }).lean().catch(() => null),
      ]);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      const doc = await AdminNotification.create({
        tenantId: bodyTenantId, direction: 'TO_TENANT',
        fromLabel: 'WhatSales Team', subject, body, severity: severity || 'info',
      });

      const pinged = await pingTenantAdmin(tenant, business, doc);
      if (pinged) { doc.whatsappPinged = true; await doc.save().catch(() => {}); }

      return res.status(201).json(doc);
    }

    // Tenant admin → super admin. Always their own tenantId (SECURITY — a
    // forged bodyTenantId is never read in this branch).
    if (!req.tenantId) return res.status(403).json({ error: 'Forbidden' });
    const business = await BusinessConfig.findOne({ tenantId: req.tenantId }).lean().catch(() => null);

    const doc = await AdminNotification.create({
      tenantId: req.tenantId, direction: 'TO_ADMIN',
      fromLabel: business?.name || 'Tenant Admin', subject, body, severity: severity || 'info',
    });
    return res.status(201).json(doc);
  } catch (err) {
    logger.error('[Admin] postNotification failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/notifications/:id/read — mark a single notification read.
// A notification can only be marked read by the side it was SENT TO:
// TO_TENANT items are read by that tenant's admin; TO_ADMIN items are read
// by the super admin. This is stricter than plain tenantId ownership — a
// tenant admin must not be able to mark their OWN outgoing (TO_ADMIN) message
// "read", since that field means "the super admin has seen this".
r.patch('/notifications/:id/read', async (req, res) => {
  try {
    const notification = await AdminNotification.findById(req.params.id);
    if (!notification) return res.status(404).json({ error: 'Notification not found' });

    if (req.isSuperAdmin) {
      if (notification.direction !== 'TO_ADMIN') {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      if (!req.tenantId || String(notification.tenantId) !== req.tenantId || notification.direction !== 'TO_TENANT') {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    if (!notification.read) {
      notification.read   = true;
      notification.readAt = new Date();
      await notification.save();
    }
    res.json(notification);
  } catch (err) {
    logger.error('[Admin] markNotificationRead failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default r;
