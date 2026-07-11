/**
 * middleware/authMiddleware.js — WhatSalesAgent2 (Production)
 *
 * Changes from dev:
 *  - requireApiKey now also accepts per-tenant API keys (apiKeyHash lookup),
 *    not just the global SUPER_ADMIN_API_KEY. This means tenants can call
 *    /business and /dashboard routes with their own keys.
 *  - Constant-time comparison (timingSafeEqual) to prevent timing attacks.
 *  - Request logging on auth failure for security auditing.
 *  - [FEATURE-MULTIADMIN-1] requireApiKey now ALSO accepts an
 *    `Authorization: Bearer <token>` AdminUser session token, additively —
 *    the x-api-key path is completely unchanged, so every existing
 *    integration (Bruno, scripts, the Super Admin Console) keeps working
 *    with zero changes. A Bearer token sets req.adminUser (role-bearing) in
 *    addition to req.tenantId, so downstream routes can layer requireRole()
 *    for staff-permission checks that a shared tenant API key has no concept
 *    of (a legacy x-api-key caller is always treated as OWNER-equivalent —
 *    it predates the role system and has always implied full access).
 */
import crypto from 'crypto';
import Tenant     from '../models/Tenant.js';
import AdminUser   from '../models/AdminUser.js';
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
 * [FEATURE-MULTIADMIN-1] Validate an AdminUser Bearer session token and, if
 * valid, populate req.tenantId/req.tenant/req.adminUser. Returns true if it
 * handled (and ended, via next()) the request, false if the caller should
 * fall through to the x-api-key check instead.
 */
async function tryBearerAuth(req, res) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const token   = authHeader.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) {
    logger.warn('[Auth] Invalid or expired admin session token', { path: req.path, ip: req.ip });
    res.status(401).json({ error: 'Unauthorized — session expired or invalid, please log in again' });
    return true;
  }

  // Re-check the live AdminUser record, not just the token payload — a
  // DISABLED/deleted admin must be rejected immediately even if their token
  // hasn't expired yet. Tokens are bearer-only revocation happens here, not
  // via a token blocklist (keeps verifySessionToken itself stateless/fast).
  const adminUser = await AdminUser.findById(payload.sub).lean().catch(() => null);
  if (!adminUser || adminUser.status !== 'ACTIVE' || String(adminUser.tenantId) !== payload.tenantId) {
    logger.warn('[Auth] Admin session token valid but account no longer active', { path: req.path, sub: payload.sub });
    res.status(401).json({ error: 'Unauthorized — your access has been revoked' });
    return true;
  }

  const tenant = await Tenant.findById(adminUser.tenantId).lean().catch(() => null);
  if (!tenant || tenant.status === 'SUSPENDED') {
    res.status(403).json({ error: 'Account suspended. Contact support.' });
    return true;
  }

  req.tenant       = tenant;
  req.tenantId     = String(tenant._id);
  req.isSuperAdmin = false;
  req.adminUser    = { id: String(adminUser._id), role: adminUser.role, name: adminUser.name };
  return 'next';
}

/**
 * requireApiKey — accepts either:
 *   a) SUPER_ADMIN_API_KEY (master key)
 *   b) A valid tenant API key (looked up by SHA-256 hash in Tenant collection)
 *   c) [FEATURE-MULTIADMIN-1] An AdminUser session token (Authorization: Bearer ...)
 *
 * Sets req.tenant when a tenant key or admin session is used so downstream
 * routes can use it. req.adminUser is only set for (c) — routes that need to
 * distinguish "which staff member" or enforce role checks should use
 * requireRole() below, which treats (a)/(b) as implicitly full-access for
 * backward compatibility.
 */
export async function requireApiKey(req, res, next) {
  // [FEATURE-MULTIADMIN-1] Try Bearer auth first if present — a request
  // should never carry both an Authorization header and x-api-key, but if it
  // does, Bearer wins since it's the more specific, individually-revocable
  // credential.
  if (req.headers['authorization']) {
    const bearerResult = await tryBearerAuth(req, res);
    if (bearerResult === 'next') return next();
    if (bearerResult === true) return; // response already sent (401/403)
    // false — no Authorization header after all, fall through to x-api-key
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
 * [FEATURE-MULTIADMIN-1] requireRole(...roles) — layer AFTER requireApiKey
 * on routes that should be restricted to specific AdminUser roles (e.g.
 * inviting/removing other admins, changing WhatsApp credentials).
 *
 * Backward-compat rule: req.isSuperAdmin and legacy x-api-key tenant auth
 * (req.tenantId set but req.adminUser absent) both bypass the role check
 * entirely — a shared tenant API key predates the role system and has
 * always implied full OWNER-equivalent access. Only requests authenticated
 * via an AdminUser Bearer token (req.adminUser present) are actually
 * subject to the role whitelist.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.isSuperAdmin) return next();
    if (!req.adminUser) return next(); // legacy tenant API key — full access
    if (roles.includes(req.adminUser.role)) return next();
    logger.warn('[Auth] Role check failed', { path: req.path, role: req.adminUser.role, required: roles });
    return res.status(403).json({ error: `Forbidden — requires one of: ${roles.join(', ')}` });
  };
}
