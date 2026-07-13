/**
 * routes/dashboardRoutes.js — WhatSalesAgent (Merged)
 *
 * [FIX-BUG13] getCustomerOrderHistory moved ABOVE /:orderId/status to prevent
 *             Express matching "customer" as an orderId param and returning 404.
 *             Route specificity rule: literal path segments must come before params.
 */
import { Router } from 'express';
import {
  getDashboardOverview,
  getOrders, updateOrderStatus, getCustomerOrderHistory, notifyOrderReady, exportOrders,
  getBookings, updateBookingStatus, exportBookings,
  getAnalytics,
  getAnalyticsTimeseriesHandler,
  getConversations, setHumanMode,
  getCustomers,
  getBusinessSettings, updateBusinessSettings,
  getMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getServices, addService, updateService, deleteService,
  getFaqs, addFaq, updateFaq, deleteFaq,
  getPromotions, addPromotion, updatePromotion, deletePromotion,
  getProfileCompleteness,
  getOnboardingStatus,
} from '../controllers/dashboardController.js';
import { uploadSingle } from '../middleware/uploadMiddleware.js';
import { uploadMenuItemImage, removeMenuItemImage } from '../controllers/menuImageController.js';
import { overviewLimiter } from '../middleware/rateLimiter.js';
// [AUDIT-FIX-ROLE-GATE-1] See note above requireEditor below.
import { requireRole } from '../middleware/authMiddleware.js';

const r = Router();

// [AUDIT-FIX-ROLE-GATE-1] models/AdminUser.js documents STAFF as "day-to-day
// access (orders, bookings, conversations) but cannot edit business
// settings/menu/payment config" and states plainly that role enforcement
// "is the source of truth, not a UI-only label." Before this fix, NOT ONE
// route in this file (or businessRoutes.js) actually called requireRole() —
// every write endpoint below was reachable by a STAFF-role Bearer session,
// identically to OWNER/MANAGER, because enforceTenantScope only checks
// tenant identity, never role. requireRole() itself already no-ops for the
// legacy x-api-key / super-admin path (see authMiddleware.js), so adding it
// here is additive: zero behavior change for every existing non-Bearer
// integration, and it only starts mattering once an AdminUser Bearer session
// is presented.
const requireEditor = requireRole('OWNER', 'MANAGER');

function enforceTenantScope(req, res, next) {
  if (req.isSuperAdmin) return next();
  if (!req.tenantId) return res.status(401).json({ error: 'Unauthorized' });
  // [FIX-SCOPE-1] Block SUSPENDED tenants from all data routes.
  // Auth middleware now allows PENDING/INACTIVE through so they can configure their account,
  // but SUSPENDED is an explicit admin disable — treat it like a hard block here.
  if (req.tenant?.status === 'SUSPENDED') {
    return res.status(403).json({ error: 'Account suspended. Contact support.' });
  }
  if (req.params.tenantId && req.params.tenantId !== req.tenantId) {
    return res.status(403).json({ error: "Forbidden — cannot access another tenant's data" });
  }
  next();
}

// ── Overview ──────────────────────────────────────────────────────────────────
r.get('/:tenantId/overview', overviewLimiter, enforceTenantScope, getDashboardOverview);
r.get('/:tenantId/profile-completeness', enforceTenantScope, getProfileCompleteness);
r.get('/:tenantId/onboarding-status', enforceTenantScope, getOnboardingStatus);

// ── Orders ────────────────────────────────────────────────────────────────────
r.get('/:tenantId/orders',                            enforceTenantScope, getOrders);
// [FIX-BUG13] Literal "customer" segment MUST be registered before /:orderId param
r.get('/:tenantId/orders/customer/:customerPhone',    enforceTenantScope, getCustomerOrderHistory);
// [EXPORT-1] Literal "export" segment — same route-specificity rule as above.
r.get('/:tenantId/orders/export',                     enforceTenantScope, exportOrders);
r.patch('/:tenantId/orders/:orderId/status',          enforceTenantScope, updateOrderStatus);
// [FIX-NOTIFY-READY-ENDPOINT] Dedicated endpoint for the dashboard "Notify Customer — Ready"
// button. Sets status=ready (if not already terminal) and sends the WhatsApp collection
// message with Collected + Need Help buttons. Can also be used to re-send the notification
// if the customer missed the first message.
r.post('/:tenantId/orders/:orderId/notify-ready',     enforceTenantScope, notifyOrderReady);

// ── Bookings ──────────────────────────────────────────────────────────────────
r.get('/:tenantId/bookings',                          enforceTenantScope, getBookings);
// [EXPORT-1] Literal "export" segment before any /:bookingId param route.
r.get('/:tenantId/bookings/export',                   enforceTenantScope, exportBookings);
r.patch('/:tenantId/bookings/:bookingId/status',      enforceTenantScope, updateBookingStatus);

// ── Analytics ─────────────────────────────────────────────────────────────────
r.get('/:tenantId/analytics',                         enforceTenantScope, getAnalytics);
r.get('/:tenantId/analytics/timeseries',               enforceTenantScope, getAnalyticsTimeseriesHandler);

// ── Conversations ─────────────────────────────────────────────────────────────
r.get('/:tenantId/conversations',                     enforceTenantScope, getConversations);
r.patch('/:tenantId/conversations/:phone/human',      enforceTenantScope, setHumanMode);

// ── Customers ─────────────────────────────────────────────────────────────────
r.get('/:tenantId/customers',                         enforceTenantScope, getCustomers);

// ── Business settings ─────────────────────────────────────────────────────────
r.get('/:tenantId/settings',                          enforceTenantScope, getBusinessSettings);
r.patch('/:tenantId/settings',                        enforceTenantScope, requireEditor, updateBusinessSettings);

// ── Menu CRUD ─────────────────────────────────────────────────────────────────
// uploadSingle parses multipart/form-data so image files can be included.
// JSON-only requests (no file) still work — req.file will simply be undefined.
// [AUDIT-FIX-ROLE-GATE-1] GET stays open to STAFF (they need to see the menu
// to take orders); every write below is OWNER/MANAGER only.
r.get('/:tenantId/menu',                              enforceTenantScope, getMenu);
r.post('/:tenantId/menu',                             enforceTenantScope, requireEditor, uploadSingle, addMenuItem);
r.patch('/:tenantId/menu/:itemId',                    enforceTenantScope, requireEditor, uploadSingle, updateMenuItem);
r.delete('/:tenantId/menu/:itemId',                   enforceTenantScope, requireEditor, deleteMenuItem);

// ── Menu item image upload / removal (dedicated endpoints) ────────────────────
// POST  /:tenantId/menu/:itemId/image  — multipart/form-data, field "image"
// DELETE /:tenantId/menu/:itemId/image — removes image from item + Cloudinary
r.post('/:tenantId/menu/:itemId/image',               enforceTenantScope, requireEditor, uploadSingle, uploadMenuItemImage);
r.delete('/:tenantId/menu/:itemId/image',             enforceTenantScope, requireEditor, removeMenuItemImage);

// ── Services CRUD ─────────────────────────────────────────────────────────────
r.get('/:tenantId/services',                          enforceTenantScope, getServices);
r.post('/:tenantId/services',                         enforceTenantScope, requireEditor, addService);
r.patch('/:tenantId/services/:serviceId',             enforceTenantScope, requireEditor, updateService);
r.delete('/:tenantId/services/:serviceId',            enforceTenantScope, requireEditor, deleteService);

// ── FAQ CRUD ──────────────────────────────────────────────────────────────────
r.get('/:tenantId/faqs',                              enforceTenantScope, getFaqs);
r.post('/:tenantId/faqs',                             enforceTenantScope, requireEditor, addFaq);
r.patch('/:tenantId/faqs/:faqId',                     enforceTenantScope, requireEditor, updateFaq);
r.delete('/:tenantId/faqs/:faqId',                    enforceTenantScope, requireEditor, deleteFaq);

// ── Promotions / Discount codes CRUD [PROMO-1] ────────────────────────────────
r.get('/:tenantId/promotions',                        enforceTenantScope, getPromotions);
r.post('/:tenantId/promotions',                       enforceTenantScope, requireEditor, addPromotion);
r.patch('/:tenantId/promotions/:promoId',             enforceTenantScope, requireEditor, updatePromotion);
r.delete('/:tenantId/promotions/:promoId',            enforceTenantScope, requireEditor, deletePromotion);

export default r;
