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
import WhatsAppConnectionRequest from '../models/WhatsAppConnectionRequest.js';
import { getAnalyticsSummary, getAnalyticsTimeseries } from '../core/analytics/analyticsService.js';
import { scheduleWaCatalogSync } from '../modules/catalog/waCatalogSyncScheduler.js';
import { getTenantUsageSummary } from '../services/usageService.js';
import { updateSession }       from '../core/sessions/sessionService.js';
import { dispatchText, dispatchMessage } from '../core/whatsapp/dispatcher.js';
import logger from '../config/logger.js';

// [AUDIT-FIX-9] User-supplied search strings were interpolated directly into
// $regex filters (getCustomers below, and the equivalent pattern in
// tenantController.listTenants). Two real problems: (1) a search containing
// a regex metacharacter that isn't a valid standalone pattern — e.g. a phone
// number search like "+220..." starts with an unescaped quantifier — throws
// a MongoDB regex-compile error and 500s the request for an entirely
// legitimate query; (2) a crafted pattern (e.g. nested quantifiers) can
// trigger catastrophic backtracking against every document field scanned,
// a regex-injection DoS vector. Escaping all regex metacharacters before
// building the filter makes the search a literal substring match again,
// which is what "search by name or phone" was always meant to be.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
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

    const [orders, bookings, customers, humanModes, analytics, business, usage, tenantDoc] = await Promise.all([
      Order.countDocuments({ tenantId, createdAt: { $gte: since30 } }),
      Booking.countDocuments({ tenantId, createdAt: { $gte: since30 } }),
      UserProfile.countDocuments({ tenantId }),
      Session.countDocuments({ tenantId, humanMode: true }),
      getAnalyticsSummary(tenantId, 30),
      // [PROFILE-COMPLETE-1] Added description/address/payment/faq/customMessages
      // to the existing select so profile-completeness can be computed here
      // without an extra DB round-trip.
      BusinessConfig.findOne({ tenantId }).select('name description address hours payment menuItems faq customMessages businessMode adminPhone').lean(),
      // [AUDIT-FIX-USAGE-1] Plan/usage was tracked nowhere in the dashboard —
      // a tenant had no way to see how close they were to their plan's
      // message or menu-item cap. Standard SaaS-dashboard expectation.
      getTenantUsageSummary(tenantId),
      Tenant.findById(tenantId).select('whatsapp.connected').lean(),
    ]);

    res.json({
      business: business ? { ...business, menuItems: undefined, menuItemCount: (business.menuItems || []).length } : business,
      last30Days: { orders, bookings, customers, revenue: analytics.revenue },
      activeHumanSessions: humanModes,
      plan: usage ? {
        tier:   usage.plan,
        limits: usage.limits,
        usage:  usage.usage,
        menuItemsUsed: (business?.menuItems || []).length,
      } : null,
      // [PROFILE-COMPLETE-1] Onboarding checklist for the dashboard home screen.
      profileCompleteness: business ? computeProfileCompleteness(business, tenantDoc) : null,
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
          ...(status === 'confirmed' ? { abandonedCartAt: null } : {}),
          // [FIX-32] Clear abandonedCartAt on completion/cancellation — order is no longer
          // "abandoned" regardless of outcome. Without this, the scheduler job could send
          // a follow-up nudge for an order that was already completed or cancelled.
          ...(status === 'completed' || status === 'cancelled' || status === 'rejected' ? { abandonedCartAt: null } : {}),
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
        // [AUDIT-FIX-BIZNAME] order.businessName and tenant.businessName are not real
        // fields on either schema (Order has no businessName column; Tenant's only name
        // field is `name`, not `businessName`) — this always silently fell through to the
        // 'us' fallback, so every status-change notification below said "Thank you for
        // choosing *us*!" instead of the tenant's actual business name. Fixed to load
        // BusinessConfig.name, exactly like the working pattern in notifyOrderReady() below.
        const biz = await BusinessConfig.findOne({ tenantId }).select('name').lean();
        const bizName = biz?.name || 'us';

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
          // [FIX-23] Set postFlowAck=ORDER_CONFIRMED so any customer follow-up after
          // a dashboard-triggered confirmation gets a warm ORDER_CONFIRMED context reply
          // instead of the cold "👋 Welcome! What would you like to do?" (GREET).
          // This mirrors the WhatsApp button path (adminCommandService.confirmPayment()).
          await updateSession(order.customerPhone, String(tenantId), {
            currentFlow:  null, step: null,
            postFlowAck:  'ORDER_CONFIRMED',
            postFlowData: { item: order.item, quantity: order.quantity, shortId: order.shortId },
          }).catch(() => {});
          await dispatchText(order.customerPhone,
            `✅ *Your order is confirmed!*\n\n🍽 *${order.item}* × ${order.quantity}\n\nThank you for your patience! 😊`,
            tenant);
        } else if (status === 'cancelled' || status === 'rejected') {
          // [FIX-23] Set postFlowAck=ORDER_REJECTED so customer follow-up ("ok", "why?")
          // is handled with rejection-context empathy, not a generic welcome screen.
          await updateSession(order.customerPhone, String(tenantId), {
            currentFlow:  null, step: null,
            postFlowAck:  'ORDER_REJECTED',
            postFlowData: { item: order.item, shortId: order.shortId, rejectReason: notes || null },
          }).catch(() => {});
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

// [IMPROVE-TIMESERIES] New endpoint — getAnalytics above only ever returned 3
// flat numbers (orders/bookings/revenue totals), nothing chart-shaped. This
// gives the frontend a real day-by-day breakdown plus top items, without
// changing the existing getAnalytics response that may already be relied on.
export async function getAnalyticsTimeseriesHandler(req, res) {
  try {
    const { tenantId } = req.params;
    const { days = 30 } = req.query;
    const timeseries = await getAnalyticsTimeseries(tenantId, Number(days));
    res.json(timeseries);
  } catch (err) {
    logger.error('[Dashboard] getAnalyticsTimeseries failed', { err: err.message });
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
    // [AUDIT-FIX-9] Added Math.max(...,1) lower bound — every other paginated
    // endpoint in this file (orders, bookings) bounds limit to [1,200]; this one
    // only bounded the upper end, so ?limit=-5 (or any negative number) passed
    // straight through to Mongoose's .limit(), which is undefined/surprising
    // behaviour for a negative skip-less page size.
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page  = Math.max(Number(req.query.page)  || 1, 1);
    const skip  = (page - 1) * limit;

    const filter = { tenantId };
    // [FIX-SEARCH] ?search= filters by name or phone with a case-insensitive prefix/substring match.
    // Applied server-side so large tenants don't have to fetch the full customer list
    // just to find one person.
    if (req.query.search?.trim()) {
      const q = escapeRegex(req.query.search.trim());
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
      .select('name description businessMode adminPhone menuItems services faq payment leadCapture hours customMessages addOns settings waCatalog')
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
    // [AUDIT-FIX-CATALOG-TENANT-1] Tenants manage their own catalog the same way
    // they already manage payment channels and hours — through this dashboard
    // settings endpoint, not through the super-admin-only /admin/tenants routes.
    // Added 'waCatalog' to the whitelist so PATCH /dashboard/:tenantId/settings
    // { waCatalog: { enabled: true } } actually reaches BusinessConfig instead
    // of being silently dropped by this allowlist like every other
    // "field missing from the accepted set" bug already fixed elsewhere.
    const allowed = ['name', 'description', 'adminPhone', 'payment', 'leadCapture',
                     'customMessages', 'hours', 'settings', 'businessMode', 'addOns',
                     'waCatalog'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    // [AUDIT-FIX-CATALOG-TENANT-1] Mirror [CATALOG-BIZ-1] from businessController.js:
    // a plain nested $set REPLACES the whole waCatalog subdocument rather than
    // merging, so a tenant flipping the toggle with { waCatalog: { enabled: false } }
    // would silently wipe their own catalogId/mode/lastSyncedAt history. Flatten to
    // dot-notation so each sub-field updates independently.
    if (updates.waCatalog && typeof updates.waCatalog === 'object') {
      // Guard: refuse to turn catalog ON without a catalogId either already on
      // file or supplied in this same request. Mirrors isCatalogEnabled() in
      // waCatalogConfig.js, which already treats enabled:true + no catalogId as
      // "off" — better to tell the tenant why the toggle didn't do anything than
      // let them believe it's live when every sync/send call will just no-op.
      if (updates.waCatalog.enabled === true) {
        const existing = await BusinessConfig.findOne({ tenantId })
          .select('waCatalog.catalogId phoneNumberId').lean();
        const effectiveCatalogId = updates.waCatalog.catalogId !== undefined
          ? updates.waCatalog.catalogId
          : existing?.waCatalog?.catalogId;
        if (!effectiveCatalogId) {
          return res.status(400).json({
            error: 'Cannot enable WhatsApp Catalog without a catalogId. '
                 + 'Include { "waCatalog": { "enabled": true, "catalogId": "..." } } in this request.',
          });
        }
        // [AUDIT-FIX-CATALOG-TENANT-2] Mirrors the same SIM_ placeholder guard
        // applied at tenant creation ([AUDIT-FIX-CATALOG-CREATE-1]) — a tenant
        // whose WhatsApp number hasn't been connected yet (still PENDING/
        // INACTIVE) cannot have a working catalog no matter what they toggle
        // here, since Meta's Commerce Catalog is tied to a real WABA/phone
        // number. Tell them why instead of silently accepting a toggle that
        // wacatalog/health and every sync call will reject anyway.
        if (!existing?.phoneNumberId || existing.phoneNumberId.startsWith('SIM_')) {
          return res.status(400).json({
            // [NO-SELFSERVE-1] WhatsApp connection is provisioned by the platform
            // admin only — never worded as something the tenant can "complete"
            // themselves, to avoid implying a self-connect flow that doesn't exist.
            error: 'Cannot enable WhatsApp Catalog until your WhatsApp number is connected. '
                 + 'Contact your account admin to get WhatsApp connected, then try again.',
          });
        }
      }
      for (const [k, v] of Object.entries(updates.waCatalog)) {
        updates[`waCatalog.${k}`] = v;
      }
      delete updates.waCatalog;
    }

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

    // [AUDIT-FIX-USAGE-1] Tenant.limits.maxMenuItems has existed in the schema
    // since early in this project but was never checked anywhere — a FREE-plan
    // tenant (default cap 10) could add unlimited menu items via this endpoint.
    // Check-then-write has a small race window under concurrent requests, but
    // menu editing is a low-frequency admin action (not a hot customer-facing
    // path), so an occasional off-by-one over the cap is an acceptable trade
    // for not adding transaction overhead here.
    const [tenantLimits, currentBiz] = await Promise.all([
      Tenant.findById(tenantId).select('limits.maxMenuItems').lean(),
      BusinessConfig.findOne({ tenantId }).select('menuItems').lean(),
    ]);
    const maxMenuItems = tenantLimits?.limits?.maxMenuItems ?? 10;
    const currentCount = (currentBiz?.menuItems || []).length;
    if (currentCount >= maxMenuItems) {
      return res.status(403).json({
        // [NO-SELFSERVE-1] No self-serve billing/upgrade exists — only the
        // platform admin changes a tenant's plan. Worded so the tenant knows
        // who to ask, not "upgrade your plan" (which implies a button that
        // isn't there).
        error: `Menu item limit reached (${currentCount}/${maxMenuItems} on your current plan). `
             + `Contact your account admin to raise your plan limit, or remove an existing item to add a new one.`,
        limit: maxMenuItems,
        current: currentCount,
      });
    }

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
    // [FIX-VARIANTS-SCHEMA] Accept variants the same way as keywords/tags —
    // JSON-string when arriving via multipart/form-data (image upload path),
    // plain array otherwise. Now that menuItemSchema declares `variants`,
    // this is the write path that actually persists them.
    let variants = req.body.variants ?? [];
    if (typeof variants === 'string') {
      try { variants = JSON.parse(variants); } catch { variants = variants ? [variants] : []; }
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
      variants,
      showImageOnSelect: showImageOnSelect === 'false' ? false : Boolean(showImageOnSelect),
      image,
    };

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $push: { menuItems: newItem } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });

    // [CATALOG-AUTOSYNC-1] Fire-and-forget: debounced, only actually syncs if
    // this tenant has WA Catalog enabled. Never awaited — must not delay the
    // response or fail the request if Meta's API has a hiccup later.
    scheduleWaCatalogSync(tenantId);

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
    // [FIX-VARIANTS-SCHEMA] Same string-or-array handling as keywords/tags above.
    let variants = req.body.variants;
    if (variants !== undefined) {
      if (typeof variants === 'string') {
        try { variants = JSON.parse(variants); } catch { variants = variants ? [variants] : []; }
      }
      patch['menuItems.$.variants'] = variants;
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

    // [CATALOG-AUTOSYNC-1] See addMenuItem — same fire-and-forget debounce.
    scheduleWaCatalogSync(tenantId);

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

    // [CATALOG-AUTOSYNC-1] / [CATALOG-CRUD-1] Deleting an item now actually
    // removes it from Meta's catalog too — syncMenuToCatalog() diffs the
    // current menu against waCatalog.syncedRetailerIds and sends a DELETE
    // batch request for anything that dropped out.
    scheduleWaCatalogSync(tenantId);

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

// ── Promotions / Discount codes CRUD [PROMO-1] ────────────────────────────────
export async function getPromotions(req, res) {
  try {
    const biz = await BusinessConfig.findOne({ tenantId: req.params.tenantId })
      .select('promotions').lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ promotions: biz.promotions || [], count: (biz.promotions || []).length });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function addPromotion(req, res) {
  try {
    const { tenantId } = req.params;
    const { code, type, value, active = true, minOrderValue, maxUses, expiresAt, description } = req.body;

    if (!code || !String(code).trim()) return res.status(400).json({ error: 'code required' });
    if (!['PERCENT', 'FIXED'].includes(type)) return res.status(400).json({ error: "type must be 'PERCENT' or 'FIXED'" });
    if (value == null || Number.isNaN(Number(value)) || Number(value) < 0) {
      return res.status(400).json({ error: 'value must be a non-negative number' });
    }
    if (type === 'PERCENT' && Number(value) > 100) {
      return res.status(400).json({ error: 'PERCENT value cannot exceed 100' });
    }

    const normalizedCode = String(code).trim().toUpperCase();

    // Codes must be unique per tenant — check before push since Mongoose can't
    // enforce uniqueness within a single document's array via a schema index.
    const existing = await BusinessConfig.findOne({ tenantId, 'promotions.code': normalizedCode }).select('_id').lean();
    if (existing) return res.status(409).json({ error: `A promo code '${normalizedCode}' already exists` });

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $push: { promotions: {
          code: normalizedCode, type, value: Number(value), active: Boolean(active),
          minOrderValue: Number(minOrderValue) || 0,
          maxUses: maxUses != null ? Number(maxUses) : null,
          expiresAt: expiresAt || null,
          description: description || '',
        } } },
      { new: true, runValidators: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ promotions: biz.promotions });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function updatePromotion(req, res) {
  try {
    const { tenantId, promoId } = req.params;
    const { type, value, active, minOrderValue, maxUses, expiresAt, description } = req.body;
    const patch = {};
    if (type          !== undefined) {
      if (!['PERCENT', 'FIXED'].includes(type)) return res.status(400).json({ error: "type must be 'PERCENT' or 'FIXED'" });
      patch['promotions.$.type'] = type;
    }
    if (value         !== undefined) patch['promotions.$.value']         = Number(value);
    if (active        !== undefined) patch['promotions.$.active']        = Boolean(active);
    if (minOrderValue !== undefined) patch['promotions.$.minOrderValue'] = Number(minOrderValue);
    if (maxUses       !== undefined) patch['promotions.$.maxUses']       = maxUses != null ? Number(maxUses) : null;
    if (expiresAt     !== undefined) patch['promotions.$.expiresAt']     = expiresAt || null;
    if (description   !== undefined) patch['promotions.$.description']  = description;

    if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'promotions._id': promoId },
      { $set: patch },
      { new: true, runValidators: true },
    );
    if (!biz) return res.status(404).json({ error: 'Promotion not found' });
    res.json({ promotions: biz.promotions });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function deletePromotion(req, res) {
  try {
    const { tenantId, promoId } = req.params;
    const result = await BusinessConfig.updateOne(
      { tenantId },
      { $pull: { promotions: { _id: promoId } } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Business not found' });
    if (result.modifiedCount === 0) return res.status(404).json({ error: 'Promotion not found' });
    res.json({ ok: true });
  } catch (err) { logger.error('[Dashboard] Request failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

// ── CSV Export — orders / bookings ────────────────────────────────────────────
// [EXPORT-1] Tenants routinely need to pull orders/bookings into a spreadsheet
// for accounting, supplier reconciliation, or reporting to their own investors —
// a standard SaaS-dashboard expectation. Read-only, reuses the exact same
// filter shape as getOrders/getBookings so "export what I'm currently viewing"
// behaves predictably. Capped at 5000 rows per export to keep the request fast
// and avoid an accidental multi-year full-table dump timing out.
const CSV_EXPORT_ROW_CAP = 5000;

function toCsvValue(v) {
  if (v == null) return '';
  const s = String(v);
  // Quote any field containing a comma, quote, or newline; escape embedded quotes.
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => toCsvValue(row[h])).join(','));
  }
  return lines.join('\r\n');
}

export async function exportOrders(req, res) {
  try {
    const { tenantId } = req.params;
    const { status, from, to } = req.query;
    const filter = { tenantId, ...(status ? { status } : {}) };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(CSV_EXPORT_ROW_CAP).lean();

    const headers = [
      'shortId', 'createdAt', 'customerName', 'customerPhone', 'item', 'quantity',
      'totalPrice', 'promoCode', 'discountAmount', 'status', 'paymentMethod',
      'paymentStatus', 'notes',
    ];
    const rows = orders.map(o => ({
      shortId:        o.shortId,
      createdAt:      o.createdAt?.toISOString?.() || o.createdAt,
      customerName:   o.customerName,
      customerPhone:  o.customerPhone,
      item:           o.item,
      quantity:       o.quantity,
      totalPrice:     o.totalPrice,
      promoCode:      o.promoCode,
      discountAmount: o.discountAmount,
      status:         o.status,
      paymentMethod:  o.paymentMethod,
      paymentStatus:  o.paymentStatus,
      notes:          o.notes,
    }));

    const csv = rowsToCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${tenantId}-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) { logger.error('[Dashboard] exportOrders failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

export async function exportBookings(req, res) {
  try {
    const { tenantId } = req.params;
    const { status, from, to } = req.query;
    const filter = { tenantId, ...(status ? { status } : {}) };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const bookings = await Booking.find(filter).sort({ createdAt: -1 }).limit(CSV_EXPORT_ROW_CAP).lean();

    const headers = [
      'shortId', 'createdAt', 'customerName', 'customerPhone', 'date', 'time',
      'service', 'staff', 'partySize', 'bookingType', 'status', 'notes',
    ];
    const rows = bookings.map(b => ({
      shortId:       b.shortId,
      createdAt:     b.createdAt?.toISOString?.() || b.createdAt,
      customerName:  b.customerName,
      customerPhone: b.customerPhone,
      date:          b.date,
      time:          b.time,
      service:       b.service,
      staff:         b.staff,
      partySize:     b.partySize,
      bookingType:   b.bookingType,
      status:        b.status,
      notes:         b.notes,
    }));

    const csv = rowsToCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookings-${tenantId}-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) { logger.error('[Dashboard] exportBookings failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

// ── Business profile completeness [PROFILE-COMPLETE-1] ────────────────────────
// A tenant landing on an empty dashboard has no signal about what's left to
// configure before their bot feels "finished." This computes a simple
// checklist against fields that already exist on BusinessConfig/Tenant —
// no schema changes, purely derived, read-only.
//
// [NO-SELFSERVE-1] Deliberately excludes WhatsApp connection from this
// checklist. Every item here is something the tenant can genuinely configure
// themselves through the dashboard (name, hours, payment, menu, FAQ, welcome
// message). WhatsApp connection is provisioned only by the platform admin —
// see getOnboardingStatus() below, which reports it separately with
// "contact your admin" messaging rather than mixing it into a checklist that
// otherwise implies "things you can go do right now."
function computeProfileCompleteness(business, tenant) {
  const checks = [
    { key: 'name',        label: 'Business name set',        done: !!business?.name && business.name !== 'Our Business' },
    { key: 'description',  label: 'Business description added', done: !!business?.description?.trim() },
    { key: 'address',      label: 'Address added',              done: !!business?.address?.trim() },
    { key: 'hours',        label: 'Business hours configured',  done: !!business?.hours?.enabled },
    { key: 'payment',      label: 'Payment method added',       done: !!(business?.payment?.enabled && (business?.payment?.channels || []).length) },
    { key: 'menu',         label: 'At least one menu item added', done: (business?.menuItems || []).length > 0 },
    { key: 'faq',          label: 'At least one FAQ added',     done: (business?.faq || []).length > 0 },
    { key: 'welcome',      label: 'Custom welcome message set', done: !!business?.customMessages?.welcomeMessage?.trim() },
  ];
  const doneCount = checks.filter(c => c.done).length;
  return {
    percent: Math.round((doneCount / checks.length) * 100),
    completed: doneCount,
    total: checks.length,
    checklist: checks,
  };
}

export async function getProfileCompleteness(req, res) {
  try {
    const { tenantId } = req.params;
    const [business, tenant] = await Promise.all([
      BusinessConfig.findOne({ tenantId })
        .select('name description address hours payment menuItems faq customMessages').lean(),
      Tenant.findById(tenantId).select('whatsapp.connected').lean(),
    ]);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    res.json(computeProfileCompleteness(business, tenant));
  } catch (err) { logger.error('[Dashboard] getProfileCompleteness failed', { err: err.message }); res.status(500).json({ error: err.message }); }
}

// ── Onboarding status [ONBOARDING-STATUS-1] ───────────────────────────────────
// Purpose-built for the screen a tenant's user sees right after their first
// login — combines the self-service checklist above with the WhatsApp
// connection state, kept as two clearly separate sections on purpose.
//
// [NO-SELFSERVE-1] There is no self-serve tenant signup or self-serve WhatsApp
// connect flow in this system, by design: only the platform admin creates a
// Tenant + BusinessConfig (tenantController.createTenant) and only the
// platform admin provisions real WhatsApp credentials
// (whatsappOnboardingController.saveTenantWhatsAppCredentials /
// testTenantWhatsAppConnection). A tenant's user can submit a connection
// REQUEST (POST /api/whatsapp/request) for the admin to act on, but cannot
// connect anything themselves. This endpoint's wording reflects that
// deliberately: it never tells the tenant to "connect" or "complete setup" —
// only to submit a request or contact their admin.
export async function getOnboardingStatus(req, res) {
  try {
    const { tenantId } = req.params;
    const [business, tenant, connectionRequest] = await Promise.all([
      BusinessConfig.findOne({ tenantId })
        .select('name description address hours payment menuItems faq customMessages').lean(),
      Tenant.findById(tenantId).select('status whatsapp.connected whatsapp.connectedAt').lean(),
      WhatsAppConnectionRequest.findOne({ tenantId }).sort({ createdAt: -1 }).select('status createdAt').lean(),
    ]);
    if (!business || !tenant) return res.status(404).json({ error: 'Business not found' });

    const connected = !!tenant.whatsapp?.connected;
    let whatsappMessage;
    if (connected) {
      whatsappMessage = 'Your WhatsApp number is connected and your bot is live.';
    } else if (connectionRequest && !['rejected'].includes(connectionRequest.status)) {
      whatsappMessage = `Your WhatsApp connection request is ${connectionRequest.status} — `
        + `your account admin is setting this up for you.`;
    } else if (connectionRequest?.status === 'rejected') {
      whatsappMessage = 'Your previous WhatsApp connection request was not approved. '
        + 'Contact your account admin to follow up.';
    } else {
      whatsappMessage = 'Your WhatsApp number is not connected yet. '
        + 'Submit a connection request (or contact your account admin directly) and they will set it up for you.';
    }

    res.json({
      tenantStatus: tenant.status,
      whatsapp: {
        connected,
        connectedAt: tenant.whatsapp?.connectedAt || null,
        connectionRequestStatus: connectionRequest?.status || null,
        message: whatsappMessage,
      },
      // Things the tenant genuinely can do themselves, right now, in this dashboard.
      businessProfile: computeProfileCompleteness(business, tenant),
      // Things that always route through the admin — never presented as a
      // self-service action.
      adminContact: {
        message: 'For WhatsApp connection, raising your plan limits (menu items, staff logins, '
          + 'messages/month), or anything account-level, contact your account admin directly — '
          + 'they handle setup and changes like this for you.',
      },
    });
  } catch (err) {
    logger.error('[Dashboard] getOnboardingStatus failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}
