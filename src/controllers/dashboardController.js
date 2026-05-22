/**
 * controllers/dashboardController.js — WhatSalesAgent2
 * All functions wrapped in try/catch. Customers endpoint has pagination.
 */
import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Session        from '../models/Session.js';
import UserProfile    from '../models/UserProfile.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { getAnalyticsSummary } from '../core/analytics/analyticsService.js';

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
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── Orders ────────────────────────────────────────────────────────────────────
export async function getOrders(req, res) {
  try {
    const { tenantId } = req.params;
    const { status, limit = 50, page = 1 } = req.query;
    const filter = { tenantId, ...(status ? { status } : {}) };
    const skip   = (Number(page) - 1) * Number(limit);
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Order.countDocuments(filter),
    ]);
    res.json({ orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function updateOrderStatus(req, res) {
  try {
    const { tenantId, orderId } = req.params;
    const { status } = req.body;
    const order = await Order.findOneAndUpdate(
      { _id: orderId, tenantId }, { $set: { status } }, { new: true },
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────
export async function getBookings(req, res) {
  try {
    const { tenantId } = req.params;
    const { status, limit = 50, page = 1 } = req.query;
    const filter = { tenantId, ...(status ? { status } : {}) };
    const skip   = (Number(page) - 1) * Number(limit);
    const [bookings, total] = await Promise.all([
      Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Booking.countDocuments(filter),
    ]);
    res.json({ bookings, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function updateBookingStatus(req, res) {
  try {
    const { tenantId, bookingId } = req.params;
    const { status, adminNote } = req.body;
    const booking = await Booking.findOneAndUpdate(
      { _id: bookingId, tenantId },
      { $set: { status, ...(adminNote ? { adminNote } : {}) } },
      { new: true },
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── Analytics ─────────────────────────────────────────────────────────────────
export async function getAnalytics(req, res) {
  try {
    const { tenantId } = req.params;
    const { days = 30 } = req.query;
    const summary = await getAnalyticsSummary(tenantId, Number(days));
    res.json(summary);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── Conversations / Sessions ──────────────────────────────────────────────────
export async function getConversations(req, res) {
  try {
    const { tenantId } = req.params;
    const { limit = 30, page = 1 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [sessions, total] = await Promise.all([
      Session.find({ tenantId })
        .sort({ lastSeen: -1 }).skip(skip).limit(Number(limit))
        .select('customerPhone customerName lastSeen messageCount humanMode currentFlow step').lean(),
      Session.countDocuments({ tenantId }),
    ]);
    res.json({ conversations: sessions, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function setHumanMode(req, res) {
  try {
    const { tenantId, phone } = req.params;
    const { humanMode } = req.body;
    const { updateSession } = await import('../core/sessions/sessionService.js');
    const notified = humanMode ? false : undefined; // reset on takeover, clear on resume
    const update = { humanMode: Boolean(humanMode) };
    if (!humanMode) update.humanModeNotified = false; // dashboard resume resets flag too
    const session = await updateSession(phone, tenantId, update);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true, humanMode: session.humanMode });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── Customers ─────────────────────────────────────────────────────────────────
export async function getCustomers(req, res) {
  try {
    const { tenantId } = req.params;
    const { limit = 50, page = 1, search } = req.query;
    const skip   = (Number(page) - 1) * Number(limit);
    const filter = { tenantId };
    if (search) {
      filter.$or = [
        { phone: { $regex: search, $options: 'i' } },
        { 'lead.name': { $regex: search, $options: 'i' } },
        { 'lead.email': { $regex: search, $options: 'i' } },
      ];
    }
    const [profiles, total] = await Promise.all([
      UserProfile.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      UserProfile.countDocuments(filter),
    ]);
    res.json({ customers: profiles, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── Business settings ─────────────────────────────────────────────────────────
export async function getBusinessSettings(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId })
      .select('name description businessMode adminPhone menuItems services payment leadCapture faq customMessages hours settings')
      .lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ settings: biz });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

export async function updateBusinessSettings(req, res) {
  try {
    const { tenantId } = req.params;
    const allowed = ['name', 'description', 'adminPhone', 'menuItems', 'services',
                     'payment', 'leadCapture', 'faq', 'customMessages', 'hours', 'settings', 'businessMode'];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'No valid fields to update' });
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId }, { $set: update }, { new: true, runValidators: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ settings: biz });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
