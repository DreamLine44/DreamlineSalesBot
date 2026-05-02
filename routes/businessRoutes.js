/**
 * routes/businessRoutes.js
 *
 * Mounted in app.js as:
 *   app.use('/business',        rateLimiter, requireApiKey, businessRoutes)
 *   app.use('/admin/messages',  rateLimiter, requireApiKey, businessRoutes)
 *
 * Route → full URL mapping:
 *   POST   /              → POST   /business
 *   GET    /              → GET    /business
 *   PUT    /              → PUT    /business
 *   GET    /analytics     → GET    /business/analytics
 *   POST   /human-mode    → POST   /business/human-mode
 *   GET    /orders/export → GET    /business/orders/export
 *   GET    /orders        → GET    /business/orders
 *   GET    /orders/:id    → GET    /business/orders/:id
 *   GET    /bookings/export → GET  /business/bookings/export
 *   GET    /bookings      → GET    /business/bookings
 *   GET    /bookings/:id  → GET    /business/bookings/:id
 *   GET    /failed-messages         → GET  /admin/messages/failed-messages
 *   POST   /failed-messages/:id/replay → POST /admin/messages/failed-messages/:id/replay
 */

import { Router } from 'express';
import {
  createBusiness,
  getBusiness,
  updateBusiness,
  getAnalytics,
  toggleHumanMode,
  applyMode,
  getSetupChecklist,
  getDefaultConfig,
} from '../controllers/businessController.js';
import {
  listOrders,
  getOrder,
  exportOrders,
  listBookings,
  getBooking,
  exportBookings,
  listFailedMessages,
  replayFailedMessage,
  listPendingPayments,
  confirmPayment,
  rejectPayment,
} from '../controllers/ordersController.js';

const router = Router();

// ── Business config ───────────────────────────────────────────────────────────
router.post('/',    createBusiness);
router.get('/',     getBusiness);
router.put('/',     updateBusiness);

// ── Analytics ─────────────────────────────────────────────────────────────────
// GET /business/analytics
router.get('/analytics', getAnalytics);

// ── Human mode toggle ─────────────────────────────────────────────────────────
// POST /business/human-mode  — body: { phone, active: bool }
router.post('/human-mode', toggleHumanMode);

// ── Mode preset (v3.0) ────────────────────────────────────────────────────────
// POST /business/apply-mode  — body: { mode: "RESTAURANT"|"SALON"|"RETAIL" }
// Applies a pre-configured mode bundle. No coding required.
router.post('/apply-mode', applyMode);

// ── Setup checklist (v3.0) ────────────────────────────────────────────────────
// GET /business/setup-checklist — returns setup completion status
router.get('/setup-checklist', getSetupChecklist);

// ── Default config (v3.0) ─────────────────────────────────────────────────────
// GET /business/default-config?mode=RESTAURANT — returns starter config template
router.get('/default-config', getDefaultConfig);

// ── Orders ────────────────────────────────────────────────────────────────────
// NOTE: static paths (/export, /pending-payment) MUST be before /:id
router.get('/orders/export',           exportOrders);
router.get('/orders/pending-payment',  listPendingPayments);
router.get('/orders',                  listOrders);
router.get('/orders/:id',              getOrder);
router.post('/orders/:id/confirm-payment', confirmPayment);
router.post('/orders/:id/reject-payment',  rejectPayment);

// ── Bookings ──────────────────────────────────────────────────────────────────
router.get('/bookings/export', exportBookings);
router.get('/bookings',        listBookings);
router.get('/bookings/:id',    getBooking);

// ── Failed messages (admin replay — Fix [9]) ──────────────────────────────────
// GET  /admin/failed-messages
// POST /admin/failed-messages/:id/replay
// These are mounted via the /admin prefix in app.js
router.get('/failed-messages',            listFailedMessages);
router.post('/failed-messages/:id/replay', replayFailedMessage);

export default router;
