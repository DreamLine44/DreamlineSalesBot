/**
 * routes/tenantRoutes.js
 *
 * [AUDIT-P2-C] Added POST /:id/verify-whatsapp — validates Meta credentials
 *              before tenant activation.
 * [AUDIT-P2-D] Added POST /:id/rotate-key — rotates API key without data loss.
 */
import { Router } from 'express';
import {
  createTenant, listTenants, getTenant,
  updateTenant, updateTenantStatus, deleteTenant,
  verifyWhatsApp, rotateApiKey,
} from '../controllers/tenantController.js';

const r = Router();
r.post('/',                        createTenant);
r.get('/',                         listTenants);
r.get('/:id',                      getTenant);
r.patch('/:id',                    updateTenant);        // [FIX #7] update credentials / metadata
r.patch('/:id/status',             updateTenantStatus);
r.delete('/:id',                   deleteTenant);
r.post('/:id/verify-whatsapp',     verifyWhatsApp);      // [AUDIT-P2-C] credential verification
r.post('/:id/rotate-key',          rotateApiKey);        // [AUDIT-P2-D] API key rotation
export default r;
