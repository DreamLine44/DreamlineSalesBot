/**
 * services/cryptoService.js — Dreamline Sales Bot v11.0
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  CREDENTIAL ENCRYPTION SERVICE                                  ║
 * ║                                                                 ║
 * ║  Encrypts/decrypts sensitive credentials (WhatsApp accessToken) ║
 * ║  using AES-256-GCM — authenticated encryption.                 ║
 * ║                                                                 ║
 * ║  SETUP:                                                         ║
 * ║  1. Generate a 32-byte key:                                     ║
 * ║     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * ║  2. Set ENCRYPTION_KEY=<64 hex chars> in your .env             ║
 * ║  3. Run: npm run migrate-encrypt-tokens                         ║
 * ║                                                                 ║
 * ║  SAFE-DEGRADATION:                                              ║
 * ║  If ENCRYPTION_KEY is not set, tokens are stored/returned       ║
 * ║  as plaintext and a warning is logged on startup.               ║
 * ║  This preserves backward compatibility for existing deploys.   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import logger from '../config/logger.js';

// ─── Key setup ────────────────────────────────────────────────────────────────

const RAW_KEY = process.env.ENCRYPTION_KEY;
let KEY_BUFFER = null;

if (RAW_KEY) {
  if (RAW_KEY.length !== 64) {
    logger.warn('[CryptoService] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Encryption disabled.');
  } else {
    try {
      KEY_BUFFER = Buffer.from(RAW_KEY, 'hex');
      logger.info('[CryptoService] Credential encryption enabled.');
    } catch {
      logger.warn('[CryptoService] ENCRYPTION_KEY is not valid hex. Encryption disabled.');
    }
  }
} else {
  logger.warn('[CryptoService] ENCRYPTION_KEY not set — credentials stored as plaintext. Set this env var for production security.');
}

// ─── Encryption ───────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a colon-delimited string: iv:authTag:ciphertext (all hex).
 *
 * If ENCRYPTION_KEY is not set, returns the plaintext unchanged.
 *
 * @param {string} plaintext
 * @returns {string}
 */
export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  if (!KEY_BUFFER) return plaintext; // graceful degradation

  const iv     = randomBytes(12); // 96-bit nonce — optimal for GCM
  const cipher = createCipheriv('aes-256-gcm', KEY_BUFFER, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag(); // 128-bit authentication tag

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypt a string produced by encrypt().
 * Returns the original plaintext.
 *
 * If ENCRYPTION_KEY is not set, returns the value unchanged (backward-compat).
 * If the value doesn't look encrypted (no colons), returns it unchanged —
 * handles pre-encryption plaintext tokens during migration.
 *
 * @param {string} value
 * @returns {string}
 */
export function decrypt(value) {
  if (!value) return value;
  if (!KEY_BUFFER) return value; // graceful degradation

  // If it doesn't look like an encrypted token (legacy plaintext), return as-is.
  // Encrypted format: "hex:hex:hex" — always three colon-separated segments.
  const parts = value.split(':');
  if (parts.length !== 3) return value;

  try {
    const [ivHex, tagHex, encHex] = parts;

    const decipher = createDecipheriv('aes-256-gcm', KEY_BUFFER, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (err) {
    logger.error('[CryptoService] Decryption failed — returning raw value. Check ENCRYPTION_KEY.', { error: err.message });
    return value; // safe fallback
  }
}

/**
 * Check whether a stored token value appears to be already encrypted.
 * Used by the migration script to skip already-encrypted values.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
  if (!value) return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  // Each part should be valid hex
  return parts.every(p => /^[0-9a-f]+$/i.test(p));
}
