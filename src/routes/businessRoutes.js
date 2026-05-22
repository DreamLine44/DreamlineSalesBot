/**
 * routes/businessRoutes.js
 */
import { Router } from 'express';
import {
  getBusinessConfig, updateBusinessConfig,
  getMenu, updateMenu, addMenuItem, deleteMenuItem,
  getServices, addService, updateServices, deleteService,
  getModeInfo, listSupportedModes,
} from '../controllers/businessController.js';

const r = Router();

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
// Menu
r.get('/:tenantId/menu',                     enforceTenantScope, getMenu);
r.put('/:tenantId/menu',                     enforceTenantScope, updateMenu);
r.post('/:tenantId/menu',                    enforceTenantScope, addMenuItem);
r.delete('/:tenantId/menu/:itemName',        enforceTenantScope, deleteMenuItem);
// Services
r.get('/:tenantId/services',                 enforceTenantScope, getServices);
r.post('/:tenantId/services',                enforceTenantScope, addService);
r.put('/:tenantId/services',                 enforceTenantScope, updateServices);
r.delete('/:tenantId/services/:serviceName', enforceTenantScope, deleteService);
export default r;

