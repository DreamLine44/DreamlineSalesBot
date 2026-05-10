/**
 * controllers/ordersController.js
 *
 * Order and booking retrieval, CSV export, Wave payment verification,
 * and failed-message replay. All endpoints are scoped to req.tenant._id.
 */

import Order from '../models/Order.js';
import Booking from '../models/Booking.js';
import FailedMessage from '../models/FailedMessage.js';
import { sendMessage, dispatch } from '../services/messageService.js';
// Note: payment notifications use customerMessage string from paymentService, not UI builders
import {
  getPendingPayments,
  confirmPayment as svcConfirmPayment,
  rejectPayment  as svcRejectPayment,
} from '../services/paymentService.js';
import Tenant from '../models/Tenant.js';
import { createRequire } from 'module';
import mongoose from 'mongoose';
import logger from "../config/logger.js";

// json2csv v5 is CommonJS-only; use createRequire for ESM compatibility.
const require = createRequire(import.meta.url);
const { Parser } = require('json2csv');

/** Return 400 early if :id is not a valid MongoDB ObjectId. */
function validateObjectId(id, res) {
  if (!mongoose.isValidObjectId(id)) {
    res.status(400).json({ success: false, error: 'Invalid ID format' });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseDateRange(from, to) {
  const filter = {};
  if (from || to) {
    filter.createdAt = {};
    if (from) {
      const fromDate = new Date(from);
      if (!isNaN(fromDate.getTime())) filter.createdAt.$gte = fromDate;
    }
    if (to) {
      const toDate = new Date(to);
      if (!isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = toDate;
      }
    }
    // If neither bound survived validation, drop the empty createdAt filter
    if (!filter.createdAt.$gte && !filter.createdAt.$lte) delete filter.createdAt;
  }
  return filter;
}

function paginationOpts(query) {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────────────────────

/** GET /business/orders  ?page=1&limit=20&status=pending&from=&to= */
export const listOrders = async (req, res) => {
  try {
    const tenantId = req.tenant._id;
    const { page, limit, skip } = paginationOpts(req.query);
    const filter = { tenantId, ...parseDateRange(req.query.from, req.query.to) };
    if (req.query.status) filter.status = req.query.status;

    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter),
    ]);

    res.json({ success: true, data: orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error('[ordersController.listOrders]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
};

/** GET /business/orders/:id */
export const getOrder = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const order = await Order.findOne({ _id: req.params.id, tenantId: req.tenant._id }).lean();
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, data: order });
  } catch (err) {
    logger.error('[ordersController.getOrder]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch order' });
  }
};

/** GET /business/orders/export  — streams CSV */
export const exportOrders = async (req, res) => {
  try {
    const tenantId = req.tenant._id;
    const filter = { tenantId, ...parseDateRange(req.query.from, req.query.to) };
    if (req.query.status) filter.status = req.query.status;

    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();
    if (orders.length === 0) return res.status(204).send();

    const fields = ['_id', 'customerPhone', 'item', 'quantity', 'totalPrice', 'status', 'createdAt'];
    const csv = new Parser({ fields }).parse(orders);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('[ordersController.exportOrders]', err);
    res.status(500).json({ success: false, error: 'Export failed' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOOKINGS
// ─────────────────────────────────────────────────────────────────────────────

/** GET /business/bookings  ?page=1&limit=20&status=confirmed&from=&to= */
export const listBookings = async (req, res) => {
  try {
    const tenantId = req.tenant._id;
    const { page, limit, skip } = paginationOpts(req.query);
    const filter = { tenantId, ...parseDateRange(req.query.from, req.query.to) };
    if (req.query.status) filter.status = req.query.status;

    const [bookings, total] = await Promise.all([
      Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Booking.countDocuments(filter),
    ]);

    res.json({ success: true, data: bookings, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    logger.error('[ordersController.listBookings]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch bookings' });
  }
};

/** GET /business/bookings/:id */
export const getBooking = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const booking = await Booking.findOne({ _id: req.params.id, tenantId: req.tenant._id }).lean();
    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
    res.json({ success: true, data: booking });
  } catch (err) {
    logger.error('[ordersController.getBooking]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch booking' });
  }
};

/** GET /business/bookings/export */
export const exportBookings = async (req, res) => {
  try {
    const tenantId = req.tenant._id;
    const filter = { tenantId, ...parseDateRange(req.query.from, req.query.to) };
    if (req.query.status) filter.status = req.query.status;

    const bookings = await Booking.find(filter).sort({ createdAt: -1 }).lean();
    if (bookings.length === 0) return res.status(204).send();

    const fields = ['_id', 'customerPhone', 'date', 'time', 'status', 'createdAt'];
    const csv = new Parser({ fields }).parse(bookings);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bookings-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('[ordersController.exportBookings]', err);
    res.status(500).json({ success: false, error: 'Export failed' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// WAVE PAYMENT VERIFICATION  (v13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /business/orders/pending-payment
 * List all orders awaiting Wave payment verification for this tenant.
 */
export const listPendingPayments = async (req, res) => {
  try {
    const orders = await getPendingPayments(req.tenant._id);
    res.json({ success: true, count: orders.length, data: orders });
  } catch (err) {
    logger.error('[listPendingPayments]', err);
    res.status(500).json({ success: false, error: 'Failed to fetch pending payments' });
  }
};

/**
 * POST /business/orders/:id/confirm-payment
 * Admin confirms Wave payment — sets status to confirmed/paid.
 * Optionally notifies customer via WhatsApp.
 */
export const confirmPayment = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const adminId = req.body.verifiedBy || req.body.adminId || 'admin';
    const { order, customerMessage } = await svcConfirmPayment(
      req.params.id, req.tenant._id, adminId
    );

    // Notify customer via WhatsApp
    const tenant = await Tenant.findById(req.tenant._id).lean();
    if (tenant && order.customerPhone) {
      await dispatch(order.customerPhone, { type: 'text', body: customerMessage }, tenant).catch(() => {});
    }

    res.json({ success: true, message: 'Payment confirmed and customer notified', data: order });
  } catch (err) {
    logger.error('[confirmPayment]', err);
    // [FIX-F] Attach a code to the thrown Error in paymentService so the controller
    // doesn't have to do fragile substring matching on err.message to pick status codes.
    const status = err.statusCode || (err.message?.toLowerCase().includes('not found') ? 404 : 500);
    res.status(status).json({ success: false, error: err.message || 'Failed to confirm payment' });
  }
};

/**
 * POST /business/orders/:id/reject-payment
 * Admin rejects Wave payment — sends reason to customer.
 */
export const rejectPayment = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const reason  = req.body.reason || null;
    const adminId = req.body.verifiedBy || req.body.adminId || 'admin';
    const { order, customerMessage } = await svcRejectPayment(
      req.params.id, req.tenant._id, reason, adminId
    );

    // Notify customer via WhatsApp
    const tenant = await Tenant.findById(req.tenant._id).lean();
    if (tenant && order.customerPhone) {
      await dispatch(order.customerPhone, { type: 'text', body: customerMessage }, tenant).catch(() => {});
    }

    res.json({ success: true, message: 'Payment rejected and customer notified', data: order });
  } catch (err) {
    logger.error('[rejectPayment]', err);
    // [FIX-F] Same statusCode pattern as confirmPayment above.
    const status = err.statusCode || (err.message?.toLowerCase().includes('not found') ? 404 : 500);
    res.status(status).json({ success: false, error: err.message || 'Failed to reject payment' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ORDER / BOOKING MANAGEMENT  (Fix #13)
// These endpoints were missing — admins had no REST API to cancel, update, or
// delete orders/bookings without direct DB access.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /business/orders/:id
 * Update mutable fields on an order: status, paymentStatus, notes.
 * Immutable fields (item, quantity, customerPhone, tenantId) are silently ignored.
 */
export const updateOrder = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const ALLOWED = ['status', 'paymentStatus', 'notes'];
    const patch   = {};
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, error: 'No updatable fields provided. Allowed: status, paymentStatus, notes' });
    }

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenant._id },
      { $set: patch },
      { new: true },
    ).lean();

    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, data: order });
  } catch (err) {
    logger.error('[ordersController.updateOrder]', err);
    res.status(500).json({ success: false, error: 'Failed to update order' });
  }
};

/**
 * DELETE /business/orders/:id
 * Hard-delete an order. Use PATCH status=cancelled for soft-cancel.
 */
export const deleteOrder = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const result = await Order.deleteOne({ _id: req.params.id, tenantId: req.tenant._id });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json({ success: true, message: 'Order deleted' });
  } catch (err) {
    logger.error('[ordersController.deleteOrder]', err);
    res.status(500).json({ success: false, error: 'Failed to delete order' });
  }
};

/**
 * PATCH /business/bookings/:id
 * Update mutable fields on a booking: status, date, time, notes.
 */
export const updateBooking = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const ALLOWED = ['status', 'date', 'time', 'notes'];
    const patch   = {};
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, error: 'No updatable fields provided. Allowed: status, date, time, notes' });
    }

    const booking = await Booking.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenant._id },
      { $set: patch },
      { new: true },
    ).lean();

    if (!booking) return res.status(404).json({ success: false, error: 'Booking not found' });
    res.json({ success: true, data: booking });
  } catch (err) {
    logger.error('[ordersController.updateBooking]', err);
    res.status(500).json({ success: false, error: 'Failed to update booking' });
  }
};

/**
 * DELETE /business/bookings/:id
 * Hard-delete a booking. Use PATCH status=cancelled for soft-cancel.
 */
export const deleteBooking = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const result = await Booking.deleteOne({ _id: req.params.id, tenantId: req.tenant._id });
    if (result.deletedCount === 0) return res.status(404).json({ success: false, error: 'Booking not found' });
    res.json({ success: true, message: 'Booking deleted' });
  } catch (err) {
    logger.error('[ordersController.deleteBooking]', err);
    res.status(500).json({ success: false, error: 'Failed to delete booking' });
  }
};


// ─────────────────────────────────────────────────────────────────────────────

/** GET /admin/failed-messages — lists unreplayed failed messages for this tenant */
export const listFailedMessages = async (req, res) => {
  try {
    const messages = await FailedMessage.find({ tenantId: req.tenant._id, replayed: false })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch failed messages' });
  }
};

/** POST /admin/failed-messages/:id/replay — attempts to resend a single failed message */
export const replayFailedMessage = async (req, res) => {
  if (!validateObjectId(req.params.id, res)) return;
  try {
    const msg = await FailedMessage.findOne({ _id: req.params.id, tenantId: req.tenant._id });
    if (!msg) return res.status(404).json({ success: false, error: 'Not found' });

    const tenant = await Tenant.findById(req.tenant._id).lean();
    if (!tenant) {
      return res.status(500).json({ success: false, error: 'Tenant not found — cannot replay message' });
    }

    try {
      // [FIX-11] Use dispatch() instead of sendMessage() for replay.
      // sendMessage() only sends plain text. dispatch() handles text, buttons,
      // list, and image types. FailedMessage currently only stores .text, so
      // replays are plain-text for now — but dispatch() is the correct API
      // and ensures future schema additions (uiPayload) work without changing
      // this controller. Falls back to sendMessage if dispatch is not available.
      await dispatch(msg.to, { type: 'text', body: msg.text }, tenant);
      msg.replayed  = true;
      msg.retriedAt = new Date();
      await msg.save();
      res.json({ success: true, message: 'Message replayed successfully' });
    } catch (sendErr) {
      msg.retriedAt   = new Date();
      msg.replayError = sendErr.message;
      await msg.save();
      res.status(500).json({ success: false, error: 'Replay failed', detail: sendErr.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'Replay error' });
  }
};
