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
import { verifySessionToken } from '../services/admin/adminAuthService.js';

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
 * tryBearerAuth — [FEATURE-MULTIADMIN-1] Verifies an `Authorization: Bearer <token>`
 * header against an AdminUser session token, without ever throwing.
 *
 * Returns the matching AdminUser (as a plain object: { id, name, role, tenantId })
 * on success, or null if the header is absent, the token is invalid/expired/tampered,
 * or the underlying AdminUser has since been removed or DISABLED (revocation must
 * take effect immediately, not just at the token's own expiry — so this always hits
 * the DB rather than trusting the token payload's embedded role/tenantId alone).
 */
export async function tryBearerAuth(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;

  const token = header.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) return null;

  try {
    const admin = await AdminUser.findById(payload.sub)
      .select('name role status tenantId').lean();
    if (!admin || admin.status !== 'ACTIVE') return null;
    // Defense in depth: the session was signed for a specific tenant — if the
    // AdminUser has somehow moved tenants since (shouldn't happen, but the
    // token's own claim is untrusted data) refuse rather than trust the token.
    if (String(admin.tenantId) !== String(payload.tenantId)) return null;
    return { id: String(admin._id), name: admin.name, role: admin.role, tenantId: String(admin.tenantId) };
  } catch (err) {
    logger.error('[Auth] Bearer session lookup failed', { err: err.message });
    return null;
  }
}

/**
 * requireApiKey — accepts any of:
 *   a) An AdminUser Bearer session token (Authorization: Bearer <token>) —
 *      sets req.adminUser and req.tenantId for an individually-identified caller.
 *   b) SUPER_ADMIN_API_KEY (master key, legacy x-api-key header)
 *   c) A valid tenant API key (looked up by SHA-256 hash in Tenant collection)
 *
 * Sets req.tenant when a tenant key is used so downstream routes can use it.
 */
export async function requireApiKey(req, res, next) {
  // [FEATURE-MULTIADMIN-1] Bearer session takes priority when present — it's
  // the more specific, individually-identified credential. An invalid/expired
  // Bearer token is rejected outright rather than silently falling through to
  // the x-api-key check below; silently downgrading a bad session token to
  // "unauthenticated, try the next method" would mask expiry/revocation bugs
  // behind a confusing generic 401 instead of a clear one.
  if (req.headers['authorization']) {
    const admin = await tryBearerAuth(req);
    if (!admin) {
      logger.warn('[Auth] Invalid or expired admin session', { path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Unauthorized — session is invalid or has expired' });
    }
    const tenant = await Tenant.findById(admin.tenantId).select('status').lean().catch(() => null);
    if (!tenant || tenant.status === 'SUSPENDED') {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }
    req.adminUser    = { id: admin.id, name: admin.name, role: admin.role };
    req.tenant       = tenant;
    req.tenantId     = admin.tenantId;
    req.isSuperAdmin = false;
    return next();
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

// [FEATURE-MULTIADMIN-1] Ordered so a higher role satisfies a lower requirement
// (e.g. an OWNER passes requireRole('MANAGER')) rather than requiring an exact match.
const ROLE_RANK = { STAFF: 1, MANAGER: 2, OWNER: 3 };

/**
 * requireRole(minRole) — gates a route to AdminUsers with at least the given
 * role. Must run after requireApiKey.
 *
 * A legacy x-api-key caller (super-admin or tenant key — no individual
 * AdminUser identity, so req.adminUser is unset) bypasses this check and is
 * treated as OWNER-equivalent, matching the pre-existing behavior where a
 * shared tenant key could do anything a dashboard user could. This keeps
 * server-to-server/script callers working unchanged; only Bearer-session
 * (individually-identified) callers are actually role-checked.
 */
export function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  if (!minRank) {
    throw new Error(`requireRole: unknown role "${minRole}"`);
  }
  return (req, res, next) => {
    if (!req.adminUser) {
      // Legacy x-api-key caller (isSuperAdmin or tenant key) — OWNER-equivalent.
      return next();
    }
    const rank = ROLE_RANK[req.adminUser.role] || 0;
    if (rank < minRank) {
      logger.warn('[Auth] Insufficient role', {
        path: req.path, role: req.adminUser.role, required: minRole,
      });
      return res.status(403).json({ error: `Forbidden — requires ${minRole} role or higher` });
    }
    next();
  };
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
