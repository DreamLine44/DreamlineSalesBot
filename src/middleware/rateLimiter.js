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
