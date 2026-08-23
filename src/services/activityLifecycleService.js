/**
 * activityLifecycleService.js
 *
 * Shared rules for how long orders/bookings stay "active", auto-expiry,
 * and customer-initiated cancellation (by reference or bulk).
 */

import Order from '../models/Order.js';
import Booking from '../models/Booking.js';
import logger from '../config/logger.js';
import { extractShortId, getOrderByShortId } from './activityLookupService.js';
import { getBookingByShortId } from './bookingService.js';
import { buildOptionsReply } from '../core/shared/uiOptionsHelper.js';
import { getModeConfig } from '../config/modes.js';
import { updateSession } from '../core/sessions/sessionService.js';

export const ACTIVITY_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long after delivery we still show "your order was delivered" context. */
export const DELIVERED_CONTEXT_WINDOW_MS = 2 * 60 * 60 * 1000;

export function activityActiveCutoff() {
  return new Date(Date.now() - ACTIVITY_ACTIVE_WINDOW_MS);
}

export const TERMINAL_ORDER_STATUSES = ['cancelled', 'completed', 'delivered', 'rejected'];

const IN_PROGRESS_ORDER_STATUSES = [
  'pending',
  'payment_pending_verification',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
];

/**
 * Mongo filter for orders that should intercept the customer as "active".
 * Non-terminal orders age out after 24h except admin-rejected payments (unbounded).
 */
export function buildActiveOrderFilter(customerPhone, tenantId) {
  const cutoff24h = activityActiveCutoff();
  return {
    customerPhone,
    tenantId,
    $or: [
      { status: 'pending', createdAt: { $gte: cutoff24h } },
      {
        status: { $in: ['payment_pending_verification', 'confirmed', 'preparing', 'ready', 'out_for_delivery'] },
        createdAt: { $gte: cutoff24h },
      },
      {
        status: 'delivered',
        updatedAt: { $gte: new Date(Date.now() - DELIVERED_CONTEXT_WINDOW_MS) },
        createdAt: { $gte: cutoff24h },
      },
      { paymentStatus: 'rejected', createdAt: { $gte: cutoff24h } },
      { paymentStatus: { $in: ['proof_received', 'payment_pending_verification'] }, createdAt: { $gte: cutoff24h } },
      { status: 'pending', paymentStatus: 'unpaid', paymentReviewedAt: { $ne: null } },
    ],
  };
}

/** Mongo filter for customer-initiated cancellation (matches visible active activities). */
export function buildCustomerCancellableOrderFilter(customerPhone, tenantId) {
  const cutoff24h = activityActiveCutoff();
  return {
    customerPhone,
    tenantId,
    status: { $nin: TERMINAL_ORDER_STATUSES },
    $or: [
      { status: 'pending', paymentStatus: 'unpaid', paymentReviewedAt: { $ne: null } },
      {
        status: { $in: IN_PROGRESS_ORDER_STATUSES },
        createdAt: { $gte: cutoff24h },
      },
      {
        paymentStatus: { $in: ['proof_received', 'payment_pending_verification', 'rejected'] },
        createdAt: { $gte: cutoff24h },
      },
    ],
  };
}

export function buildActiveBookingFilter(customerPhone, tenantId) {
  return {
    customerPhone,
    tenantId,
    status: { $in: ['pending', 'confirmed'] },
    createdAt: { $gte: activityActiveCutoff() },
  };
}

/** Orders awaiting admin payment action that should lock new flows. */
export function buildPendingOrderLockFilter(customerPhone, tenantId) {
  const cutoff = activityActiveCutoff();
  return {
    customerPhone,
    tenantId,
    paymentStatus: { $in: ['proof_received', 'unpaid', 'self_confirmed'] },
    status:        { $nin: ['cancelled', 'confirmed', 'completed'] },
    $or: [
      { createdAt: { $gte: cutoff } },
      { status: 'pending', paymentStatus: 'unpaid', paymentReviewedAt: { $ne: null } },
    ],
  };
}

export async function hasVisibleActiveOrder(customerPhone, tenantId) {
  return Order.exists(buildActiveOrderFilter(customerPhone, tenantId)).catch(() => false);
}

export async function findVisibleActiveOrder(customerPhone, tenantId, { select = null } = {}) {
  let query = Order.findOne(buildActiveOrderFilter(customerPhone, tenantId)).sort({ createdAt: -1 });
  if (select) query = query.select(select);
  return query.lean().catch(() => null);
}

/**
 * Mark stale in-progress activities as cancelled so they stop resurfacing.
 * Admin-rejected payment orders are left alone — the customer still needs to retry or cancel.
 */
export async function expireStaleActivities(customerPhone, tenantId) {
  const cutoff = activityActiveCutoff();
  try {
    await Order.updateMany(
      {
        customerPhone,
        tenantId,
        createdAt: { $lt: cutoff },
        status: 'pending',
        $or: [{ paymentReviewedAt: null }, { paymentReviewedAt: { $exists: false } }],
      },
      {
        $set: {
          status:        'cancelled',
          paymentStatus: 'cancelled',
          cancelledBy:   'system',
          cancelledAt:   new Date(),
        },
      },
    );

    await Order.updateMany(
      {
        customerPhone,
        tenantId,
        createdAt: { $lt: cutoff },
        status: { $in: ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'payment_pending_verification'] },
      },
      {
        $set: {
          status:        'cancelled',
          paymentStatus: 'cancelled',
          cancelledBy:   'system',
          cancelledAt:   new Date(),
        },
      },
    );

    await Booking.updateMany(
      {
        customerPhone,
        tenantId,
        createdAt: { $lt: cutoff },
        status: { $in: ['pending', 'confirmed'] },
      },
      {
        $set: {
          status:      'cancelled',
          cancelledBy: 'system',
          cancelledAt: new Date(),
        },
      },
    );
  } catch (err) {
    logger.warn('[ActivityLifecycle] expireStaleActivities failed (non-fatal)', {
      customerPhone, tenantId, err: err.message,
    });
  }
}

export async function cancelAllActiveForCustomer({ customerPhone, tenantId, business }) {
  const orderFilter = buildCustomerCancellableOrderFilter(customerPhone, tenantId);
  const bookingFilter = buildActiveBookingFilter(customerPhone, tenantId);
  const cancelSet = {
    status:        'cancelled',
    paymentStatus: 'cancelled',
    cancelledBy:   'customer',
    cancelledAt:   new Date(),
  };

  const [orderResult, bookingResult] = await Promise.all([
    Order.updateMany(orderFilter, { $set: cancelSet }).catch(() => ({ modifiedCount: 0 })),
    Booking.updateMany(bookingFilter, {
      $set: {
        status:          'cancelled',
        cancelledBy:     'customer',
        cancelledAt:     new Date(),
        adminDeclinedAt: new Date(),
        adminNote:       'Cancelled by customer',
      },
    }).catch(() => ({ modifiedCount: 0 })),
  ]);

  const orderCount = orderResult?.modifiedCount || 0;
  const bookingCount = bookingResult?.modifiedCount || 0;
  const total = orderCount + bookingCount;

  await updateSession(customerPhone, tenantId, {
    currentFlow: null, step: null, data: {}, postFlowAck: null,
  }).catch(() => {});

  const cfg = getModeConfig(business);
  return buildOptionsReply(
    cfg,
    total > 0
      ? `✅ Done — *${total}* active activit${total !== 1 ? 'ies' : 'y'} cancelled. Sorry to see you go! 🙏`
      : `ℹ️ No active orders or bookings found to cancel.`,
  );
}

export async function cancelMostRecentActiveOrder({ customerPhone, tenantId }) {
  return Order.findOneAndUpdate(
    buildCustomerCancellableOrderFilter(customerPhone, tenantId),
    {
      $set: {
        status:        'cancelled',
        paymentStatus: 'cancelled',
        cancelledBy:   'customer',
        cancelledAt:   new Date(),
      },
    },
    { sort: { createdAt: -1 } },
  ).select('shortId status paymentStatus').lean().catch(() => null);
}

/**
 * Customer cancel by reference — e.g. "cancel #F93217".
 * Returns a WhatsApp payload or null when the message isn't a ref cancel.
 */
export async function tryCustomerCancelByReference({ message, customerPhone, tenantId, business, tenant }) {
  const raw = String(message || '').trim();
  if (!raw || !/\bcancel\b/i.test(raw)) return null;

  const ref = extractShortId(raw);
  if (!ref) return null;

  const cfg = getModeConfig(business);

  const order = await getOrderByShortId(ref, tenantId);
  if (order) {
    if (order.customerPhone && order.customerPhone !== customerPhone) {
      return {
        type: 'text',
        body: `⚠️ Order *#${ref}* belongs to a different number. Please contact the business if you need help.`,
      };
    }
    if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
      return {
        type: 'text',
        body: `ℹ️ Order *#${ref}* is already *${order.status}* and cannot be cancelled.`,
      };
    }

    const cutoff = activityActiveCutoff();
    const isRejectedAwaitingAction = order.status === 'pending'
      && order.paymentStatus === 'unpaid'
      && order.paymentReviewedAt;
    const isWithinWindow = order.createdAt && new Date(order.createdAt) >= cutoff;
    if (!isRejectedAwaitingAction && !isWithinWindow) {
      return {
        type: 'text',
        body: `ℹ️ Order *#${ref}* is older than 24 hours and has expired. It is no longer active.`,
      };
    }

    const updated = await Order.findOneAndUpdate(
      { shortId: ref, tenantId, status: { $nin: TERMINAL_ORDER_STATUSES } },
      {
        $set: {
          status:        'cancelled',
          paymentStatus: 'cancelled',
          cancelledBy:   'customer',
          cancelledAt:   new Date(),
        },
      },
      { new: false },
    ).select('shortId item').lean();

    if (!updated) {
      return { type: 'text', body: `⚠️ Order *#${ref}* could not be cancelled. Please try again or contact support.` };
    }

    await updateSession(customerPhone, tenantId, {
      currentFlow: null, step: null, postFlowAck: 'ORDER_REJECTED',
      postFlowData: { item: updated.item, shortId: updated.shortId || ref },
    }).catch(() => {});

    return buildOptionsReply(cfg, `✅ Order *#${ref}* has been cancelled.`, [
      { id: 'ORDER', title: '🛒 Place New Order' },
      { id: 'QUESTION', title: '❓ Ask a Question' },
    ]);
  }

  const booking = await getBookingByShortId(ref, tenantId);
  if (booking) {
    if (booking.customerPhone && booking.customerPhone !== customerPhone) {
      return {
        type: 'text',
        body: `⚠️ Booking *#${ref}* belongs to a different number. Please contact the business if you need help.`,
      };
    }
    if (booking.status === 'cancelled') {
      return { type: 'text', body: `ℹ️ Booking *#${ref}* is already cancelled.` };
    }
    if (booking.status === 'completed') {
      return { type: 'text', body: `ℹ️ Booking *#${ref}* is already completed and cannot be cancelled.` };
    }

    const cutoff = activityActiveCutoff();
    if (booking.createdAt && new Date(booking.createdAt) < cutoff) {
      return {
        type: 'text',
        body: `ℹ️ Booking *#${ref}* is older than 24 hours and has expired. It is no longer active.`,
      };
    }

    const updated = await Booking.findOneAndUpdate(
      { shortId: ref, tenantId, status: { $ne: 'cancelled' } },
      {
        $set: {
          status:          'cancelled',
          cancelledBy:     'customer',
          cancelledAt:     new Date(),
          adminDeclinedAt: new Date(),
          adminNote:       'Cancelled by customer',
        },
      },
      { new: false },
    ).select('shortId service date time').lean();

    if (!updated) {
      return { type: 'text', body: `⚠️ Booking *#${ref}* could not be cancelled. Please try again or contact support.` };
    }

    await updateSession(customerPhone, tenantId, {
      postFlowAck: 'BOOKING_DECLINED',
      postFlowData: { service: updated.service, date: updated.date, staff: updated.staff || null },
    }).catch(() => {});

    return buildOptionsReply(cfg, `✅ Booking *#${ref}* has been cancelled.`, [
      { id: 'BOOK', title: '📅 Book Again' },
      { id: 'QUESTION', title: '❓ Ask a Question' },
    ]);
  }

  return {
    type: 'text',
    body: `⚠️ No order or booking found with reference *#${ref}*. Please check the number and try again.`,
  };
}
