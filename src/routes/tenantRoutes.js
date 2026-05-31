/**
 * routes/tenantRoutes.js
 *
 * [FIX-WA-8] Added POST /:id/whatsapp/verify — on-demand credential verification
 * that hits the Meta Graph API and updates whatsapp.connected on the Tenant doc.
 * Called by the tenant setup page "Setup Checklist" and after saving credentials
 * in the admin Edit Tenant modal.
 */
import { Router } from 'express';
import {
  createTenant, listTenants, getTenant,
  updateTenant, updateTenantStatus, deleteTenant,
  verifyWhatsAppConnection,
} from '../controllers/tenantController.js';

const r = Router();
r.post('/',                             createTenant);
r.get('/',                              listTenants);
r.get('/:id',                           getTenant);
r.patch('/:id',                         updateTenant);
r.patch('/:id/status',                  updateTenantStatus);
r.delete('/:id',                        deleteTenant);
// [FIX-WA-8] On-demand WhatsApp credential verification
r.post('/:id/whatsapp/verify',          verifyWhatsAppConnection);
export default r;
