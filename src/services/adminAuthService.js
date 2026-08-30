/**
 * services/adminAuthService.js
 *
 * [FEATURE-MULTIADMIN-1] Password hashing and session tokens for AdminUser
 * logins. Deliberately built on Node's built-in `crypto` only — no bcrypt/
 * jsonwebtoken dependency — matching how tenantController.js already does
 * AES-256-GCM token encryption and timingSafeEqual comparison by hand rather
 * than pulling in a library. Keeps this feature deployable without touching
 * package.json at all.
 *
 * Session tokens are a simple signed-and-stamped opaque token, NOT a JWT:
 *   base64url(payloadJSON) + '.' + hex(HMAC-SHA256(payloadJSON, secret))
 * This is intentionally simpler than JWT (no alg-confusion surface, no
 * library to keep patched) while providing the same two properties that
 * matter here: tamper-evidence and an embedded expiry.
 */
import crypto from 'crypto';
import logger from '../config/logger.js';

const SCRYPT_KEYLEN = 64;

function getSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    // [FEATURE-MULTIADMIN-1] Fail loudly in a way that's easy to grep for in
    // logs rather than silently signing tokens with a predictable fallback —
    // unlike encryptToken's "store in plaintext (dev only)" fallback, a weak
    // session-signing secret is a full account-takeover risk, not a reduced-
    // confidentiality one, so this should be treated as a deploy-blocking
    // misconfiguration rather than a soft warning.
    logger.error('[AdminAuth] ADMIN_SESSION_SECRET is not set — admin login is disabled until it is configured.');
    throw new Error('ADMIN_SESSION_SECRET is not configured on this server.');
  }
  return secret;
}

// ── Passwords ──────────────────────────────────────────────────────────────

/** Returns { salt, hash } — both hex strings. Store both on the AdminUser doc. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

/** Constant-time verification against a stored { passwordSalt, passwordHash }. */
export function verifyPassword(password, passwordSalt, passwordHash) {
  if (!passwordSalt || !passwordHash) return false;
  const candidate  = crypto.scryptSync(password, passwordSalt, SCRYPT_KEYLEN);
  const storedBuf  = Buffer.from(passwordHash, 'hex');
  if (candidate.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(candidate, storedBuf);
}

// ── Invite tokens ────────────────────────────────────────────────────────────
// Same "never store the raw secret" pattern as Tenant.apiKeyHash: the plaintext
// token is shown once (in the invite link), only its SHA-256 hash is stored.

export function generateInviteToken() {
  const raw  = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function hashInviteToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Session tokens ───────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Creates a signed session token for a given AdminUser. */
export function createSessionToken(adminUser, ttlMs = DEFAULT_TTL_MS) {
  const payload = {
    sub:       String(adminUser._id),
    tenantId:  String(adminUser.tenantId),
    role:      adminUser.role,
    exp:       Date.now() + ttlMs,
  };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadStr).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies and decodes a session token. Returns the payload
 * ({ sub, tenantId, role, exp }) or null if invalid/expired/tampered.
 * Never throws — auth middleware treats null as "not authenticated".
 */
export function verifySessionToken(token) {
  try {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payloadB64, sig] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(payloadB64).digest('hex');

    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
