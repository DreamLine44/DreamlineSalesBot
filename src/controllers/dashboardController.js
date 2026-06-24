/**
 * controllers/dashboardController.js — WhatSalesAgent (Final Merged)
 *
 * FIXES applied:
 *
 * [FIX-6a]   updateOrderStatus validates status and notifies the customer via WhatsApp
 *            when their order is confirmed, completed, or cancelled/rejected.
 *            V2 was silently updating DB with no customer notification.
 *
 * [FIX-6b]   updateBookingStatus notifies customer on confirm/cancel/complete.
 *
 * [FIX-9]    Status enum validation on both update endpoints — previously an invalid
 *            status caused an unhandled Mongoose ValidationError (raw 500 stack trace).
 *
 * [FIX #11]  updateBookingStatus: when date or time changes, clear parsedDate AND
 *            reminderSentAt so the scheduler re-arms for the new appointment time.
 *            V1 nulled both unconditionally; V2 only nulled reminderSentAt and
 *            conditionally forwarded parsedDate from the request body.
 *            Correct behaviour: null both parsedDate and reminderSentAt on any
 *            date/time change — the scheduler will re-parse the new date itself.
 *
 * [FIX-4]    deleteMenuItem / deleteService / deleteFaq all check modifiedCount.
 *            $pull is a no-op when the subdocument ID doesn't exist; previously
 *            { ok: true } was always returned, making stale/typo IDs undetectable.
 *
 * [FIX-DASH-1] getCustomers supports ?page pagination (previously only ?limit existed).
 *
 * [MERGED]   Full Menu / Services / FAQ CRUD available on dashboard routes.
 *            V2 only had these under /business/:tenantId.
 *
 * [MERGED]   getCustomerOrderHistory — returns last N orders for a customer phone.
 */

import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Session        from '../models/Session.js';
import UserProfile    from '../models/UserProfile.js';
import BusinessConfig from '../models/BusinessConfig.js';
import Tenant         from '../models/Tenant.js';
import { getAnalyticsSummary } from '../core/analytics/analyticsService.js';
import { updateSession }       from '../core/sessions/sessionService.js';
import { dispatchText, dispatchMessage } from '../core/whatsapp/dispatcher.js';
import logger from '../config/logger.js';
import { uploadMenuImage, deleteMenuImage, CLOUDINARY_ENABLED } from '../config/cloudinary.js';

// ── Helper: load tenant doc for WhatsApp dispatch ─────────────────────────────
async function loadTenant(tenantId) {
  return Tenant.findById(tenantId).lean().catch(() => null);
}

// ── Overview ──────────────────────────────────────────────────────────────────
export async function getDashboardOverview(req, res) {
  try {
    const { tenantId } = req.params;
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [orders, bookings, customers, humanModes, analytics, business] = await Promise.all([
      Order.countDocuments({ tenantId, createdAt: { $gte: since30 } }),
      Booking.countDocuments({ tenantId, createdAt: { $gte: since30 } }),
      UserProfile.countDocuments({ tenantId }),
      Session.countDocuments({ tenantId, humanMode: true }),
      getAnalyticsSummary(tenantId, 30),
      BusinessConfig.findOne({ tenantId }).select('name businessMode adminPhone').lean(),
    ]);

    res.json({
      business,
      last30Days: { orders, bookings, customers, revenue: analytics.revenue },
      activeHumanSessions: humanModes,
    });
  } catch (err) {
    logger.error('[Dashboard] getDashboardOverview failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Orders ────────────────────────────────────────────────────────────────────
export async function getOrders(req, res) {
  try {
    const { tenantId } = req.params;
    const { status } = req.query;
    // Cap at 200 — matches the admin sessions endpoint. Prevents a caller passing
    // limit=100000 from triggering a full collection scan on a large tenant.
    const limit  = Math.min(Math.max(Number(req.query.limit)  || 50, 1), 200);
    const page   = Math.max(Number(req.query.page) || 1, 1);
    const filter = { tenantId, ...(status ? { status } : {}) };
    const skip   = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter),
    ]);
    res.json({ orders, total, page, pages: Math.ceil(total / limit), limit });
  } catch (err) {
    logger.error('[Dashboard] getOrders failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateOrderStatus(req, res) {
  try {
    const { tenantId, orderId } = req.params;
    const { status, notes } = req.body;

    // [FIX-9] Validate status before hitting Mongoose
    // [FIX-DASH-STATUS-MISSING] 'preparing', 'ready', 'out_for_delivery', and 'delivered'
    // were missing from this allowlist even though they are valid Order.status enum values.
    // Any dashboard PATCH to set an order to those statuses returned 400 "Invalid status".
    const VALID_ORDER_STATUSES = [
      'pending', 'payment_pending_verification', 'confirmed',
      'preparing', 'ready', 'out_for_delivery', 'delivered',
      'completed', 'cancelled', 'payment_failed', 'rejected',
    ];
    if (!VALID_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_ORDER_STATUSES.join(', ')}` });
    }

    const order = await Order.findOneAndUpdate(
      { _id: orderId, tenantId },
      { $set: {
          status,
          ...(notes ? { notes } : {}),
          // [FIX-DASH-6] When an order is rolled back to 'pending' the old paymentReference
          // is stale — it pointed to the previous payment cycle. Clear it so a new reference
          // is generated when the customer is shown payment instructions again. Without this
          // the scheduler / payment instructions UI would continue to display the old ref.
          ...(status === 'pending' ? { paymentReference: null } : {}),
          // Track lifecycle timestamps
          ...(status === 'preparing'        ? { preparingAt:      new Date() } : {}),
          ...(status === 'ready'            ? { readyAt:          new Date() } : {}),
          ...(status === 'out_for_delivery' ? { outForDeliveryAt: new Date() } : {}),
          ...(status === 'delivered'        ? { deliveredAt:      new Date() } : {}),
          ...(status === 'completed'        ? { completedAt:      new Date() } : {}),
        },
      },
      { new: true },
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // [FIX-6a] Notify customer — all significant status transitions
    try {
      const tenant = await loadTenant(tenantId);
      if (tenant && order.customerPhone) {
        const bizName = order.businessName || tenant.businessName || 'us';

        if (status === 'preparing') {
          // [FIX-NOTIFY-PREPARING] New notification for the PREPARING state.
          // Dashboard admins who set status → preparing were silently updating the DB
          // with no WhatsApp message to the customer. Customer would wonder what's happening.
          await dispatchText(order.customerPhone,
            `🍳 *Your order is being prepared!*\n\n` +
            `📦  *${order.item}* × ${order.quantity}\n` +
            `🔖  Reference: *#${order.shortId}*\n\n` +
            `Our kitchen is working on it — we'll message you the moment it's ready. 😊`,
            tenant);

        } else if (status === 'ready') {
          // [FIX-NOTIFY-READY] New notification for the READY state, with collection buttons.
          // Mirrors adminCommandService.markOrderReady() so dashboard and WhatsApp-command
          // paths produce identical customer experience.
          await dispatchMessage(order.customerPhone, {
            type: 'buttons',
            body:
              `🍽️ *Your Order is Ready!*\n\n` +
              `📦  *${order.item}* × ${order.quantity}\n` +
              `🔖  Reference: *#${order.shortId}*\n\n` +
              `Please collect your order at the counter 😊\n\n` +
              `Thank you for choosing *${bizName}*!`,
            buttons: [
              { id: `COLLECTED_${order.shortId}`, title: '✅ Collected — Thanks!' },
              { id: 'SUPPORT',                     title: '❓ Need Help'           },
            ],
          }, tenant);

          // [FIX-READY-SESSION] Set session to ORDER_READY so postFlowHandler handles
          // follow-up messages correctly (collected button, questions, etc.).
          await updateSession(order.customerPhone, String(tenantId), {
            currentFlow:  null, step: null,
            postFlowAck:  'ORDER_READY',
            postFlowData: { item: order.item, quantity: order.quantity, shortId: order.shortId },
          }).catch(() => {});

        } else if (status === 'out_for_delivery') {
          // [FIX-NOTIFY-OUT_FOR_DELIVERY] Delivery dispatch notification.
          await dispatchMessage(order.customerPhone, {
            type: 'buttons',
            body:
              `🚗 *Your order is on its way!*\n\n` +
              `📦  *${order.item}* × ${order.quantity}\n` +
              `🔖  Reference: *#${order.shortId}*\n\n` +
              `Sit tight — your delivery is en route! 🙏`,
            buttons: [
              { id: 'SUPPORT', title: '💬 Contact Us' },
            ],
          }, tenant);

        } else if (status === 'confirmed') {
          await dispatchText(order.customerPhone,
            `✅ *Your order is confirmed!*\n\n🍽 *${order.item}* × ${order.quantity}\n\nThank you for your patience! 😊`,
            tenant);
        } else if (status === 'cancelled' || status === 'rejected') {
          await dispatchText(order.customerPhone,
            `❌ *Order update*\n\nUnfortunately your order (*${order.item}*) has been ${status}.${notes ? `\n\nNote: ${notes}` : ''}\n\nPlease contact us if you have questions.`,
            tenant);
        } else if (status === 'completed') {
          await dispatchText(order.customerPhone,
            `🎉 *Order completed!*\n\nYour order of *${order.item}* is done. Enjoy! 😊`,
            tenant);
        }
      }
    } catch (notifyErr) {
      logger.warn('[Dashboard] Customer notification failed (non-fatal)', { err: notifyErr.message });
    }

    res.json({ order });
  } catch (err) {
    logger.error('[Dashboard] updateOrderStatus failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// Customer order history — last N orders for a phone number
export async function getCustomerOrderHistory(req, res) {
  try {
    const { tenantId, customerPhone } = req.params;
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);
    const orders = await Order.find({ tenantId, customerPhone })
      .sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ orders, count: orders.length, customerPhone });
  } catch (err) {
    logger.error('[Dashboard] getCustomerOrderHistory failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

/**
 * notifyOrderReady — POST /:tenantId/orders/:orderId/notify-ready
 *
 * [FIX-NOTIFY-READY-ENDPOINT] Dedicated endpoint for the dashboard "Notify Ready" button.
 *
 * The dashboard needs a clear, explicit action button: admin clicks "Order Ready — Notify
 * Customer" and the customer gets the WhatsApp collection message with Collected + Help buttons.
 *
 * This is separate from updateOrderStatus so:
 *  1. The admin can re-send the ready notification without changing status (e.g. customer
 *     missed the first message).
 *  2. The frontend can show a clearly labelled button ("📲 Notify Customer — Ready")
 *     instead of relying on a hidden side-effect of the status dropdown.
 *  3. Mirrors adminCommandService.markOrderReady() so dashboard and WhatsApp-command
 *     paths produce an identical customer experience.
 *
 * Behaviour:
 *  - Sets status → 'ready' and readyAt if not already ready.
 *  - Dispatches the collection WhatsApp message with Collected + Need Help buttons.
 *  - Sets session postFlowAck=ORDER_READY so postFlowHandler handles follow-ups correctly.
 *  - Returns { ok: true, order } on success.
 *  - Returns 404 if order not found for this tenant.
 *  - Returns 400 if order is already completed/cancelled/rejected.
 */
export async function notifyOrderReady(req, res) {
  try {
    const { tenantId, orderId } = req.params;

    // Allow re-notification if order is 'confirmed', 'preparing', or already 'ready'
    const order = await Order.findOneAndUpdate(
      {
        _id: orderId,
        tenantId,
        status: { $nin: ['completed', 'cancelled', 'rejected', 'payment_failed'] },
      },
      { $set: { status: 'ready', readyAt: new Date() } },
      { new: true },
    ).lean();

    if (!order) {
      const existing = await Order.findOne({ _id: orderId, tenantId }).select('status').lean();
      if (!existing) return res.status(404).json({ error: 'Order not found' });
      return res.status(400).json({ error: `Cannot notify ready — order is already ${existing.status}.` });
    }

    const tenant = await loadTenant(tenantId);
    if (!tenant) {
      logger.warn('[Dashboard] notifyOrderReady: tenant not found (non-fatal)', { tenantId });
    } else {
      const biz = await BusinessConfig.findOne({ tenantId }).select('name').lean();
      const bizName = biz?.name || 'us';

      await dispatchMessage(order.customerPhone, {
        type: 'buttons',
        body:
          `🍽️ *Your Order is Ready!*\n\n` +
          `📦  *${order.item}* × ${order.quantity}\n` +
          `🔖  Reference: *#${order.shortId}*\n\n` +
          `Please collect your order at the counter 😊\n\n` +
          `Thank you for choosing *${bizName}*!`,
        buttons: [
          { id: `COLLECTED_${order.shortId}`, title: '✅ Collected — Thanks!' },
          { id: 'SUPPORT',                     title: '❓ Need Help'           },
        ],
      }, tenant);

      // Set session so postFlowHandler handles follow-up messages correctly
      await updateSession(order.customerPhone, String(tenantId), {
        currentFlow:  null, step: null,
        postFlowAck:  'ORDER_READY',
        postFlowData: { item: order.item, quantity: order.quantity, shortId: order.shortId },
      }).catch(err => logger.warn('[Dashboard] notifyOrderReady: session update failed (non-fatal)', { err: err.message }));
    }

    logger.info('[Dashboard] Order ready notification sent', { orderId, customerPhone: order.customerPhone });
    res.json({ ok: true, order });
  } catch (err) {
    logger.error('[Dashboard] notifyOrderReady failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Bookings ──────────────────────────────────────────────────────────────────
export async function getBookings(req, res) {
  try {
    const { tenantId } = req.params;
    const { status } = req.query;
    const limit  = Math.min(Math.max(Number(req.query.limit)  || 50, 1), 200);
    const page   = Math.max(Number(req.query.page) || 1, 1);
    const filter = { tenantId, ...(status ? { status } : {}) };
    const skip   = (page - 1) * limit;
    const [bookings, total] = await Promise.all([
      Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Booking.countDocuments(filter),
    ]);
    res.json({ bookings, total, page, pages: Math.ceil(total / limit), limit });
  } catch (err) {
    logger.error('[Dashboard] getBookings failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateBookingStatus(req, res) {
  try {
    const { tenantId, bookingId } = req.params;
    const { status, adminNote } = req.body;

    // [FIX-9] Validate status
    const VALID_BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!VALID_BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_BOOKING_STATUSES.join(', ')}` });
    }

    const updateFields = { status, ...(adminNote ? { adminNote } : {}) };

    // [FIX #11] When date or time changes, null BOTH parsedDate AND reminderSentAt.
    // parsedDate holds the last scheduler-parsed DateTime — it must be cleared so the
    // scheduler re-parses the new date string rather than targeting the old appointment.
    // reminderSentAt must be cleared so the reminder re-arms for the new slot.
    // V1 cleared both but also forwarded parsedDate from the body (wrong — stale value);
    // V2 kept the body's parsedDate (also wrong). Correct: null both, let scheduler re-parse.
    if (req.body.date !== undefined || req.body.time !== undefined) {
      if (req.body.date !== undefined) updateFields.date = req.body.date;
      if (req.body.time !== undefined) updateFields.time = req.body.time;
      updateFields.parsedDate     = null; // force scheduler to re-parse
      updateFields.reminderSentAt = null; // re-arm the reminder
    }

    const booking = await Booking.findOneAndUpdate(
      { _id: bookingId, tenantId },
      { $set: updateFields },
      { new: true },
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // [FIX-6b] Notify customer
    try {
      const tenant = await loadTenant(tenantId);
      if (tenant && booking.customerPhone) {
        const when = booking.time ? `${booking.date} at ${booking.time}` : booking.date;
        const svcStr = booking.service ? ` (${booking.service})` : '';
        const partySuffix = booking.partySize ? ` for ${booking.partySize} guest${booking.partySize > 1 ? 's' : ''}` : '';

        if (status === 'confirmed') {
          await dispatchText(booking.customerPhone,
            `✅ *Booking Confirmed!*\n\n📅 *${when}*${svcStr}${partySuffix}\n\nWe look forward to seeing you! 😊`,
            tenant);
        } else if (status === 'cancelled') {
          const reason = adminNote ? `\n\nReason: ${adminNote}` : '';
          await dispatchText(booking.customerPhone,
            `❌ *Booking Cancelled*\n\nSorry, your booking${svcStr} for *${when}* has been cancelled.${reason}\n\nPlease contact us to reschedule.`,
            tenant);
        } else if (status === 'completed') {
          await dispatchText(booking.customerPhone,
            `🎉 Thank you for visiting${svcStr ? ` for your ${booking.service}` : ''}! We hope to see you again soon. 😊`,
            tenant);
        }
      }
    } catch (notifyErr) {
      logger.warn('[Dashboard] Booking notification failed (non-fatal)', { err: notifyErr.message });
    }

    res.json({ booking });
  } catch (err) {
    logger.error('[Dashboard] updateBookingStatus failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Analytics ─────────────────────────────────────────────────────────────────
export async function getAnalytics(req, res) {
  try {
    const { tenantId } = req.params;
    const { days = 30 } = req.query;
    const summary = await getAnalyticsSummary(tenantId, Number(days));
    res.json(summary);
  } catch (err) {
    logger.error('[Dashboard] Request failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Conversations / Sessions ──────────────────────────────────────────────────
export async function getConversations(req, res) {
  try {
    const { tenantId } = req.params;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    // [FIX-CONV-1] Always include humanMode sessions regardless of TTL.
    // A session with humanMode=true may have expired from MongoDB's TTL sweep, but the
    // customer is still in the human handoff queue waiting for an admin response. Filtering
    // strictly by expiresAt > now hides these customers from the dashboard, making it appear
    // no one is waiting when actually they are — the admin has no way to find them.
    // Fix: use $or so live sessions AND expired humanMode sessions both appear.
    const now = new Date();
    const sessions = await Session.find({
      tenantId,
      $or: [
        { expiresAt: { $gt: now } },          // active sessions
        { humanMode: true },                   // expired but still in human handoff
      ],
    })
      .sort({ lastSeen: -1 }).limit(limit)
      .select('customerPhone customerName lastSeen messageCount humanMode currentFlow').lean();
    res.json({ conversations: sessions, count: sessions.length });
  } catch (err) {
    logger.error('[Dashboard] Request failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function setHumanMode(req, res) {
  try {
    const { tenantId, phone } = req.params;
    const { humanMode } = req.body;
    if (typeof humanMode !== 'boolean') {
      return res.status(400).json({ error: 'humanMode must be a boolean' });
    }
    // [FIX-DASH-2] updateSession is now a static top-level import.
    // The previous dynamic import() was unnecessary — sessionService has no circular
    // dependencies with dashboardController — and added async resolution overhead on
    // every humanMode toggle (a frequent admin action).
    const session = await updateSession(phone, tenantId, { humanMode });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // When handing back to bot, let the customer know
    if (!humanMode) {
      try {
        const tenant = await loadTenant(tenantId);
        if (tenant) {
          await dispatchText(phone,
            `You're now connected back to our automated assistant. How can we help? 😊`,
            tenant);
        }
      } catch {}
    }

    res.json({ ok: true, humanMode: session.humanMode });
  } catch (err) {
    logger.error('[Dashboard] Request failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Customers ─────────────────────────────────────────────────────────────────
export async function getCustomers(req, res) {
  try {
    const { tenantId } = req.params;
    // [FIX-DASH-1] ?page pagination support
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page  = Math.max(Number(req.query.page)  || 1, 1);
    const skip  = (page - 1) * limit;

    const filter = { tenantId };
    // [FIX-SEARCH] ?search= filters by name or phone with a case-insensitive prefix/substring match.
    // Applied server-side so large tenants don't have to fetch the full customer list
    // just to find one person.
    if (req.query.search?.trim()) {
      const q = req.query.search.trim();
      filter.$or = [
        { name:          { $regex: q, $options: 'i' } },
        { customerName:  { $regex: q, $options: 'i' } },
        { phone:         { $regex: q, $options: 'i' } },
        { customerPhone: { $regex: q, $options: 'i' } },
      ];
    }

    const [profiles, total] = await Promise.all([
      UserProfile.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      UserProfile.countDocuments(filter),
    ]);

    res.json({
      customers: profiles,
      count:     profiles.length,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error('[Dashboard] Request failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Business settings ─────────────────────────────────────────────────────────
export async function getBusinessSettings(req, res) {
  try {
    const { tenantId } = req.params;
    const business = await BusinessConfig.findOne({ tenantId })
      .select('name description businessMode adminPhone menuItems services faq payment leadCapture hours customMessages addOns settings')
      .lean();
    if (!business) return res.status(404).json({ error: 'Business not found' });
    res.json({ business });
  } catch (err) {
    logger.error('[Dashboard] Request failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateBusinessSettings(req, res) {
  try {
    const { tenantId } = req.params;
    const allowed = ['name', 'description', 'adminPhone', 'payment', 'leadCapture',
                     'customMessages', 'hours', 'settings', 'businessMode', 'addOns'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    // [FIX-TONE-3] findOneAndUpdate bypasses Mongoose pre('save') hooks — inline
    // tone sync when businessMode changes so tone fields stay consistent.
    if (updates.businessMode) {
      const toneMap = {
        RESTAURANT:  { style: 'FRIENDLY',     industry: 'RESTAURANT'  },
        BAKERY:      { style: 'FRIENDLY',     industry: 'BAKERY'      },
        RETAIL:      { style: 'PROFESSIONAL', industry: 'RETAIL'      },
        FASHION:     { style: 'PREMIUM',      industry: 'FASHION'     },
        ELECTRONICS: { style: 'PROFESSIONAL', industry: 'ELECTRONICS' },
        SALON:       { style: 'PROFESSIONAL', industry: 'SALON'       },
        BARBERSHOP:  { style: 'FRIENDLY',     industry: 'BARBERSHOP'  },
        COSMETICS:   { style: 'PREMIUM',      industry: 'COSMETICS'   },
        DELIVERY:    { style: 'FRIENDLY',     industry: 'DELIVERY'    },
        SERVICES:    { style: 'PROFESSIONAL', industry: 'SERVICES'    },
        GENERAL:     { style: 'FRIENDLY',     industry: 'GENERAL'     },
      };
      const t = toneMap[updates.businessMode.toUpperCase()];
      if (t) { updates['tone.style'] = t.style; updates['tone.industry'] = t.industry; }
    }

    const business = await BusinessConfig.findOneAndUpdate(
      { tenantId }, { $set: updates }, { new: true, runValidators: true }
    );
    if (!business) return res.status(404).json({ error: 'Business not found' });
    res.json({ ok: true, business });
  } catch (err) {
    logger.error('[Dashboard] Request failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// ── Menu CRUD ─────────────────────────────────────────────────────────────────
export async function getMenu(req, res) {
  try {
    const biz = await BusinessConfig.findOne({ tenantId: req.params.tenantId })
      .select('menuItems').lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ menuItems: biz.menuItems || [], count: (biz.menuItems || []).length });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function addMenuItem(req, res) {
  try {
    const { tenantId } = req.params;
    const { name, price, description, available = true, showImageOnSelect = true } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

    // ── Parse array fields sent as JSON strings from multipart/form-data ─────
    // When using multipart (for image upload), array fields arrive as strings.
    let keywords = req.body.keywords ?? [];
    if (typeof keywords === 'string') {
      try { keywords = JSON.parse(keywords); } catch { keywords = keywords ? [keywords] : []; }
    }
    let tags = req.body.tags ?? [];
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags); } catch { tags = tags ? [tags] : []; }
    }

    // ── Cloudinary image upload (optional) ────────────────────────────────────
    let image = { url: null, public_id: null };
    if (req.file) {
      if (!CLOUDINARY_ENABLED) {
        return res.status(503).json({ error: 'Image uploads are not configured on this server. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.' });
      }
      try {
        const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        image = await uploadMenuImage(dataUri, { tenantId });
        logger.info('[Dashboard] Menu image uploaded', { tenantId, public_id: image.public_id });
      } catch (uploadErr) {
        logger.error('[Dashboard] Cloudinary upload failed', { err: uploadErr.message });
        return res.status(502).json({ error: `Image upload failed: ${uploadErr.message}` });
      }
    }

    const newItem = {
      name:             String(name).trim(),
      price:            Number(price) || 0,
      description,
      available:        available === 'false' ? false : Boolean(available),
      keywords,
      tags,
      showImageOnSelect: showImageOnSelect === 'false' ? false : Boolean(showImageOnSelect),
      image,
    };

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $push: { menuItems: newItem } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ menuItems: biz.menuItems });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function updateMenuItem(req, res) {
  try {
    const { tenantId, itemId } = req.params;
    const { name, price, description, available, showImageOnSelect, removeImage } = req.body;
    const patch = {};
    if (name              !== undefined) patch['menuItems.$.name']             = name;
    if (price             !== undefined) patch['menuItems.$.price']            = Number(price);
    if (description       !== undefined) patch['menuItems.$.description']      = description;
    if (available         !== undefined) patch['menuItems.$.available']        = available === 'false' ? false : Boolean(available);
    if (showImageOnSelect !== undefined) patch['menuItems.$.showImageOnSelect'] = showImageOnSelect === 'false' ? false : Boolean(showImageOnSelect);

    // ── Parse array fields sent as JSON strings from multipart/form-data ─────
    let keywords = req.body.keywords;
    if (keywords !== undefined) {
      if (typeof keywords === 'string') {
        try { keywords = JSON.parse(keywords); } catch { keywords = keywords ? [keywords] : []; }
      }
      patch['menuItems.$.keywords'] = keywords;
    }
    let tags = req.body.tags;
    if (tags !== undefined) {
      if (typeof tags === 'string') {
        try { tags = JSON.parse(tags); } catch { tags = tags ? [tags] : []; }
      }
      patch['menuItems.$.tags'] = tags;
    }

    // ── Image logic: upload and remove are mutually exclusive ─────────────────
    // If both req.file and removeImage arrive (malformed request), upload wins.
    if (req.file) {
      if (!CLOUDINARY_ENABLED) {
        return res.status(503).json({ error: 'Image uploads are not configured on this server.' });
      }
      // Single DB read: fetch existing public_id so we can overwrite cleanly
      const existing = await BusinessConfig.findOne(
        { tenantId, 'menuItems._id': itemId },
        { 'menuItems.$': 1 },
      ).lean();
      const oldPublicId = existing?.menuItems?.[0]?.image?.public_id || null;

      try {
        const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        const uploaded = await uploadMenuImage(dataUri, { tenantId, publicId: oldPublicId || undefined });
        patch['menuItems.$.image'] = { url: uploaded.url, public_id: uploaded.public_id };
        logger.info('[Dashboard] Menu image replaced', { tenantId, itemId, public_id: uploaded.public_id });
      } catch (uploadErr) {
        logger.error('[Dashboard] Cloudinary upload failed', { err: uploadErr.message });
        return res.status(502).json({ error: `Image upload failed: ${uploadErr.message}` });
      }
    } else if (removeImage === 'true' || removeImage === true) {
      // Remove image — only runs when no new file is being uploaded
      const existing = await BusinessConfig.findOne(
        { tenantId, 'menuItems._id': itemId },
        { 'menuItems.$': 1 },
      ).lean();
      const oldPublicId = existing?.menuItems?.[0]?.image?.public_id;
      if (oldPublicId) await deleteMenuImage(oldPublicId);
      patch['menuItems.$.image'] = { url: null, public_id: null };
    }

    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'menuItems._id': itemId },
      { $set: patch },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Item not found' });
    res.json({ menuItems: biz.menuItems });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function deleteMenuItem(req, res) {
  try {
    const { tenantId, itemId } = req.params;

    // Fetch the item's image public_id before deleting (for Cloudinary cleanup)
    const existing = await BusinessConfig.findOne(
      { tenantId, 'menuItems._id': itemId },
      { 'menuItems.$': 1 },
    ).lean();
    const imagePublicId = existing?.menuItems?.[0]?.image?.public_id;

    // [FIX-4] $pull is a no-op when subdoc ID doesn't exist; check modifiedCount
    const result = await BusinessConfig.updateOne(
      { tenantId },
      { $pull: { menuItems: { _id: itemId } } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Business not found' });
    if (result.modifiedCount === 0) return res.status(404).json({ error: 'Menu item not found' });

    // Clean up Cloudinary image (non-fatal — item is already removed from DB)
    if (imagePublicId) await deleteMenuImage(imagePublicId);

    res.json({ ok: true });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

// ── Services CRUD ─────────────────────────────────────────────────────────────
export async function getServices(req, res) {
  try {
    const biz = await BusinessConfig.findOne({ tenantId: req.params.tenantId })
      .select('services').lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ services: biz.services || [], count: (biz.services || []).length });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function addService(req, res) {
  try {
    const { tenantId } = req.params;
    const { name, price, description, duration, available = true } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $push: { services: { name, price: Number(price) || 0, description, duration: Number(duration) || 30, available } } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ services: biz.services });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function updateService(req, res) {
  try {
    const { tenantId, serviceId } = req.params;
    const { name, price, description, duration, available } = req.body;
    const patch = {};
    if (name        !== undefined) patch['services.$.name']        = name;
    if (price       !== undefined) patch['services.$.price']       = Number(price);
    if (description !== undefined) patch['services.$.description'] = description;
    if (duration    !== undefined) patch['services.$.duration']    = Number(duration);
    if (available   !== undefined) patch['services.$.available']   = available;

    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'services._id': serviceId },
      { $set: patch },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Service not found' });
    res.json({ services: biz.services });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function deleteService(req, res) {
  try {
    const { tenantId, serviceId } = req.params;
    // [FIX-4] Check modifiedCount
    const result = await BusinessConfig.updateOne(
      { tenantId },
      { $pull: { services: { _id: serviceId } } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Business not found' });
    if (result.modifiedCount === 0) return res.status(404).json({ error: 'Service not found' });
    res.json({ ok: true });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

// ── FAQ CRUD ──────────────────────────────────────────────────────────────────
export async function getFaqs(req, res) {
  try {
    const biz = await BusinessConfig.findOne({ tenantId: req.params.tenantId })
      .select('faq').lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ faq: biz.faq || [], count: (biz.faq || []).length });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function addFaq(req, res) {
  try {
    const { tenantId } = req.params;
    const { trigger, reply } = req.body;
    if (!trigger || !reply) return res.status(400).json({ error: 'trigger and reply required' });

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $push: { faq: { trigger, reply } } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ faq: biz.faq });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function updateFaq(req, res) {
  try {
    const { tenantId, faqId } = req.params;
    const { trigger, reply } = req.body;
    const patch = {};
    if (trigger !== undefined) patch['faq.$.trigger'] = trigger;
    if (reply   !== undefined) patch['faq.$.reply']   = reply;

    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'faq._id': faqId },
      { $set: patch },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'FAQ not found' });
    res.json({ faq: biz.faq });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function deleteFaq(req, res) {
  try {
    const { tenantId, faqId } = req.params;
    // [FIX-4] Check modifiedCount
    const result = await BusinessConfig.updateOne(
      { tenantId },
      { $pull: { faq: { _id: faqId } } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Business not found' });
    if (result.modifiedCount === 0) return res.status(404).json({ error: 'FAQ not found' });
    res.json({ ok: true });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}
