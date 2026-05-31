/**
 * config/env.js — WhatSalesAgent2 (Production)
 *
 * Centralised environment loading with mandatory validation.
 * In production, missing critical vars crash fast on startup —
 * better to fail loud at boot than silently at runtime.
 */
import { config } from 'dotenv';

// Load env-specific overrides first (.env.production.local), then base .env
config({ path: `.env.${process.env.NODE_ENV || 'development'}.local` });
config({ path: '.env', override: false });

// ── Exported env vars ─────────────────────────────────────────────────────────
export const { NODE_ENV, PORT, MONGODB_URI, SUPER_ADMIN_API_KEY, BASE_URL, LOG_LEVEL, CORS_ORIGIN } = process.env;
export const { GROQ_API_KEY, OPENAI_API_KEY } = process.env;
export const { META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, META_WHATSAPP_TOKEN, META_API_VERSION } = process.env;
export const { SIMULATION_MODE, SIMULATION_SECRET } = process.env;
export const { ENCRYPTION_KEY } = process.env;
export const { SCHEDULER_ENABLED, ADMIN_PHONES } = process.env;
export const { TEMPLATE_LANGUAGE = 'en' } = process.env;
export const { DISABLE_WORKING_HOURS = 'false' } = process.env;
export const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_PRESET } = process.env;

// ── Production validation ─────────────────────────────────────────────────────
// Called by app.js before any I/O — crashes fast if critical vars are absent.
export function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors = [];

  // Always required in every environment
  const alwaysRequired = ['MONGODB_URI', 'SUPER_ADMIN_API_KEY'];
  for (const key of alwaysRequired) {
    if (!process.env[key]) errors.push(`Missing required env var: ${key}`);
  }

  if (isProduction) {
    // ENCRYPTION_KEY is mandatory and must be exactly 32 chars in production
    if (!process.env.ENCRYPTION_KEY) {
      errors.push('Missing required env var: ENCRYPTION_KEY');
    } else if (process.env.ENCRYPTION_KEY.length !== 32) {
      errors.push('ENCRYPTION_KEY must be exactly 32 characters');
    }

    // In production, simulation mode must be OFF and Meta creds must be set
    if (process.env.SIMULATION_MODE === 'true') {
      errors.push('SIMULATION_MODE must be false in production');
    }
    if (!process.env.META_WEBHOOK_VERIFY_TOKEN) {
      errors.push('Missing required env var: META_WEBHOOK_VERIFY_TOKEN');
    }
    if (!process.env.META_APP_SECRET) {
      errors.push('Missing required env var: META_APP_SECRET');
    }
    // [FIX-SHARED-APP] Required: the system-user permanent access token used to send
    // messages for all tenants. Get it from Meta Business Suite → System Users →
    // your system user → Generate Token (needs whatsapp_business_messaging permission).
    if (!process.env.META_WHATSAPP_TOKEN) {
      errors.push('Missing required env var: META_WHATSAPP_TOKEN — your Meta system-user permanent access token');
    }

    // Warn on insecure placeholder defaults
    const placeholders = [
      'change_me_to_a_strong_random_string',
      'change_me_to_a_long_random_string_at_least_32_chars',
    ];
    if (placeholders.includes(process.env.SUPER_ADMIN_API_KEY)) {
      errors.push('SUPER_ADMIN_API_KEY is still the default placeholder — change it');
    }
  } else {
    // Development — ENCRYPTION_KEY optional but warn if missing (some flows need it)
    if (!process.env.ENCRYPTION_KEY) {
      console.warn('\n[Startup] Warning: ENCRYPTION_KEY not set — encryption-dependent features will be skipped in dev.\n');
    } else if (process.env.ENCRYPTION_KEY.length !== 32) {
      console.warn('\n[Startup] Warning: ENCRYPTION_KEY must be exactly 32 characters. Some features may fail.\n');
    }
  }

  if (errors.length) {
    console.error('\n[Startup] Environment validation failed:\n' + errors.map(e => `  ✗ ${e}`).join('\n') + '\n');
    process.exit(1);
  }
}
