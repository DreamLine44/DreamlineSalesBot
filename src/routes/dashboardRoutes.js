/**
 * routes/dashboardRoutes.js
 */
import { Router } from 'express';
import {
  getDashboardOverview, getOrders, updateOrderStatus,
  getBookings, updateBookingStatus, getAnalytics,
  getConversations, setHumanMode, getCustomers,
  getBusinessSettings, updateBusinessSettings,
} from '../controllers/dashboardController.js';

const r = Router();

/**
 * enforceTenantScope — prevents tenant A from reading/writing tenant B's data.
 * Super-admins (req.isSuperAdmin) bypass this check.
 */
function enforceTenantScope(req, res, next) {
  if (req.isSuperAdmin) return next();
  if (!req.tenantId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.params.tenantId && req.params.tenantId !== req.tenantId) {
    return res.status(403).json({ error: 'Forbidden — cannot access another tenant\'s data' });
  }
  next();
}

r.get('/:tenantId/overview',                   enforceTenantScope, getDashboardOverview);
r.get('/:tenantId/orders',                     enforceTenantScope, getOrders);
r.patch('/:tenantId/orders/:orderId/status',   enforceTenantScope, updateOrderStatus);
r.get('/:tenantId/bookings',                   enforceTenantScope, getBookings);
r.patch('/:tenantId/bookings/:bookingId/status', enforceTenantScope, updateBookingStatus);
r.get('/:tenantId/analytics',                  enforceTenantScope, getAnalytics);
r.get('/:tenantId/conversations',              enforceTenantScope, getConversations);
r.patch('/:tenantId/conversations/:phone/human', enforceTenantScope, setHumanMode);
r.get('/:tenantId/customers',                  enforceTenantScope, getCustomers);
r.get('/:tenantId/settings',                   enforceTenantScope, getBusinessSettings);
r.patch('/:tenantId/settings',                 enforceTenantScope, updateBusinessSettings);
export default r;
