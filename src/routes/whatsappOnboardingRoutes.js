/**
 * routes/whatsappOnboardingRoutes.js
 *
 * Mounts all WhatsApp onboarding endpoints.
 * Import and mount this file in app.js — it is the ONLY change required
 * to the existing codebase.
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
 *
 * Middleware applied:
 *   - requireApiKey          (reused from existing authMiddleware — NOT rewritten)
 *   - requireSuperAdminKey   (reused from existing authMiddleware — NOT rewritten)
 *   - onboarding validators  (new — in middleware/onboardingValidation.js)
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

/**
 * POST /api/whatsapp/request
 * Tenant submits a new WhatsApp connection request.
 */
router.post(
  '/api/whatsapp/request',
  requireApiKey,
  validateConnectionRequest,
  submitConnectionRequest,
);

/**
 * GET /api/whatsapp/request/status
 * Tenant checks the status of their connection request.
 */
router.get(
  '/api/whatsapp/request/status',
  requireApiKey,
  getTenantRequestStatus,
);

// ── Admin routes ──────────────────────────────────────────────────────────────

/**
 * GET /admin/whatsapp/requests
 * List all connection requests (paginated, filterable by status).
 * Query params: ?status=pending&page=1&limit=20
 */
router.get(
  '/admin/whatsapp/requests',
  requireSuperAdminKey,
  getAllConnectionRequests,
);

/**
 * GET /admin/whatsapp/requests/:id
 * Get full detail of a single request (includes adminNotes).
 */
router.get(
  '/admin/whatsapp/requests/:id',
  requireSuperAdminKey,
  getConnectionRequestById,
);

/**
 * PATCH /admin/whatsapp/requests/:id/status
 * Update request status and optional admin notes.
 * Body: { status: 'contacted'|'connecting'|'connected'|'rejected', adminNotes? }
 */
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
 *
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
