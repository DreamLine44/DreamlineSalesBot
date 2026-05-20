/**
 * routes/adminRoutes.js
 *
 * [FIX] All handlers now have try/catch — previously an unhandled DB error
 *       would crash the response with an uncaught exception.
 * [FIX] All handlers enforce tenantId ownership: non-superadmins can only
 *       access sessions/orders/bookings belonging to their own tenantId.
 */
import { Router } from 'express';
import Order   from '../models/Order.js';
import Booking from '../models/Booking.js';
import Session from '../models/Session.js';
import { updateSession } from '../core/sessions/sessionService.js';

const r = Router();

/** Reject non-superadmins accessing another tenant's data */
function assertTenant(req, res, tenantId) {
  if (req.isSuperAdmin) return true;
  if (!req.tenantId || req.tenantId !== tenantId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// Manual human mode toggle
r.patch('/sessions/:tenantId/:phone/human', async (req, res) => {
  const { tenantId, phone } = req.params;
  if (!assertTenant(req, res, tenantId)) return;
  try {
    const { humanMode } = req.body;
    await updateSession(phone, tenantId, { humanMode: Boolean(humanMode) });
    res.json({ ok: true, humanMode: Boolean(humanMode) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Order status update
r.patch('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const filter = { _id: req.params.id };
    if (!req.isSuperAdmin) filter.tenantId = req.tenantId;
    const order = await Order.findOneAndUpdate(filter, { $set: { status } }, { new: true });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Booking status update
r.patch('/bookings/:id/status', async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const filter = { _id: req.params.id };
    if (!req.isSuperAdmin) filter.tenantId = req.tenantId;
    const booking = await Booking.findOneAndUpdate(
      filter, { $set: { status, adminNote } }, { new: true }
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active sessions list
r.get('/sessions/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  if (!assertTenant(req, res, tenantId)) return;
  try {
    const sessions = await Session.find({ tenantId })
      .sort({ lastSeen: -1 }).limit(100)
      .select('customerPhone customerName humanMode currentFlow step lastSeen').lean();
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default r;
