/**
 * routes/businessRoutes.js
 */
import { Router } from 'express';
import {
  getBusinessConfig, updateBusinessConfig,
  getMenu, updateMenu, addMenuItem, deleteMenuItem,
  addService, updateServices, deleteService,
  getModeInfo, listSupportedModes,
} from '../controllers/businessController.js';

const r = Router();

/**
 * enforceTenantScope — prevents tenant A from reading/writing tenant B's data.
 * Super-admins (req.isSuperAdmin) bypass this check.
 * Tenant API key holders (req.tenantId) may only access their own tenantId.
 */
function enforceTenantScope(req, res, next) {
  if (req.isSuperAdmin) return next();
  if (!req.tenantId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.params.tenantId && req.params.tenantId !== req.tenantId) {
    return res.status(403).json({ error: 'Forbidden — cannot access another tenant\'s data' });
  }
  next();
}

r.get('/modes',                              listSupportedModes);
r.get('/mode-info',                          getModeInfo);
r.get('/:tenantId',                          enforceTenantScope, getBusinessConfig);
r.put('/:tenantId',                          enforceTenantScope, updateBusinessConfig);
r.get('/:tenantId/menu',                     enforceTenantScope, getMenu);
r.put('/:tenantId/menu',                     enforceTenantScope, updateMenu);
r.post('/:tenantId/menu',                    enforceTenantScope, addMenuItem);
r.delete('/:tenantId/menu/:itemName',        enforceTenantScope, deleteMenuItem);
// FIX #17: Services CRUD endpoints (previously only accessible via raw PUT /:tenantId)
r.get('/:tenantId/services',                 enforceTenantScope, (req, res) => {
  // Reuse getMenu — it already returns both menuItems and services
  return getMenu(req, res);
});
r.put('/:tenantId/services',                 enforceTenantScope, updateServices);
r.post('/:tenantId/services',                enforceTenantScope, addService);
r.delete('/:tenantId/services/:serviceName', enforceTenantScope, deleteService);
export default r;
