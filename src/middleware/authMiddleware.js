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
 * requireApiKey — accepts either:
 *   a) SUPER_ADMIN_API_KEY (master key)
 *   b) A valid tenant API key (looked up by SHA-256 hash in Tenant collection)
 *
 * Sets req.tenant when a tenant key is used so downstream routes can use it.
 */
export async function requireApiKey(req, res, next) {
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

  // Per-tenant key lookup via SHA-256 hash
  try {
    const hash   = crypto.createHash('sha256').update(key).digest('hex');
    const tenant = await Tenant.findOne({ apiKeyHash: hash, status: { $in: ['ACTIVE', 'PENDING'] } }).lean(); // [FIX-AUTH-1] PENDING tenants must also auth so they can complete setup
    if (tenant) {
      req.tenant      = tenant;
      req.tenantId    = String(tenant._id);
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
