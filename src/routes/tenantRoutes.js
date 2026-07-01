/**
 * routes/tenantRoutes.js
 *
 * [AUDIT-P2-C] Added POST /:id/verify-whatsapp — validates Meta credentials
 *              before tenant activation.
 * [AUDIT-P2-D] Added POST /:id/rotate-key — rotates API key without data loss.
 * [FIX-PUT]    Added PUT /:id as a transparent alias for PATCH /:id.
 *              Bruno and some HTTP clients default to PUT for update payloads;
 *              both methods now route to the same updateTenant handler so credentials
 *              are saved regardless of which verb the client uses.
 */
import { Router } from 'express';
import {
  createTenant, listTenants, getTenant, getPlatformStats,
  updateTenant, updateTenantStatus, deleteTenant,
  verifyWhatsApp, rotateApiKey,
} from '../controllers/tenantController.js';

const r = Router();
r.post('/',                        createTenant);
r.get('/',                         listTenants);
// [IMPROVE-STATS] Must be registered BEFORE GET /:id — otherwise Express would
// match "stats" as the :id param and route it into getTenant instead, the same
// route-ordering trap already fixed elsewhere in this codebase (see
// dashboardRoutes.js FIX-BUG13 for the customer/:orderId precedent).
r.get('/stats',                    getPlatformStats);
r.get('/:id',                      getTenant);
r.patch('/:id',                    updateTenant);        // [FIX #7] update credentials / metadata
r.put('/:id',                      updateTenant);        // [FIX-PUT] PUT alias — same handler as PATCH
r.patch('/:id/status',             updateTenantStatus);
r.delete('/:id',                   deleteTenant);
r.post('/:id/verify-whatsapp',     verifyWhatsApp);      // [AUDIT-P2-C] credential verification
r.post('/:id/rotate-key',          rotateApiKey);        // [AUDIT-P2-D] API key rotation
export default r;
