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
  getOrders, updateOrderStatus, getCustomerOrderHistory, notifyOrderReady,
  getBookings, updateBookingStatus,
  getAnalytics,
  getAnalyticsTimeseriesHandler,
  getConversations, setHumanMode,
  getCustomers,
  getBusinessSettings, updateBusinessSettings, rotateOwnApiKey,
  getMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getServices, addService, updateService, deleteService,
  getFaqs, addFaq, updateFaq, deleteFaq,
} from '../controllers/dashboardController.js';
import { requireRole } from '../middleware/authMiddleware.js';
import { uploadSingle, uploadMultiple } from '../middleware/uploadMiddleware.js';
import {
  uploadMenuItemImage, removeMenuItemImage,
  uploadMenuItemGalleryImages, removeMenuItemGalleryImage,
} from '../controllers/menuImageController.js';
import { overviewLimiter } from '../middleware/rateLimiter.js';

const r = Router();

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

// ── Orders ────────────────────────────────────────────────────────────────────
r.get('/:tenantId/orders',                            enforceTenantScope, getOrders);
// [FIX-BUG13] Literal "customer" segment MUST be registered before /:orderId param
r.get('/:tenantId/orders/customer/:customerPhone',    enforceTenantScope, getCustomerOrderHistory);
r.patch('/:tenantId/orders/:orderId/status',          enforceTenantScope, updateOrderStatus);
// [FIX-NOTIFY-READY-ENDPOINT] Dedicated endpoint for the dashboard "Notify Customer — Ready"
// button. Sets status=ready (if not already terminal) and sends the WhatsApp collection
// message with Collected + Need Help buttons. Can also be used to re-send the notification
// if the customer missed the first message.
r.post('/:tenantId/orders/:orderId/notify-ready',     enforceTenantScope, notifyOrderReady);

// ── Bookings ──────────────────────────────────────────────────────────────────
r.get('/:tenantId/bookings',                          enforceTenantScope, getBookings);
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
r.patch('/:tenantId/settings',                        enforceTenantScope, updateBusinessSettings);
// [NO-SELFSERVE-APIKEY-1] OWNER-only self-service key rotation — see
// dashboardController.rotateOwnApiKey for why a legacy shared-key caller
// (OWNER-equivalent per requireRole) is allowed to hit this too.
r.post('/:tenantId/rotate-key',                       enforceTenantScope, requireRole('OWNER'), rotateOwnApiKey);

// ── Menu CRUD ─────────────────────────────────────────────────────────────────
// uploadSingle parses multipart/form-data so image files can be included.
// JSON-only requests (no file) still work — req.file will simply be undefined.
r.get('/:tenantId/menu',                              enforceTenantScope, getMenu);
r.post('/:tenantId/menu',                             enforceTenantScope, uploadSingle, addMenuItem);
r.patch('/:tenantId/menu/:itemId',                    enforceTenantScope, uploadSingle, updateMenuItem);
r.delete('/:tenantId/menu/:itemId',                   enforceTenantScope, deleteMenuItem);

// ── Menu item image upload / removal (dedicated endpoints) ────────────────────
// POST  /:tenantId/menu/:itemId/image  — multipart/form-data, field "image"
// DELETE /:tenantId/menu/:itemId/image — removes image from item + Cloudinary
r.post('/:tenantId/menu/:itemId/image',               enforceTenantScope, uploadSingle, uploadMenuItemImage);
r.delete('/:tenantId/menu/:itemId/image',             enforceTenantScope, removeMenuItemImage);

// ── Menu item GALLERY images (multiple photos, additive to the cover image) ───
// [FEAT-MULTI-IMAGE] POST accepts 1–10 files under repeated field "images" and
// appends them to menuItems[].images. Fully independent of the single `image`
// (cover photo) above — never touches it, never removes it. Meta catalog sync
// reads these as `additional_image_urls`; the cover `image` stays the sync's
// `image_link` exactly as before.
// POST   /:tenantId/menu/:itemId/images              — multipart/form-data, repeated field "images"
// DELETE /:tenantId/menu/:itemId/images/:imageId      — removes one gallery image by its subdocument _id
r.post('/:tenantId/menu/:itemId/images',              enforceTenantScope, uploadMultiple, uploadMenuItemGalleryImages);
r.delete('/:tenantId/menu/:itemId/images/:imageId',   enforceTenantScope, removeMenuItemGalleryImage);

// ── Services CRUD ─────────────────────────────────────────────────────────────
r.get('/:tenantId/services',                          enforceTenantScope, getServices);
r.post('/:tenantId/services',                         enforceTenantScope, addService);
r.patch('/:tenantId/services/:serviceId',             enforceTenantScope, updateService);
r.delete('/:tenantId/services/:serviceId',            enforceTenantScope, deleteService);

// ── FAQ CRUD ──────────────────────────────────────────────────────────────────
r.get('/:tenantId/faqs',                              enforceTenantScope, getFaqs);
r.post('/:tenantId/faqs',                             enforceTenantScope, addFaq);
r.patch('/:tenantId/faqs/:faqId',                     enforceTenantScope, updateFaq);
r.delete('/:tenantId/faqs/:faqId',                    enforceTenantScope, deleteFaq);

export default r;
