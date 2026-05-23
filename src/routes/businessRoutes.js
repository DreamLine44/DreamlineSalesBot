/**
 * routes/businessRoutes.js
 *
 * [FIX] Added PATCH /:tenantId/menu/:itemId and PATCH /:tenantId/services/:serviceId
 *       so clients can update individual items without replacing the full array.
 */
import { Router } from 'express';
import {
  getBusinessConfig, updateBusinessConfig,
  getMenu, updateMenu, addMenuItem, updateMenuItem, deleteMenuItem,
  getServices, addService, updateService, updateServices, deleteService,
  getModeInfo, listSupportedModes,
} from '../controllers/businessController.js';

const r = Router();

function enforceTenantScope(req, res, next) {
  if (req.isSuperAdmin) return next();
  if (!req.tenantId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.params.tenantId && req.params.tenantId !== req.tenantId) {
    return res.status(403).json({ error: "Forbidden — cannot access another tenant's data" });
  }
  next();
}

r.get('/modes',                                enforceTenantScope, listSupportedModes);
r.get('/mode-info',                            getModeInfo);
r.get('/:tenantId',                            enforceTenantScope, getBusinessConfig);
r.put('/:tenantId',                            enforceTenantScope, updateBusinessConfig);

// Menu CRUD
r.get('/:tenantId/menu',                       enforceTenantScope, getMenu);
r.put('/:tenantId/menu',                       enforceTenantScope, updateMenu);
r.post('/:tenantId/menu',                      enforceTenantScope, addMenuItem);
r.patch('/:tenantId/menu/:itemId',             enforceTenantScope, updateMenuItem);
r.delete('/:tenantId/menu/:itemId',            enforceTenantScope, deleteMenuItem);
// Legacy: delete by name
r.delete('/:tenantId/menu/by-name/:itemName',  enforceTenantScope, deleteMenuItem);

// Services CRUD
r.get('/:tenantId/services',                     enforceTenantScope, getServices);
r.post('/:tenantId/services',                    enforceTenantScope, addService);
r.patch('/:tenantId/services/:serviceId',        enforceTenantScope, updateService);
r.put('/:tenantId/services',                     enforceTenantScope, updateServices);
r.delete('/:tenantId/services/:serviceId',       enforceTenantScope, deleteService);
// Legacy: delete by name
r.delete('/:tenantId/services/by-name/:serviceName', enforceTenantScope, deleteService);

export default r;
