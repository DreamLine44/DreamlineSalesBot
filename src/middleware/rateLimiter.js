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
 * Strict limiter for the WA Catalog manual sync endpoint — each call hits
 * Meta's Graph API items_batch endpoint, so this must stay tight regardless
 * of how generous the tenant's other business-config limits are.
 */
export const catalogSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many catalog sync requests — please wait a moment.' },
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
