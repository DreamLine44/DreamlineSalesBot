/**
 * routes/adminUserRoutes.js
 *
 * [FEATURE-MULTIADMIN-1] Tenant Dashboard staff login and management.
 * Mounted at '/' in app.js (same pattern as whatsappOnboardingRoutes.js) so
 * each route below declares its own full path.
 *
 * Auth notes:
 *   - /dashboard/auth/login and /dashboard/auth/accept-invite are UNAUTHENTICATED
 *     by design — they're how you GET a session token in the first place.
 *   - /dashboard/auth/me and everything under /dashboard/:tenantId/admins requires
 *     requireApiKey (accepts either an AdminUser Bearer session or the legacy
 *     tenant/super-admin x-api-key — see middleware/authMiddleware.js).
 *   - Staff-management writes (invite/update/remove) are further gated with
 *     requireRole('OWNER') — a legacy x-api-key caller bypasses this (treated
 *     as OWNER-equivalent for backward compatibility), an AdminUser Bearer
 *     session does not.
 */
import { Router } from 'express';
import { requireApiKey, requireRole } from '../middleware/authMiddleware.js';
import {
  login, acceptInvite, me,
  claimOwner, listAdmins, inviteAdmin, updateAdmin, removeAdmin,
} from '../controllers/adminUserController.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// [FEATURE-MULTIADMIN-1] Same tenant-isolation pattern already duplicated in
// businessRoutes.js and dashboardRoutes.js (prevents tenant A's session/key
// from reading or writing tenant B's admin accounts via a mismatched :tenantId
// URL param). Duplicated rather than imported because neither of those two
// files exports theirs — matching existing convention rather than introducing
// a new shared-middleware refactor as a side effect of this feature.
function enforceTenantScope(req, res, next) {
  if (req.isSuperAdmin) return next();
  if (!req.tenantId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.tenant?.status === 'SUSPENDED') {
    return res.status(403).json({ error: 'Account suspended. Contact support.' });
  }
  if (req.params.tenantId && req.params.tenantId !== req.tenantId) {
    return res.status(403).json({ error: "Forbidden — cannot access another tenant's data" });
  }
  next();
}

// [FEATURE-MULTIADMIN-1] Tighter limiter on unauthenticated auth endpoints —
// these are the brute-force/credential-stuffing surface of this feature.
const authLimiter = createRateLimiter(20);

// ── Unauthenticated ──────────────────────────────────────────────────────────
router.post('/dashboard/auth/login',          authLimiter, login);
router.post('/dashboard/auth/accept-invite',  authLimiter, acceptInvite);

// ── Requires a session (Bearer) or legacy x-api-key ──────────────────────────
router.get('/dashboard/auth/me', requireApiKey, me);

// One-time bootstrap for tenants that predate this feature — auth is the
// EXISTING tenant/super-admin x-api-key, not a session token (there isn't
// one yet, that's the point of this endpoint).
router.post(
  '/dashboard/:tenantId/admins/claim-owner',
  requireApiKey, enforceTenantScope,
  claimOwner,
);

router.get(
  '/dashboard/:tenantId/admins',
  // [AUDIT-FIX-ROLE-GATE-1] This route's own header comment above (and the
  // file-level docstring) documented "list staff (OWNER, MANAGER)" but no
  // requireRole() call was ever actually added — any authenticated STAFF
  // Bearer session could list the full admin roster (names/emails/roles/
  // status) for the tenant. Bringing the code in line with the documented
  // intent.
  requireApiKey, enforceTenantScope, requireRole('OWNER', 'MANAGER'),
  listAdmins,
);
router.post(
  '/dashboard/:tenantId/admins/invite',
  requireApiKey, enforceTenantScope, requireRole('OWNER'),
  inviteAdmin,
);
router.patch(
  '/dashboard/:tenantId/admins/:id',
  requireApiKey, enforceTenantScope, requireRole('OWNER'),
  updateAdmin,
);
router.delete(
  '/dashboard/:tenantId/admins/:id',
  requireApiKey, enforceTenantScope, requireRole('OWNER'),
  removeAdmin,
);

export default router;
