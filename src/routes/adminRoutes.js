/**
 * routes/adminRoutes.js
 *
 * [FIX] All handlers now have try/catch â€” previously an unhandled DB error
 *       would crash the response with an uncaught exception.
 * [FIX] All handlers enforce tenantId ownership: non-superadmins can only
 *       access sessions/orders/bookings belonging to their own tenantId.
 *
 * [FIX-ADMIN-1] PATCH /orders/:id/status â€” added status enum validation +
 *               customer WhatsApp notification on status change (was silently
 *               updating DB only, unlike the dashboard equivalent).
 * [FIX-ADMIN-2] PATCH /bookings/:id/status â€” same: validation + notification.
 * [FIX-ADMIN-3] PATCH /sessions/:tenantId/:phone/human â€” now notifies the
 *               customer when humanMode is switched OFF (bot resumed), matching
 *               dashboardController.setHumanMode behaviour.
 * [FIX-ADMIN-4] GET /sessions/:tenantId â€” added ?limit and ?page pagination;
 *               previously hard-capped at 100 with no way to page beyond that.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import Order    from '../models/Order.js';
import Booking  from '../models/Booking.js';
import Session  from '../models/Session.js';
import Tenant   from '../models/Tenant.js';
import AdminNotification, { NOTIFICATION_DIRECTIONS, NOTIFICATION_SEVERITIES } from '../models/AdminNotification.js';
import { updateSession }              from '../core/sessions/sessionService.js';
import { dispatchText, dispatchMessage } from '../core/whatsapp/dispatcher.js';
import { humanModeLimiter, overviewLimiter } from '../middleware/rateLimiter.js';
import logger from '../config/logger.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { formatOrderItemsForMessage } from '../services/order/orderFeature.js';

const r = Router();

// [FIX-ADMIN-7] payment_pending_verification is a valid Order.status value (in schema enum)
// but was absent here â€” any admin PATCH to set that status got a 400 "Invalid status" error.
// [FIX-ADMIN-STATUS] 'preparing', 'ready', 'out_for_delivery', 'delivered' were also missing â€”
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

// â”€â”€ Human mode toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [FIX-ADMIN-5] Apply a dedicated humanModeLimiter (5 req/min) that is stricter than
// the global adminLimiter (30 req/min). The toggle directly silences/restores the bot â€”
// rapid toggling could expose a customer to the bot mid-human-mode handoff.
r.patch('/sessions/:tenantId/:phone/human', humanModeLimiter, async (req, res) => {
  const { tenantId, phone } = req.params;
  if (!assertTenant(req, res, tenantId)) return;
  try {
    const { humanMode } = req.body;
    if (typeof humanMode !== 'boolean') {
      return res.status(400).json({ error: 'humanMode must be a boolean' });
    }
    // [FIX-ADMIN-NULL] Capture updateSession result â€” returns null when no active session
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
            `âœ… Our team has finished assisting you. Our automated assistant is back and ready to help! ðŸ˜Š`,
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

// â”€â”€ Order status update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
r.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status, notes } = req.body;

    // [FIX-ADMIN-6] Explicit early guard: non-super-admins must have a resolved
    // tenantId from requireApiKey. Without this, a middleware bug that sets
    // req.tenantId to undefined would produce filter.tenantId=undefined, which
    // MongoDB silently treats as {tenantId: null} â€” matching no document but
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
          // Lifecycle timestamps â€” mirrors dashboardController behaviour
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
        const business = await BusinessConfig.findOne({ tenantId: order.tenantId }).lean().catch(() => null);
        const itemsBlock = formatOrderItemsForMessage(order, business || { payment: { currency: 'GMD' } });

        if (status === 'preparing') {
          await dispatchText(
            order.customerPhone,
            `ðŸ³ *Your order is being prepared!*\n\n${itemsBlock}\nðŸ”–  Reference: *#${order.shortId}*\n\nOur kitchen is working on it â€” we'll message you the moment it's ready. ðŸ˜Š`,
            tenant,
          );
        } else if (status === 'ready') {
          await dispatchMessage(order.customerPhone, {
            type: 'buttons',
            body:
              `ðŸ½ï¸ *Your Order is Ready!*\n\n${itemsBlock}\nðŸ”–  Reference: *#${order.shortId}*\n\nPlease collect your order at the counter ðŸ˜Š`,
            buttons: [
              { id: `COLLECTED_${order.shortId}`, title: 'âœ… Collected â€” Thanks!' },
              { id: 'SUPPORT',                     title: 'â“ Need Help'           },
            ],
          }, tenant);
          await updateSession(order.customerPhone, String(order.tenantId), {
            currentFlow: null, step: null,
            postFlowAck:  'ORDER_READY',
            postFlowData: {
              item: order.item, quantity: order.quantity, shortId: order.shortId,
              items: order.items?.length ? order.items : undefined,
            },
          }).catch(() => {});
        } else if (status === 'out_for_delivery') {
          await dispatchMessage(order.customerPhone, {
            type: 'buttons',
            body:
              `ðŸš— *Your order is on its way!*\n\n${itemsBlock}\nðŸ”–  Reference: *#${order.shortId}*\n\nSit tight â€” your delivery is en route! ðŸ™`,
            buttons: [{ id: 'SUPPORT', title: 'ðŸ’¬ Contact Us' }],
          }, tenant);
        } else if (status === 'confirmed') {
          await dispatchText(
            order.customerPhone,
            `âœ… *Your order is confirmed!*\n\n${itemsBlock}\n\nThank you for your patience! ðŸ˜Š`,
            tenant,
          );
        } else if (status === 'cancelled' || status === 'rejected') {
          await dispatchText(
            order.customerPhone,
            `âŒ *Order update*\n\nUnfortunately your order (*${order.item}*) has been ${status}.${notes ? `\n\nNote: ${notes}` : ''}\n\nPlease contact us if you have questions.`,
            tenant,
          );
        } else if (status === 'completed') {
          await dispatchText(
            order.customerPhone,
            `ðŸŽ‰ *Order completed!*\n\nYour order of *${order.item}* is done. Enjoy! ðŸ˜Š`,
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

// â”€â”€ Booking status update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
            `âœ… *Booking Confirmed!*\n\nðŸ“… *${when}*${svcStr}\n\nWe look forward to seeing you! ðŸ˜Š`,
            tenant,
          );
        } else if (status === 'cancelled') {
          await dispatchText(
            booking.customerPhone,
            `âŒ *Booking Cancelled*\n\nSorry, your booking${svcStr} for *${when}* has been cancelled.${noteStr}\n\nPlease contact us to reschedule.`,
            tenant,
          );
        } else if (status === 'completed') {
          await dispatchText(
            booking.customerPhone,
            `ðŸŽ‰ Thank you for visiting${svcStr ? ` for your ${booking.service}` : ''}! We hope to see you again soon. ðŸ˜Š`,
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

// â”€â”€ Active sessions list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [FIX-ADMIN-4] Added ?limit and ?page query params for pagination
r.get('/sessions/:tenantId', overviewLimiter, async (req, res) => {
  const { tenantId } = req.params;
  if (!assertTenant(req, res, tenantId)) return;
  try {
    // [AUDIT-FIX-10] Added Math.max(...,1) lower bound â€” this was the one remaining
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

// â”€â”€ Admin â†” tenant-admin notifications [ADMIN-NOTIFY-1] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Two-way messaging surfaced in both the super-admin console and the tenant
// dashboard. See models/AdminNotification.js for the full design rationale
// (why broadcasts fan out into one doc per tenant, direction semantics, etc).

/**
 * validateNotificationInput({ subject, body, severity })
 * Pure â€” no DB. Returns an error string, or null when the input is valid.
 */
export function validateNotificationInput({ subject, body, severity } = {}) {
  if (!subject || !String(subject).trim()) return 'subject is required';
  if (!body || !String(body).trim()) return 'body is required';
  if (String(subject).length > 150) return 'subject must be 150 characters or fewer';
  if (String(body).length > 2000) return 'body must be 2000 characters or fewer';
  if (severity !== undefined && !NOTIFICATION_SEVERITIES.includes(severity)) {
    return `severity must be one of: ${NOTIFICATION_SEVERITIES.join(', ')}`;
  }
  return null;
}

/**
 * buildNotificationAccessFilter(req, query)
 * Pure â€” no DB. The security-critical piece: a tenant caller is ALWAYS
 * scoped to their own tenantId (never the query string's), and can never
 * filter by broadcastId (which would let them probe other tenants'
 * broadcast IDs). A super admin gets an unscoped filter by default, with
 * optional narrowing by any of the four query params.
 *
 * @returns {{ filter?: object, error?: string }} exactly one of the two keys is set
 */
export function buildNotificationAccessFilter(req, query = {}) {
  const isSuperAdmin   = !!req?.isSuperAdmin;
  const callerTenantId = req?.tenantId || null;

  if (!isSuperAdmin && !callerTenantId) {
    return { error: 'Forbidden' };
  }

  const filter = {};

  if (isSuperAdmin) {
    if (query.tenantId) filter.tenantId = query.tenantId;
  } else {
    // SECURITY: never honour a caller-supplied tenantId â€” a tenant admin's
    // own req.tenantId (set by auth middleware, not the request) is the
    // only tenantId they can ever be scoped to.
    filter.tenantId = callerTenantId;
  }

  if (query.direction && NOTIFICATION_DIRECTIONS.includes(query.direction)) {
    filter.direction = query.direction;
  }

  if (query.unreadOnly === 'true' || query.unreadOnly === true) {
    filter.read = false;
  }

  // SECURITY: broadcastId enumeration guard â€” only a super admin may filter
  // by it. A tenant caller guessing/iterating broadcastId values could
  // otherwise confirm whether a given broadcast reached other tenants.
  if (isSuperAdmin && query.broadcastId) {
    filter.broadcastId = query.broadcastId;
  }

  return { filter };
}

/**
 * pingTenantAdmin(tenant, notification)
 * Best-effort WhatsApp nudge for a TO_TENANT send â€” reuses the existing
 * dispatch pipeline exactly the way order/booking status changes already
 * do. Fire-and-forget: never blocks or fails the notification write.
 */
async function pingTenantAdmin(tenant, notification) {
  if (!tenant?.adminPhone) return false;
  try {
    await dispatchText(
      tenant.adminPhone,
      `ðŸ“‹ *${notification.subject}*\n\n${notification.body}\n\nâ€” WhatSales`,
      tenant,
    );
    return true;
  } catch (err) {
    logger.warn('[Admin] pingTenantAdmin failed (non-fatal)', { err: err.message });
    return false;
  }
}

// GET /notifications â€” list this caller's thread (scoped per buildNotificationAccessFilter)
r.get('/notifications', overviewLimiter, async (req, res) => {
  try {
    const { filter, error } = buildNotificationAccessFilter(req, req.query);
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
    logger.error('[Admin] listNotifications failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /notifications â€” send a message.
//   Super admin: { tenantId, subject, body, severity? } for a direct send, or
//                { broadcast: true, subject, body, severity? } to fan out to
//                every tenant (one AdminNotification doc per tenant, sharing
//                a broadcastId).
//   Tenant admin: sends TO_ADMIN, always scoped to their own tenantId.
r.post('/notifications', async (req, res) => {
  try {
    const { subject, body, severity, tenantId: bodyTenantId, broadcast } = req.body;

    const validationErr = validateNotificationInput({ subject, body, severity });
    if (validationErr) return res.status(400).json({ error: validationErr });

    if (!req.isSuperAdmin) {
      // Tenant admin â†’ TO_ADMIN, always scoped to their own tenantId, never a broadcast.
      if (!req.tenantId) return res.status(403).json({ error: 'Forbidden' });

      const notification = await AdminNotification.create({
        tenantId:  req.tenantId,
        direction: 'TO_ADMIN',
        fromLabel: 'Tenant Admin',
        subject, body,
        ...(severity ? { severity } : {}),
      });
      return res.status(201).json({ notification });
    }

    // Super admin â†’ TO_TENANT, direct or broadcast.
    if (broadcast) {
      const tenants = await Tenant.find({}, { _id: 1, whatsapp: 1 }).lean();
      const broadcastId = randomUUID();
      const docs = await AdminNotification.insertMany(
        tenants.map(t => ({
          tenantId: t._id,
          direction: 'TO_TENANT',
          fromLabel: 'WhatSales Team',
          broadcastId,
          subject, body,
          ...(severity ? { severity } : {}),
        })),
      );
      // Best-effort WhatsApp nudge per tenant â€” never blocks the response.
      Promise.all(tenants.map((t, i) => pingTenantAdmin(t, docs[i]).then(pinged => {
        if (pinged) return AdminNotification.updateOne({ _id: docs[i]._id }, { whatsappPinged: true }).catch(() => {});
      }))).catch(() => {});
      return res.status(201).json({ notifications: docs, broadcastId });
    }

    if (!bodyTenantId) return res.status(400).json({ error: 'tenantId is required for a direct message' });
    const tenant = await loadTenant(bodyTenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const notification = await AdminNotification.create({
      tenantId:  bodyTenantId,
      direction: 'TO_TENANT',
      fromLabel: 'WhatSales Team',
      subject, body,
      ...(severity ? { severity } : {}),
    });
    const pinged = await pingTenantAdmin(tenant, notification);
    if (pinged) await AdminNotification.updateOne({ _id: notification._id }, { whatsappPinged: true });

    res.status(201).json({ notification });
  } catch (err) {
    logger.error('[Admin] sendNotification failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /notifications/:id/read â€” mark a single notification read.
r.patch('/notifications/:id/read', async (req, res) => {
  try {
    const { filter, error } = buildNotificationAccessFilter(req, {});
    if (error) return res.status(403).json({ error });

    const notification = await AdminNotification.findOneAndUpdate(
      { _id: req.params.id, ...filter },
      { $set: { read: true, readAt: new Date() } },
      { new: true },
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });

    res.json({ notification });
  } catch (err) {
    logger.error('[Admin] markNotificationRead failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// â”€â”€ Webhook secret fingerprint (diagnostic only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// [FIX-SIG-FINGERPRINT] Webhook signature mismatches (see webhookController.js
// _verifyTenantWebhookSignature) are indistinguishable in the logs between
// "the stored secret is wrong" and "something else is misconfigured" â€” both
// just say hadTenantSecret: true, mismatch. This endpoint closes that gap:
// paste the App Secret currently shown in the Meta App Dashboard here, get
// back its 12-char fingerprint, and compare it against the fingerprint that
// was logged when the tenant's meta.appSecret/whatsapp.webhookSecret was
// saved (tenantController.js updateTenant) or against the fingerprint on a
// live mismatch log line. Match â†’ the stored secret is correct and the real
// cause is elsewhere (e.g. a second/legacy Meta App still subscribed to this
// WABA's webhook). No match â†’ the stored secret is simply wrong; re-enter it.
//
// The posted secret is used only in-memory for this one hash computation â€”
// it is never persisted, never written to a log, and never echoed back.
r.post('/webhook-secret-fingerprint', async (req, res) => {
  try {
    const { secret } = req.body || {};
    if (!secret || typeof secret !== 'string' || !secret.trim()) {
      return res.status(400).json({ error: 'Body must include a non-empty "secret" string.' });
    }
    const { fingerprintSecret } = await import('../controllers/tenantController.js');
    return res.json({ fingerprint: fingerprintSecret(secret) });
  } catch (err) {
    logger.error('[AdminRoutes] webhook-secret-fingerprint failed', { err: err.message });
    return res.status(500).json({ error: 'Failed to compute fingerprint.' });
  }
});

export default r;

