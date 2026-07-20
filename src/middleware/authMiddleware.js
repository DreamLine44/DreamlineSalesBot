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
import { verifySessionToken } from '../services/adminAuthService.js';
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
 * tryBearerAuth — checks for an `Authorization: Bearer <token>` header and,
 * if present and valid, sets req.adminUser / req.tenantId / req.isSuperAdmin
 * and returns true. Returns false (without touching res) for anything else —
 * missing header, malformed token, expired/tampered signature, or an
 * AdminUser that no longer exists / has been DISABLED since the token was
 * issued — so the caller (requireApiKey) can fall through to the legacy
 * x-api-key path rather than immediately failing the request.
 *
 * [FEATURE-MULTIADMIN-1] This is the missing half of the individual-admin-
 * login feature: adminAuthService.js (session token sign/verify) and
 * adminUserController.js/adminUserRoutes.js (login, invite, staff CRUD) were
 * already fully built, but nothing ever actually verified the Bearer token
 * on incoming requests — every route gated behind requireApiKey that expects
 * req.adminUser (me(), requireRole()) would have silently seen req.adminUser
 * as undefined forever.
 */
async function tryBearerAuth(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return false;

  const token   = header.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) return false;

  try {
    const admin = await AdminUser.findById(payload.sub).select('name role status tenantId').lean();
    if (!admin || admin.status !== 'ACTIVE') return false;
    // Defensive: the token embeds tenantId at issue time, but re-derive from
    // the live AdminUser doc as the source of truth in case of a future
    // cross-tenant transfer feature — never trust the token's copy alone for
    // anything security-relevant beyond who this token was issued to.
    if (String(admin.tenantId) !== String(payload.tenantId)) return false;

    req.adminUser   = { id: String(admin._id), name: admin.name, role: admin.role };
    req.tenantId    = String(admin.tenantId);
    req.isSuperAdmin = false;
    return true;
  } catch (err) {
    logger.error('[Auth] Bearer AdminUser lookup failed', { err: err.message });
    return false;
  }
}

/**
 * requireApiKey — accepts either:
 *   a) An `Authorization: Bearer <session token>` for an individual AdminUser
 *      login (see services/adminAuthService.js, controllers/adminUserController.js)
 *   b) SUPER_ADMIN_API_KEY (master key)
 *   c) A valid tenant API key (looked up by SHA-256 hash in Tenant collection)
 *
 * Sets req.tenant when a tenant key is used, or req.adminUser when a Bearer
 * session is used, so downstream routes can tell which kind of caller this is.
 */
export async function requireApiKey(req, res, next) {
  // [FEATURE-MULTIADMIN-1] Bearer checked first — an AdminUser session is the
  // more specific, individually-revocable identity. Falls through to the
  // legacy x-api-key path below on ANY failure (missing header, expired
  // token, disabled account, etc.) rather than rejecting immediately, so a
  // request bearing a stale Bearer token but a still-valid x-api-key isn't
  // needlessly blocked.
  if (await tryBearerAuth(req)) return next();

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
 * requireRole(...allowedRoles) — gates a route to specific AdminUser roles.
 *
 * [FEATURE-MULTIADMIN-1] Per adminUserRoutes.js's own documented policy: a
 * legacy x-api-key caller (req.adminUser is unset — no individual identity)
 * is treated as OWNER-equivalent for backward compatibility and always
 * passes, since possession of the tenant's shared key already implies full
 * access under the pre-existing auth model. An AdminUser Bearer session,
 * however, is checked strictly against req.adminUser.role — no bypass.
 *
 * Must run AFTER requireApiKey (and enforceTenantScope) in the route's
 * middleware chain, since it depends on req.adminUser / req.isSuperAdmin
 * already being set.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (req.isSuperAdmin) return next();
    if (!req.adminUser) return next(); // legacy x-api-key caller — OWNER-equivalent
    if (!allowedRoles.includes(req.adminUser.role)) {
      return res.status(403).json({ error: `Forbidden — requires one of: ${allowedRoles.join(', ')}` });
    }
    return next();
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
