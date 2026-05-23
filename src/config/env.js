/**
 * config/env.js — WhatSalesAgent2
 *
 * DEPLOYMENT FIX: validateEnv() now distinguishes between boot-critical vars
 * (missing them = can't run at all) and feature-critical vars (missing them =
 * that specific feature is disabled but the server still starts and health passes).
 *
 * Boot-critical:     MONGODB_URI, SUPER_ADMIN_API_KEY
 * Feature-critical:  ENCRYPTION_KEY, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN
 *                    (warn but do NOT crash — lets Railway healthcheck pass)
 *
 * Why: Railway runs healthcheck against /health after deploy. If process.exit(1)
 * fires before app.listen(), /health never responds and the deploy is marked failed
 * even when the code is correct. Operators set env vars separately on the dashboard
 * and may not have all of them ready on first deploy.
 */
import { config } from 'dotenv';

config({ path: `.env.${process.env.NODE_ENV || 'development'}.local` });
config({ path: '.env', override: false });

export const { NODE_ENV, PORT, MONGODB_URI, SUPER_ADMIN_API_KEY, BASE_URL, LOG_LEVEL, CORS_ORIGIN } = process.env;
export const { GROQ_API_KEY, OPENAI_API_KEY } = process.env;
export const { META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN } = process.env;
export const { SIMULATION_MODE, SIMULATION_SECRET } = process.env;
export const { ENCRYPTION_KEY } = process.env;
export const { SCHEDULER_ENABLED, ADMIN_PHONES } = process.env;
export const { TEMPLATE_LANGUAGE = 'en' } = process.env;
export const { DISABLE_WORKING_HOURS = 'false' } = process.env;

export function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors   = [];   // Fatal — crashes process
  const warnings = [];   // Non-fatal — logs warning, server still starts

  // ── Always required ───────────────────────────────────────────────────────
  if (!process.env.MONGODB_URI)          errors.push('MONGODB_URI is required');
  if (!process.env.SUPER_ADMIN_API_KEY)  errors.push('SUPER_ADMIN_API_KEY is required');

  if (isProduction) {
    // ── Security warnings (not fatal — server can start without them) ───────
    if (!process.env.ENCRYPTION_KEY) {
      warnings.push('ENCRYPTION_KEY not set — at-rest encryption disabled. Set a 32-char key to enable.');
    } else if (process.env.ENCRYPTION_KEY.length !== 32) {
      warnings.push(`ENCRYPTION_KEY must be exactly 32 characters (got ${process.env.ENCRYPTION_KEY.length}) — encryption disabled.`);
    }

    // ── Webhook warnings ─────────────────────────────────────────────────────
    if (!process.env.META_WEBHOOK_VERIFY_TOKEN) {
      warnings.push('META_WEBHOOK_VERIFY_TOKEN not set — webhook verification will fail until set.');
    }
    if (!process.env.META_APP_SECRET) {
      warnings.push('META_APP_SECRET not set — webhook signature verification disabled (insecure for production).');
    }

    if (process.env.SIMULATION_MODE === 'true') {
      warnings.push('SIMULATION_MODE=true in production — disable before going live.');
    }

    const placeholders = [
      'change_me_to_a_strong_random_string',
      'change_me_to_a_long_random_string_at_least_32_chars',
    ];
    if (placeholders.includes(process.env.SUPER_ADMIN_API_KEY)) {
      errors.push('SUPER_ADMIN_API_KEY is still the default placeholder — change it immediately');
    }
  } else {
    if (!process.env.ENCRYPTION_KEY) {
      warnings.push('ENCRYPTION_KEY not set — encryption-dependent features skipped in dev.');
    }
  }

  // Print warnings (non-fatal)
  if (warnings.length) {
    console.warn('\n[Startup] Configuration warnings (server will still start):\n' +
      warnings.map(w => `  ⚠  ${w}`).join('\n') + '\n');
  }

  // Fatal errors — crash fast
  if (errors.length) {
    console.error('\n[Startup] FATAL — cannot start:\n' +
      errors.map(e => `  ✗ ${e}`).join('\n') + '\n');
    process.exit(1);
  }
}
