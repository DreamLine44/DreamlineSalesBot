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
  getOrders, updateOrderStatus, getCustomerOrderHistory,
  getBookings, updateBookingStatus,
  getAnalytics,
  getConversations, setHumanMode,
  getCustomers,
  getBusinessSettings, updateBusinessSettings,
  getMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getServices, addService, updateService, deleteService,
  getFaqs, addFaq, updateFaq, deleteFaq,
} from '../controllers/dashboardController.js';

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
r.post('/:tenantId/menu',                             enforceTenantScope, addMenuItem);
r.patch('/:tenantId/menu/:itemId',                    enforceTenantScope, updateMenuItem);
r.delete('/:tenantId/menu/:itemId',                   enforceTenantScope, deleteMenuItem);

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
