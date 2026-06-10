/**
 * middleware/webhookSignature.js — WhatSalesAgent2 (Production)
 *
 * RESPONSIBILITY: capture req.rawBody for downstream HMAC verification.
 *
 * [META-CREDS] Multi-tenant credential upgrade — signature verification
 * MOVED from this middleware into webhookController.receiveWebhook().
 *
 * WHY: HMAC verification is per-tenant (each tenant has their own Meta App Secret),
 * but the tenant cannot be identified until the webhook body is parsed and
 * phoneNumberId is extracted. Verifying here — before tenant resolution — requires
 * using a single global secret, which defeats the purpose of per-tenant isolation.
 *
 * NEW FLOW:
 *   1. This middleware captures req.rawBody (unchanged from before).
 *   2. receiveWebhook() parses phoneNumberId → looks up tenant → resolves
 *      tenant.meta.appSecret (falls back to META_APP_SECRET env var) →
 *      verifies HMAC → rejects with 403 on mismatch.
 *
 * BACKWARD COMPATIBILITY:
 *   The global META_APP_SECRET env var is still supported as a platform-wide
 *   fallback. Tenants that have not yet had meta.appSecret populated continue
 *   to work using the global secret. This means zero downtime during migration.
 *
 * NOTE: verifyMetaSignature() is kept as a named export for backward compat
 * (it may be referenced in tests or third-party integrations). It is now a
 * pass-through that only captures rawBody; actual HMAC logic lives in the
 * controller.
 */
import logger from '../config/logger.js';

/**
 * Raw body capturer — MUST be mounted before body-parser on the webhook route.
 *
 * Sets req.rawBody (Buffer) so that receiveWebhook() can verify the
 * X-Hub-Signature-256 header against each tenant's own app secret.
 *
 * app.js already handles this via the express.raw() + express.json() dual
 * parser setup — this function is kept as a named export for explicit use
 * in tests and for documentation clarity.
 */
export function verifyMetaSignature(req, res, next) {
  // rawBody is set by app.js's express.raw({ type: '*/*' }) parser on the
  // /webhook route. If it's already present, nothing to do here.
  if (!req.rawBody) {
    // Capture raw body if somehow not yet set (safety net).
    // In normal operation this branch is never taken.
    logger.warn('[Webhook] rawBody missing on webhook route — raw body parser may not be configured');
  }
  // Actual HMAC verification happens in receiveWebhook() after tenant resolution.
  next();
}
