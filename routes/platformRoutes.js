/**
 * routes/platformRoutes.js — Dreamline Sales Bot v6.0
 *
 * Platform owner (super-admin) routes.
 * All routes require SUPER_ADMIN_API_KEY (applied in app.js).
 */

import { Router } from 'express';
import {
  listTenants,
  getTenantDetail,
  changePlan,
  changeStatus,
  getPlatformStats,
  resetUsageCounters,
  notifyTenant,
} from '../controllers/platformController.js';

const router = Router();

// ── Stats ─────────────────────────────────────────────────────────────────────
// GET /platform/stats
router.get('/stats', getPlatformStats);

// ── Reset usage (call monthly via cron or manually) ───────────────────────────
// POST /platform/reset-usage
router.post('/reset-usage', resetUsageCounters);

// ── Tenants ───────────────────────────────────────────────────────────────────
// GET /platform/tenants?status=ACTIVE&plan=FREE&page=1&limit=20&search=dreamline
router.get('/tenants',                  listTenants);

// GET /platform/tenants/:id
router.get('/tenants/:id',              getTenantDetail);

// PUT /platform/tenants/:id/plan   body: { plan: "PRO", note: "upgraded manually" }
router.put('/tenants/:id/plan',         changePlan);

// PUT /platform/tenants/:id/status body: { status: "SUSPENDED", reason: "non-payment" }
router.put('/tenants/:id/status',       changeStatus);

// POST /platform/tenants/:id/notify  body: { message: "..." }
router.post('/tenants/:id/notify',      notifyTenant);

export default router;
