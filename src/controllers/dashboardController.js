/**
 * controllers/dashboardController.js — WhatSalesAgent2
 */
import Order          from '../models/Order.js';
import Booking        from '../models/Booking.js';
import Session        from '../models/Session.js';
import UserProfile    from '../models/UserProfile.js';
import BusinessConfig from '../models/BusinessConfig.js';
import { getAnalyticsSummary } from '../core/analytics/analyticsService.js';
// ── Orders ────────────────────────────────────────────────────────────────────
export async function getOrders(req, res) {
  const { tenantId } = req.params;
  const { status, limit = 50, page = 1 } = req.query;
  const filter = { tenantId, ...(status ? { status } : {}) };
  const skip   = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Order.countDocuments(filter),
  ]);
  res.json({ orders, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
}

export async function updateOrderStatus(req, res) {
  const { tenantId, orderId } = req.params;
  const { status } = req.body;
  const order = await Order.findOneAndUpdate(
    { _id: orderId, tenantId }, { $set: { status } }, { new: true },
  );
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
}

// ── Bookings ──────────────────────────────────────────────────────────────────
export async function getBookings(req, res) {
  const { tenantId } = req.params;
  const { status, limit = 50, page = 1 } = req.query;
  const filter = { tenantId, ...(status ? { status } : {}) };
  const skip   = (Number(page) - 1) * Number(limit);
  const [bookings, total] = await Promise.all([
    Booking.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Booking.countDocuments(filter),
  ]);
  res.json({ bookings, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
}

export async function updateBookingStatus(req, res) {
  const { tenantId, bookingId } = req.params;
  const { status, adminNote } = req.body;
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, tenantId },
    { $set: { status, ...(adminNote ? { adminNote } : {}) } },
    { new: true },
  );
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  res.json({ booking });
}

// ── Analytics ─────────────────────────────────────────────────────────────────
export async function getAnalytics(req, res) {
  const { tenantId } = req.params;
  const { days = 30 } = req.query;
  const summary = await getAnalyticsSummary(tenantId, Number(days));
  res.json(summary);
}

// ── Conversations / Sessions ──────────────────────────────────────────────────
export async function getConversations(req, res) {
  const { tenantId } = req.params;
  const { limit = 30 } = req.query;
  const sessions = await Session.find({ tenantId })
    .sort({ lastSeen: -1 }).limit(Number(limit))
    .select('customerPhone customerName lastSeen messageCount humanMode currentFlow').lean();
  res.json({ conversations: sessions });
}

export async function setHumanMode(req, res) {
  const { tenantId, phone } = req.params;
  const { humanMode } = req.body;
  // [FIX] Session.customerPhone != Session.phone (composite key). Use sessionService
  // which builds the correct composite key instead of querying by customerPhone directly.
  const { updateSession } = await import('../core/sessions/sessionService.js');
  const session = await updateSession(phone, tenantId, { humanMode: Boolean(humanMode) });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true, humanMode: session.humanMode });
}

// ── Customers ─────────────────────────────────────────────────────────────────
export async function getCustomers(req, res) {
  const { tenantId } = req.params;
  const { limit = 50 } = req.query;
  const profiles = await UserProfile.find({ tenantId })
    .sort({ updatedAt: -1 }).limit(Number(limit)).lean();
  res.json({ customers: profiles });
}

// ── Business settings ─────────────────────────────────────────────────────────
export async function getDashboardOverview(req, res) {
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
}
