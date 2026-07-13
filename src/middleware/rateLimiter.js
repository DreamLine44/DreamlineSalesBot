/**
 * middleware/rateLimiter.js — WhatSalesAgent2 (Production)
 *
 * Changes from dev:
 *  - Rate limiting is NEVER skipped in production regardless of SIMULATION_MODE.
 *  - Webhook endpoint gets its own strict limiter (Meta sends bursts; we trust
 *    X-Hub-Signature verification, not rate limits, for auth there).
 *  - Admin routes get tighter limits.
 *  - keyGenerator uses X-Forwarded-For via trust proxy (set in app.js).
 */
import rateLimit from 'express-rate-limit';

const isProduction = () => process.env.NODE_ENV === 'production';

export function createRateLimiter(maxPerMinute = 120) {
  return rateLimit({
    windowMs: 60 * 1000,
    max: maxPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down.' },
    // Only skip in non-production simulation (dev/test convenience)
    skip: (req) =>
      !isProduction() &&
      process.env.SIMULATION_MODE === 'true',
  });
}

/** Generous limiter for the Meta webhook — Meta can send bursts of messages */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Webhook rate limit exceeded.' },
});

/** Tight limiter for authentication-sensitive admin routes */
export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests.' },
});

/**
 * Limiter for high-frequency polling endpoints hit by the frontend on timers:
 *   - GET /dashboard/:tenantId/overview  (DashboardPage, every 120s)
 *   - GET /admin/sessions/:tenantId      (SessionsPage, every 60s)
 *
 * 30 req/min per IP is generous for a single browser tab (1 req/60s) while
 * blocking runaway loops, misconfigured clients, or scrapers.
 */
export const overviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many polling requests — please wait a moment.' },
});

/**
 * Extra-strict limiter for the humanMode toggle endpoint.
 * The toggle directly affects bot silence — rapid toggling could be used to
 * expose the bot to a customer mid-human-mode. 5 req/min is sufficient for
 * legitimate use (an admin resuming a handful of customers) and blocks abuse.
 */
export const humanModeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many humanMode toggle requests — please slow down.' },
});

/**
 * [CATALOG-SYNC-ROUTE-1] Limiter for POST /:tenantId/wacatalog/sync.
 * Each call hits Meta's Catalog Batch API with the tenant's full menuItems
 * list in one request — a legitimate admin re-sync after editing the menu
 * is an occasional action, not a polling endpoint, so 5 req/min (same budget
 * as humanModeLimiter) is generous for real use and blocks accidental or
 * scripted hammering of an external Graph API call that Meta itself rate-limits.
 */
/**
 * [ADMIN-NOTIFY-1] Limiter for POST /admin/notifications (sending a message
 * or broadcast). Sending is an occasional, human-triggered action, not a
 * polling endpoint — 10 req/min is generous for a real admin composing a
 * few messages in a row while blocking accidental double-submits or a
 * scripted spam loop. A broadcast is one request regardless of how many
 * tenants it fans out to, so this limiter caps *sends*, not recipients.
 */
export const notificationSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages sent — please wait a moment.' },
});

export const catalogSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many catalog sync requests — please wait a moment.' },
});
