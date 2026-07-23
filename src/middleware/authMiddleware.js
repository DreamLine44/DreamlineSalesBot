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
import Tenant     from '../models/Tenant.js';
import AdminUser  from '../models/AdminUser.js';
import logger     from '../config/logger.js';
import { verifySessionToken } from '../services/adminAuthService.js';

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
 * requireApiKey — accepts any of:
 *   a) An AdminUser Bearer session token (Authorization: Bearer <token>) —
 *      [FEATURE-MULTIADMIN-1]. Sets req.adminUser ({id, name, email, role})
 *      and req.tenantId from the token's tenant, so downstream routes and
 *      requireRole() can use them. The admin's current status is re-checked
 *      against the DB on every request (not just at login) so that disabling
 *      an admin invalidates their outstanding sessions immediately, even
 *      though the token itself is stateless.
 *   b) SUPER_ADMIN_API_KEY (master key)
 *   c) A valid tenant API key (looked up by SHA-256 hash in Tenant collection)
 *
 * Sets req.tenant when a tenant key is used so downstream routes can use it.
 */
export async function requireApiKey(req, res, next) {
  // (a) AdminUser Bearer session — checked first so a session token takes
  // precedence over any x-api-key that might also be present on the request.
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const payload = verifySessionToken(token);
    if (!payload) {
      logger.warn('[Auth] Invalid or expired admin session token', { path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Unauthorized — invalid or expired session' });
    }

    try {
      const admin = await AdminUser.findById(payload.sub)
        .select('name email role status tenantId').lean();
      if (!admin || admin.status !== 'ACTIVE') {
        logger.warn('[Auth] Session token for inactive or missing admin', { path: req.path, sub: payload.sub });
        return res.status(401).json({ error: 'Unauthorized — session no longer valid' });
      }
      req.adminUser = {
        id:    String(admin._id),
        name:  admin.name,
        email: admin.email,
        role:  admin.role,
      };
      req.tenantId     = String(admin.tenantId);
      req.isSuperAdmin = false;
      return next();
    } catch (err) {
      logger.error('[Auth] Admin session lookup failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // (b)/(c) legacy x-api-key path — unchanged.
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
 * requireRole(role) — [FEATURE-MULTIADMIN-1] gates a route to a specific
 * AdminUser role (e.g. 'OWNER'). Must run after requireApiKey.
 *
 * A legacy x-api-key caller (super-admin or tenant key — req.adminUser is
 * unset because those callers have no individual admin identity) bypasses
 * this check and is treated as OWNER-equivalent, for backward compatibility
 * with tenants that predate the multi-admin feature. An AdminUser Bearer
 * session, by contrast, must actually hold the required role.
 */
export function requireRole(role) {
  return function (req, res, next) {
    if (!req.adminUser) return next();
    if (req.adminUser.role !== role) {
      logger.warn('[Auth] Role check failed', {
        path: req.path, required: role, actual: req.adminUser.role,
      });
      return res.status(403).json({ error: `Forbidden — requires ${role} role` });
    }
    next();
  };
}
