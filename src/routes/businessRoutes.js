/**
 * routes/businessRoutes.js
 *
 * [FIX-BIZ-2] deleteMenuItem route now uses /:itemId (not /:itemName) to match
 *             the updated controller that deletes by MongoDB _id — avoids
 *             accidentally deleting multiple items with the same name.
 */
import { Router } from 'express';
import {
  getBusinessConfig, updateBusinessConfig,
  getMenu, updateMenu, addMenuItem, deleteMenuItem,
  getModeInfo, listSupportedModes, syncWaCatalog,
} from '../controllers/businessController.js';
import { CLOUDINARY_ENABLED } from '../config/cloudinary.js';
import { uploadSingle } from '../middleware/uploadMiddleware.js';
import { catalogSyncLimiter } from '../middleware/rateLimiter.js';

const r = Router();

/**
 * enforceTenantScope — prevents tenant A from reading/writing tenant B's data.
 * Super-admins (req.isSuperAdmin) bypass this check.
 * Tenant API key holders (req.tenantId) may only access their own tenantId.
 */
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

r.get('/modes',                              listSupportedModes);
r.get('/mode-info',                          getModeInfo);
r.get('/cloudinary-status',                  (_req, res) => res.json({ cloudinaryEnabled: CLOUDINARY_ENABLED }));
r.get('/:tenantId',                          enforceTenantScope, getBusinessConfig);
r.put('/:tenantId',                          enforceTenantScope, updateBusinessConfig);
r.get('/:tenantId/menu',                     enforceTenantScope, getMenu);
r.put('/:tenantId/menu',                     enforceTenantScope, updateMenu);
r.post('/:tenantId/menu',                    enforceTenantScope, uploadSingle, addMenuItem);
// [FIX-BIZ-2] Changed :itemName → :itemId for safe, precise deletion by MongoDB _id
r.delete('/:tenantId/menu/:itemId',          enforceTenantScope, deleteMenuItem);
// [CATALOG-SYNC-ROUTE-1] Manual, tenant-triggered push of menuItems into the
// tenant's Meta Commerce Catalog. catalogSyncLimiter is deliberately strict —
// this hits Meta's Graph API on the tenant's behalf.
r.post('/:tenantId/wacatalog/sync',          enforceTenantScope, catalogSyncLimiter, syncWaCatalog);
export default r;
