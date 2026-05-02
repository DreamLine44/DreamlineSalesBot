/**
 * routes/businessRoutes.js
 *
 * Mounted in app.js as:
 *   app.use('/business', rateLimiter, requireApiKey, businessRoutes)
 *
 * NOTE: Failed-message replay endpoints are served by adminMessageRoutes.js,
 *   mounted at /admin/messages — NOT here. This file must NOT register
 *   /failed-messages routes, as that would incorrectly expose them under /business.
 *
 * Route → full URL mapping:
 *   POST   /              → POST   /business
 *   GET    /              → GET    /business
 *   PUT    /              → PUT    /business
 *   GET    /analytics     → GET    /business/analytics
 *   POST   /human-mode    → POST   /business/human-mode
 *   POST   /apply-mode    → POST   /business/apply-mode
 *   GET    /setup-checklist → GET  /business/setup-checklist
 *   GET    /default-config  → GET  /business/default-config
 *   GET    /orders/export → GET    /business/orders/export
 *   GET    /orders/pending-payment → GET /business/orders/pending-payment
 *   GET    /orders        → GET    /business/orders
 *   GET    /orders/:id    → GET    /business/orders/:id
 *   POST   /orders/:id/confirm-payment → POST /business/orders/:id/confirm-payment
 *   POST   /orders/:id/reject-payment  → POST /business/orders/:id/reject-payment
 *   GET    /bookings/export → GET  /business/bookings/export
 *   GET    /bookings      → GET    /business/bookings
 *   GET    /bookings/:id  → GET    /business/bookings/:id
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

export default router;
