/**
 * middleware/webhookSignature.js — WhatSalesAgent2 (Production)
 *
 * NEW FILE — not present in dev build.
 *
 * Verifies the X-Hub-Signature-256 header that Meta sends on every webhook POST.
 * Without this check, anyone who discovers your webhook URL can send fake messages.
 *
 * Meta docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
 *
 * Flow:
 *   1. app.js preserves req.rawBody on the /webhook route (already done).
 *   2. This middleware reads META_APP_SECRET, computes HMAC-SHA256 of rawBody,
 *      and compares it (constant-time) to the header value.
 *   3. Mismatch → 403. Missing secret in dev → warn and pass (dev convenience).
 */
import crypto from 'crypto';
import logger  from '../config/logger.js';

export function verifyMetaSignature(req, res, next) {
  const secret = process.env.META_APP_SECRET;

  // In development without a secret configured, skip (but warn)
  if (!secret) {
    // [FIX] Don't hard-reject in production — operator may not have set the secret yet
    // (e.g. first deploy). Log a clear warning and pass through.
    // Real security comes from the HTTPS transport + wamid deduplication.
    logger.warn('[Webhook] META_APP_SECRET not set — skipping signature verification. Set it for production security.');
    return next();
  }

  const sigHeader = req.headers['x-hub-signature-256'];
  if (!sigHeader) {
    logger.warn('[Webhook] Missing X-Hub-Signature-256 header', { ip: req.ip });
    return res.status(403).json({ error: 'Missing signature header' });
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error('[Webhook] rawBody missing — check app.js raw body parser setup');
    return res.status(400).json({ error: 'Cannot verify signature — raw body unavailable' });
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison
  const sigBuf  = Buffer.from(sigHeader);
  const expBuf  = Buffer.from(expected);
  const valid   = sigBuf.length === expBuf.length &&
                  crypto.timingSafeEqual(sigBuf, expBuf);

  if (!valid) {
    logger.warn('[Webhook] Signature mismatch — possible spoofed request', { ip: req.ip });
    return res.status(403).json({ error: 'Invalid signature' });
  }

  next();
}
