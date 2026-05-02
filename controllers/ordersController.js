/**
 * controllers/ordersController.js
 *
 * FIX [2]: Order/Booking retrieval API — complete implementation.
 *
 * All endpoints are scoped to req.tenant._id (set by authMiddleware),
 * so a business owner can only ever see their own records.
 *
 * Converted to ESM (project uses "type": "module").
 * NOTE: json2csv must be installed: npm i json2csv
 */

import Order from '../models/Order.js';
import Booking from '../models/Booking.js';
import FailedMessage from '../models/FailedMessage.js';
import { sendMessage, dispatch } from '../services/messageService.js';
import {
  buildPaymentConfirmedUI,
  buildPaymentRejectedUI,
} from '../utils/messageBuilders.js';
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
    const msg = err.message === 'Order not found or already processed'
      ? err.message : 'Failed to confirm payment';
    const is404 = typeof err.message === 'string' && err.message.includes('not found');
    res.status(is404 ? 404 : 500).json({ success: false, error: msg });
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
    const msg = err.message === 'Order not found'
      ? err.message : 'Failed to reject payment';
    const is404 = typeof err.message === 'string' && err.message.includes('not found');
    res.status(is404 ? 404 : 500).json({ success: false, error: msg });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// FAILED MESSAGES (admin replay — Fix [9])
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

    try {
      await sendMessage(msg.to, msg.text, tenant);
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
