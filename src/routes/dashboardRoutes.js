/**
 * routes/dashboardRoutes.js — WhatSalesAgent (Merged)
 *
 * [FIX-BUG13] getCustomerOrderHistory moved ABOVE /:orderId/status to prevent
 *             Express matching "customer" as an orderId param and returning 404.
 *             Route specificity rule: literal path segments must come before params.
 *
 * [FIX-SETUP-1] Added GET /:tenantId/whatsapp/status and POST /:tenantId/whatsapp/request
 *              so the tenant setup page can read connection status and send a setup
 *              request to the admin without requiring super-admin credentials.
 *              The admin's verify/save flow remains under /admin/tenants/:id.
 */
import { Router } from 'express';
import {
  getDashboardOverview,
  getOrders, updateOrderStatus, getCustomerOrderHistory,
  getBookings, updateBookingStatus,
  getAnalytics,
  getConversations, setHumanMode,
  getCustomers,
  getBusinessSettings, updateBusinessSettings,
  getMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getServices, addService, updateService, deleteService,
  getFaqs, addFaq, updateFaq, deleteFaq,
  getWhatsAppStatus, requestWhatsAppSetup,
} from '../controllers/dashboardController.js';
import { uploadSingle } from '../middleware/uploadMiddleware.js';
import { uploadMenuItemImage, removeMenuItemImage } from '../controllers/menuImageController.js';

const r = Router();

function enforceTenantScope(req, res, next) {
  if (req.isSuperAdmin) return next();
  if (!req.tenantId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.params.tenantId && req.params.tenantId !== req.tenantId) {
    return res.status(403).json({ error: "Forbidden — cannot access another tenant's data" });
  }
  next();
}

// ── Overview ──────────────────────────────────────────────────────────────────
r.get('/:tenantId/overview', enforceTenantScope, getDashboardOverview);

// ── Orders ────────────────────────────────────────────────────────────────────
r.get('/:tenantId/orders',                            enforceTenantScope, getOrders);
// [FIX-BUG13] Literal "customer" segment MUST be registered before /:orderId param
r.get('/:tenantId/orders/customer/:customerPhone',    enforceTenantScope, getCustomerOrderHistory);
r.patch('/:tenantId/orders/:orderId/status',          enforceTenantScope, updateOrderStatus);

// ── Bookings ──────────────────────────────────────────────────────────────────
r.get('/:tenantId/bookings',                          enforceTenantScope, getBookings);
r.patch('/:tenantId/bookings/:bookingId/status',      enforceTenantScope, updateBookingStatus);

// ── Analytics ─────────────────────────────────────────────────────────────────
r.get('/:tenantId/analytics',                         enforceTenantScope, getAnalytics);

// ── Conversations ─────────────────────────────────────────────────────────────
r.get('/:tenantId/conversations',                     enforceTenantScope, getConversations);
r.patch('/:tenantId/conversations/:phone/human',      enforceTenantScope, setHumanMode);

// ── Customers ─────────────────────────────────────────────────────────────────
r.get('/:tenantId/customers',                         enforceTenantScope, getCustomers);

// ── Business settings ─────────────────────────────────────────────────────────
r.get('/:tenantId/settings',                          enforceTenantScope, getBusinessSettings);
r.patch('/:tenantId/settings',                        enforceTenantScope, updateBusinessSettings);

// ── Menu CRUD ─────────────────────────────────────────────────────────────────
r.get('/:tenantId/menu',                              enforceTenantScope, getMenu);
r.post('/:tenantId/menu',                             enforceTenantScope, uploadSingle, addMenuItem);
r.patch('/:tenantId/menu/:itemId',                    enforceTenantScope, uploadSingle, updateMenuItem);
r.delete('/:tenantId/menu/:itemId',                   enforceTenantScope, deleteMenuItem);

// ── Menu item image upload / removal (dedicated endpoints) ────────────────────
r.post('/:tenantId/menu/:itemId/image',               enforceTenantScope, uploadSingle, uploadMenuItemImage);
r.delete('/:tenantId/menu/:itemId/image',             enforceTenantScope, removeMenuItemImage);

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

// ── WhatsApp connection status (for tenant setup page) ────────────────────────
// [FIX-SETUP-1] The tenant setup page at /setup/whatsapp needs to read the
// connection status (connected badge + checklist items) without super-admin creds.
// GET  /:tenantId/whatsapp/status  — returns connected, phoneNumberId, checklist
// POST /:tenantId/whatsapp/request — sends a setup request email/alert to admin
r.get('/:tenantId/whatsapp/status',                   enforceTenantScope, getWhatsAppStatus);
r.post('/:tenantId/whatsapp/request',                 enforceTenantScope, requestWhatsAppSetup);

export default r;
