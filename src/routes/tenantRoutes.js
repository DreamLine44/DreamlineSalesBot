/**
 * routes/tenantRoutes.js
 */
import { Router } from 'express';
import {
  createTenant, listTenants, getTenant,
  updateTenantStatus, deleteTenant,
} from '../controllers/tenantController.js';

const r = Router();
r.post('/',                   createTenant);
r.get('/',                    listTenants);
r.get('/:id',                 getTenant);
r.patch('/:id/status',        updateTenantStatus);
r.delete('/:id',              deleteTenant);
export default r;
