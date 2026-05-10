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
 *   POST   /menu/upload-image → POST   /business/menu/upload-image (multipart/form-data, field: image)
 *   POST   /menu      → POST   /business/menu
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
import multer from 'multer';
import {
  createBusiness,
  getBusiness,
  updateBusiness,
  getAnalytics,
  toggleHumanMode,
  applyMode,
  getSetupChecklist,
  getDefaultConfig,
  updateMenu,
  updateHours,
  updatePayment,
  updateFaq,
  updateSettings,
  uploadMenuImage,
} from '../controllers/businessController.js';
import {
  listOrders,
  getOrder,
  exportOrders,
  updateOrder,
  deleteOrder,
  listBookings,
  getBooking,
  exportBookings,
  updateBooking,
  deleteBooking,
  listPendingPayments,
  confirmPayment,
  rejectPayment,
} from '../controllers/ordersController.js';

const router = Router();

// ── Image upload (multer — in-memory, 5 MB limit, images only) ────────────────
// Configured here so businessController stays dependency-free from multer.
// The file lands in req.file.buffer — we pipe it straight to Cloudinary.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are accepted.'));
  },
});

// ── Advanced config (granular section updates) ────────────────────────────────
// These patch a single section of the business config incrementally.
// Preferred over sending a full payload to POST /business when building a
// step-by-step frontend wizard.
//
//   POST /business/menu      → update menu items array
//   POST /business/hours     → update operating hours
//   POST /business/payment   → update payment details
//   POST /business/faq       → update FAQ entries
//   POST /business/settings  → update tone, nlp, botEnabled, customMessages
//
// NOTE: static section paths must be declared BEFORE /:id-style routes.
// CRITICAL: /menu/upload-image must come BEFORE /menu (POST) — Express matches
// routes in declaration order; if /menu matches first, upload-image is unreachable.
// Multer error handler: converts multer-specific errors (LIMIT_FILE_SIZE, wrong type)
// into clean 400 JSON responses instead of falling through to the generic 500 handler.
function multerErrorHandler(err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File too large. Maximum size is 5 MB.' });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message || 'File upload error.' });
  }
  next();
}

router.post('/menu/upload-image', upload.single('image'), multerErrorHandler, uploadMenuImage);
router.post('/menu',     updateMenu);
router.post('/hours',    updateHours);
router.post('/payment',  updatePayment);
router.post('/faq',      updateFaq);
router.post('/settings', updateSettings);

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
router.patch('/orders/:id',            updateOrder);
router.delete('/orders/:id',           deleteOrder);
router.post('/orders/:id/confirm-payment', confirmPayment);
router.post('/orders/:id/reject-payment',  rejectPayment);

// ── Bookings ──────────────────────────────────────────────────────────────────
router.get('/bookings/export', exportBookings);
router.get('/bookings',        listBookings);
router.get('/bookings/:id',    getBooking);
router.patch('/bookings/:id',  updateBooking);
router.delete('/bookings/:id', deleteBooking);

export default router;
