/**
 * middleware/authMiddleware.js — WhatSalesAgent2 (Production)
 *
 * Changes from dev:
 *  - requireApiKey now also accepts per-tenant API keys (apiKeyHash lookup),
 *    not just the global SUPER_ADMIN_API_KEY. This means tenants can call
 *    /business and /dashboard routes with their own keys.
 *  - Constant-time comparison (timingSafeEqual) to prevent timing attacks.
 *  - Request logging on auth failure for security auditing.
 */
import crypto from 'crypto';
import Tenant  from '../models/Tenant.js';
import logger  from '../config/logger.js';

/** Constant-time string comparison — prevents timing side-channel attacks.
 *
 * [FIX #14] The old implementation used padEnd(64), which is a no-op for
 * strings longer than 64 chars. timingSafeEqual then received buffers of
 * different lengths and threw ERR_CRYPTO_TIMINGSAFE_UNEQUAL_BUFFERS before
 * the safe a.length===b.length guard could run. SUPER_ADMIN_API_KEY can be
 * arbitrarily long, so this was a real crash path.
 *
 * Fix: allocate both buffers to max(a.length, b.length, 64) so they are
 * always the same size regardless of key length.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len  = Math.max(a.length, b.length, 64);
  const aBuf = Buffer.alloc(len);
  const bBuf = Buffer.alloc(len);
  Buffer.from(a).copy(aBuf);
  Buffer.from(b).copy(bBuf);
  // timingSafeEqual gives constant-time XOR; the length check catches mismatches
  // that the padded XOR would pass (e.g. 'abc\0\0…' vs 'abcde\0…').
  return crypto.timingSafeEqual(aBuf, bBuf) && a.length === b.length;
}

/**
 * requireApiKey — accepts, in order:
 *   a) [AUDIT-FIX-MULTIADMIN-SESSION] An AdminUser Bearer session token
 *      (Authorization: Bearer <token>, signed by adminAuthService.js's
 *      createSessionToken()). Sets req.adminUser so per-admin identity
 *      (name/role/id) is available to controllers and requireRole() below.
 *      Previously this entire path was missing: adminUserController.js's
 *      login()/acceptInvite() issued session tokens, but NOTHING anywhere
 *      in the app ever verified one — every "authenticated" request was
 *      silently treated as a legacy shared-key call instead, and
 *      req.adminUser was always undefined.
 *   b) SUPER_ADMIN_API_KEY (master key)
 *   c) A valid tenant API key (looked up by SHA-256 hash in Tenant collection)
 *
 * Sets req.tenant/req.tenantId when a tenant key or admin session is used so
 * downstream routes can use it.
 */
export async function requireApiKey(req, res, next) {
  // [AUDIT-FIX-MULTIADMIN-SESSION] Bearer session — checked first so a
  // logged-in staff member's own identity is used instead of silently
  // falling back to shared-key behaviour.
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      const { verifySessionToken } = await import('../services/adminAuthService.js');
      const payload = verifySessionToken(token);
      if (!payload) {
        logger.warn('[Auth] Invalid or expired admin session token', { path: req.path, ip: req.ip });
        return res.status(401).json({ error: 'Unauthorized — invalid or expired session' });
      }

      // Re-fetch the AdminUser (rather than trusting the token payload's
      // embedded role) so a role change or disablement takes effect
      // immediately, not only after the 7-day token expiry.
      const { default: AdminUser } = await import('../models/AdminUser.js');
      const admin = await AdminUser.findById(payload.sub).select('name email role status tenantId').lean();
      if (!admin || admin.status !== 'ACTIVE') {
        logger.warn('[Auth] Session references a missing/disabled admin', { sub: payload.sub, path: req.path });
        return res.status(401).json({ error: 'Unauthorized — account disabled or removed' });
      }

      const tenant = await Tenant.findById(admin.tenantId).lean();
      if (!tenant || tenant.status === 'SUSPENDED') {
        return res.status(403).json({ error: 'Account suspended. Contact support.' });
      }

      req.adminUser    = { id: String(admin._id), name: admin.name, email: admin.email, role: admin.role };
      req.tenant       = tenant;
      req.tenantId     = String(admin.tenantId);
      req.isSuperAdmin = false;
      return next();
    } catch (err) {
      logger.error('[Auth] Admin session verification failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  const key = req.headers['x-api-key'];
  if (!key) {
    logger.warn('[Auth] Missing x-api-key', { path: req.path, ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized — x-api-key header required' });
  }

  // Super-admin key check (constant-time)
  if (safeCompare(key, process.env.SUPER_ADMIN_API_KEY || '')) {
    req.isSuperAdmin = true;
    return next();
  }

  // Per-tenant key lookup via SHA-256 hash.
  // [FIX-AUTH-1] Accept PENDING and INACTIVE tenants, not just ACTIVE.
  // Restricting to ACTIVE caused a deadlock: a freshly created tenant is PENDING,
  // but they need their API key to authenticate to /business and /dashboard routes
  // in order to configure their account and reach ACTIVE in the first place.
  // Status-based access control belongs in individual route handlers (e.g. the
  // WhatsApp bot's receiveWebhook only dispatches for ACTIVE tenants), NOT at the
  // authentication layer. SUSPENDED tenants are still blocked — they are explicitly
  // disabled by an admin action.
  try {
    const hash   = crypto.createHash('sha256').update(key).digest('hex');
    const tenant = await Tenant.findOne({
      apiKeyHash: hash,
      status: { $in: ['ACTIVE', 'PENDING', 'INACTIVE'] },
    }).lean();
    if (tenant) {
      req.tenant       = tenant;
      req.tenantId     = String(tenant._id);
      req.isSuperAdmin = false;
      return next();
    }
  } catch (err) {
    logger.error('[Auth] DB lookup failed', { err: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  logger.warn('[Auth] Invalid API key attempt', { path: req.path, ip: req.ip });
  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * requireSuperAdminKey — only the master key passes.
 * Used for /admin/tenants (tenant management) routes.
 */
export function requireSuperAdminKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || !safeCompare(key, process.env.SUPER_ADMIN_API_KEY || '')) {
    logger.warn('[Auth] Rejected super-admin attempt', { path: req.path, ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized — super-admin key required' });
  }
  req.isSuperAdmin = true;
  next();
}

/**
 * [AUDIT-FIX-MULTIADMIN-SESSION] requireRole — gates a route to a specific
 * AdminUser role. Mount AFTER requireApiKey.
 *
 * A legacy x-api-key caller (req.adminUser is unset — no individual admin
 * session, just the shared tenant/super-admin key) is treated as
 * OWNER-equivalent for backward compatibility: possession of that key
 * already granted full access under the pre-existing auth model, and
 * routes using requireRole are additive gating on TOP of that model, not a
 * replacement for it. An authenticated AdminUser session, by contrast, is
 * held to its actual assigned role.
 */
export function requireRole(role) {
  return (req, res, next) => {
    if (req.isSuperAdmin || !req.adminUser) return next();
    if (req.adminUser.role !== role) {
      logger.warn('[Auth] Role check failed', {
        required: role, actual: req.adminUser.role, path: req.path,
      });
      return res.status(403).json({ error: `Forbidden — requires ${role} role` });
    }
    next();
  };
}
