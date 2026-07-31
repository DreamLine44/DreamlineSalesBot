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
 * tryBearerAuth — attempts to authenticate via an AdminUser session token
 * (Authorization: Bearer <token>, see services/adminAuthService.js).
 *
 * Returns false (without touching res) whenever there's no Bearer header,
 * or the token is missing/invalid/expired/for a disabled admin, so the
 * caller (requireApiKey) can fall through to the legacy x-api-key check
 * below rather than hard-failing the request.
 *
 * On success sets req.adminUser ({ id, name, email, role }), req.tenantId,
 * and req.isSuperAdmin = false.
 *
 * [FEATURE-MULTIADMIN-1] Re-reads the AdminUser from the DB on every call
 * (rather than trusting the token payload's embedded role) so a role change
 * or a DISABLED status takes effect immediately instead of waiting out the
 * token's 7-day TTL.
 */
export async function tryBearerAuth(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return false;

  const token   = header.slice(7).trim();
  const payload = verifySessionToken(token);
  if (!payload) return false;

  const admin = await AdminUser.findOne({ _id: payload.sub, tenantId: payload.tenantId })
    .select('name email role status tenantId').lean();
  if (!admin || admin.status !== 'ACTIVE') return false;

  req.adminUser = {
    id: String(admin._id), name: admin.name, email: admin.email, role: admin.role,
  };
  req.tenantId     = String(admin.tenantId);
  req.isSuperAdmin = false;
  return true;
}

/**
 * requireRole — route-level gate for staff-management writes. Only meaningful
 * after requireApiKey has run.
 *
 * A legacy x-api-key caller (no individual AdminUser identity — req.adminUser
 * is unset) is treated as OWNER-equivalent for backward compatibility, since
 * possession of the tenant/super-admin key already implies full access under
 * the pre-existing auth model. An AdminUser Bearer session is held strictly
 * to its actual role.
 */
export function requireRole(minRole) {
  const ROLE_RANK = { STAFF: 1, MANAGER: 2, OWNER: 3 };
  const minRank   = ROLE_RANK[minRole] ?? Infinity;

  return function roleGate(req, res, next) {
    if (!req.adminUser) return next(); // legacy x-api-key caller — OWNER-equivalent

    const rank = ROLE_RANK[req.adminUser.role] ?? 0;
    if (rank >= minRank) return next();

    logger.warn('[Auth] Insufficient admin role', {
      path: req.path, role: req.adminUser.role, required: minRole,
    });
    return res.status(403).json({ error: `Forbidden — requires ${minRole} role` });
  };
}

/**
 * requireApiKey — accepts either:
 *   a) An AdminUser Bearer session token (see tryBearerAuth above)
 *   b) SUPER_ADMIN_API_KEY (master key)
 *   c) A valid tenant API key (looked up by SHA-256 hash in Tenant collection)
 *
 * Sets req.tenant when a tenant key is used so downstream routes can use it.
 */
export async function requireApiKey(req, res, next) {
  try {
    if (await tryBearerAuth(req)) return next();
  } catch (err) {
    logger.error('[Auth] Bearer session lookup failed', { err: err.message });
    return res.status(500).json({ error: 'Internal server error' });
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
