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
  getModeInfo, listSupportedModes,
} from '../controllers/businessController.js';
import { CLOUDINARY_ENABLED } from '../config/cloudinary.js';
import { uploadSingle } from '../middleware/uploadMiddleware.js';

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
export default r;
