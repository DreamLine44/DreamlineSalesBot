/**
 * routes/whatsappOnboardingRoutes.js
 *
 * Mounts all WhatsApp onboarding endpoints.
 *
 * Route map:
 *
 * TENANT-FACING  (requireApiKey — tenant or super-admin key)
 *   POST /api/whatsapp/request            submitConnectionRequest
 *   GET  /api/whatsapp/request/status     getTenantRequestStatus
 *
 * ADMIN-FACING   (requireSuperAdminKey)
 *   GET    /admin/whatsapp/requests              getAllConnectionRequests
 *   GET    /admin/whatsapp/requests/:id          getConnectionRequestById
 *   PATCH  /admin/whatsapp/requests/:id/status   updateConnectionRequestStatus
 *   POST   /admin/whatsapp/connect/:tenantId     saveTenantWhatsAppCredentials
 *   POST   /admin/whatsapp/test/:tenantId        testTenantWhatsAppConnection
 */
import { Router } from 'express';
import { requireApiKey, requireSuperAdminKey } from '../middleware/authMiddleware.js';
import {
  validateConnectionRequest,
  validateStatusUpdate,
  validateWhatsAppCredentials,
} from '../middleware/onboardingValidation.js';
import {
  submitConnectionRequest,
  getTenantRequestStatus,
  getAllConnectionRequests,
  getConnectionRequestById,
  updateConnectionRequestStatus,
  saveTenantWhatsAppCredentials,
  testTenantWhatsAppConnection,
} from '../controllers/whatsappOnboardingController.js';

const router = Router();

// ── Tenant routes ─────────────────────────────────────────────────────────────

router.post(
  '/api/whatsapp/request',
  requireApiKey,
  validateConnectionRequest,
  submitConnectionRequest,
);

router.get(
  '/api/whatsapp/request/status',
  requireApiKey,
  getTenantRequestStatus,
);

// ── Admin routes ──────────────────────────────────────────────────────────────

router.get(
  '/admin/whatsapp/requests',
  requireSuperAdminKey,
  getAllConnectionRequests,
);

router.get(
  '/admin/whatsapp/requests/:id',
  requireSuperAdminKey,
  getConnectionRequestById,
);

router.patch(
  '/admin/whatsapp/requests/:id/status',
  requireSuperAdminKey,
  validateStatusUpdate,
  updateConnectionRequestStatus,
);

/**
 * POST /admin/whatsapp/connect/:tenantId
 * Save WhatsApp credentials for a tenant.
 * Body: { phoneNumberId, wabaId, accessToken, verifyToken, apiVersion?, verifyFirst? }
 * Set verifyFirst=true to verify against Meta before saving (recommended).
 */
router.post(
  '/admin/whatsapp/connect/:tenantId',
  requireSuperAdminKey,
  validateWhatsAppCredentials,
  saveTenantWhatsAppCredentials,
);

/**
 * POST /admin/whatsapp/test/:tenantId
 * Test a tenant's stored credentials against the Meta Graph API.
 * On success, marks the tenant as CONNECTED and advances the request status.
 */
router.post(
  '/admin/whatsapp/test/:tenantId',
  requireSuperAdminKey,
  testTenantWhatsAppConnection,
);

export default router;
