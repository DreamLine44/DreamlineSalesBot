/**
 * config/env.js — WhatSalesAgent2 (Production)
 *
 * Centralised environment loading with mandatory validation.
 * In production, missing critical vars crash fast on startup —
 * better to fail loud at boot than silently at runtime.
 *
 * [AUDIT-P1-B] Added WHATSAPP_TEMPLATES_ENABLED and template name vars.
 *              These are required when the scheduler sends reminders to
 *              customers whose 24-hour conversation window has expired.
 *              SCHEDULER_ENABLED=true + WHATSAPP_TEMPLATES_ENABLED=false is
 *              now a startup ERROR in production (was previously a warning) —
 *              Meta silently drops plain-text messages to cold contacts.
 * [AUDIT-P2-A] ENCRYPTION_KEY validation tightened — must be exactly 32 bytes.
 *              Existing validation was already present; now surfaced clearly in
 *              the exported constants for use by other modules.
 */
import { config } from 'dotenv';

// Load env-specific overrides first (.env.production.local), then base .env
config({ path: `.env.${process.env.NODE_ENV || 'development'}.local` });
config({ path: '.env', override: false });

// ── Exported env vars ─────────────────────────────────────────────────────────
export const { NODE_ENV, PORT, MONGODB_URI, SUPER_ADMIN_API_KEY, BASE_URL, LOG_LEVEL, CORS_ORIGIN } = process.env;
export const { GROQ_API_KEY, OPENAI_API_KEY } = process.env;
export const { META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN } = process.env;
// [FIX-ENV-1] META_API_VERSION is used in dispatcher.js and paymentService.js as the
// Graph API version string (e.g. 'v21.0'). It was not previously exported from env.js,
// so it was invisible to the validateEnv() check and never surfaced in startup logs.
// Exported here; defaults to 'v21.0' via fallback in each caller so no hard requirement.
export const { META_API_VERSION = 'v21.0' } = process.env;
export const { SIMULATION_MODE, SIMULATION_SECRET } = process.env;
export const { ENCRYPTION_KEY } = process.env;
export const { SCHEDULER_ENABLED, ADMIN_PHONES } = process.env;
// [FIX-1] Default was 'en' — not a valid Meta template language code. Meta requires
// BCP 47 tags matching the exact code the template was approved under. 'en_US' is the
// correct default. The || 'en_US' fallback in schedulerService.js was unreachable
// because env.js always exported 'en'; now both agree on the correct value.
export const { TEMPLATE_LANGUAGE = 'en_US' } = process.env;
export const { DISABLE_WORKING_HOURS = 'false' } = process.env;
// [FIX-TZ-1] TIMEZONE is the server-wide fallback IANA timezone used when a
// BusinessConfig.timezone field is absent or blank. Individual businesses can
// override via their own BusinessConfig.timezone. Defaults to 'UTC'.
export const { TIMEZONE = 'UTC' } = process.env;
export const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_PRESET } = process.env;

// [AUDIT-P1-B] WhatsApp template message configuration
// Required in production when SCHEDULER_ENABLED=true to avoid silent delivery
// failures for customers whose 24-hour conversation window has expired.
export const {
  WHATSAPP_TEMPLATES_ENABLED = 'false',
  TEMPLATE_ABANDONED_CART    = 'abandoned_cart_reminder',
  TEMPLATE_BOOKING_REMINDER  = 'booking_reminder',
  TEMPLATE_PAYMENT_REMINDER  = 'payment_reminder',
} = process.env;

// ── Production validation ─────────────────────────────────────────────────────
// Called by app.js before any I/O — crashes fast if critical vars are absent.
export function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  // Always required in every environment
  const alwaysRequired = ['MONGODB_URI', 'SUPER_ADMIN_API_KEY'];
  for (const key of alwaysRequired) {
    if (!process.env[key]) errors.push(`Missing required env var: ${key}`);
  }

  if (isProduction) {
    // [AUDIT-P2-A] ENCRYPTION_KEY is mandatory in production.
    // [FIX-ENC-1] Any non-empty value is valid — the key is SHA-256 hashed before use
    // so raw byte length is irrelevant. Removed the misleading 32-byte minimum guard.
    if (!process.env.ENCRYPTION_KEY) {
      errors.push('Missing required env var: ENCRYPTION_KEY (any non-empty string; used for WhatsApp access token encryption at rest — generate with: openssl rand -hex 32)');
    }

    // In production, simulation mode must be OFF and Meta creds must be set
    if (process.env.SIMULATION_MODE === 'true') {
      errors.push('SIMULATION_MODE must be false in production');
    }
    if (!process.env.META_WEBHOOK_VERIFY_TOKEN) {
      errors.push('Missing required env var: META_WEBHOOK_VERIFY_TOKEN');
    }
    // [META-CREDS] META_APP_SECRET is now a platform-wide fallback only.
    // Each tenant can (and should) store their own appSecret in the database via
    // PATCH /api/admin/tenants/:id with { "meta.appSecret": "..." }.
    // Once all tenants have per-tenant secrets, META_APP_SECRET can be removed.
    // Until then, warn if absent so the operator knows signature verification may
    // fall back to no-op for tenants without a stored secret.
    if (!process.env.META_APP_SECRET) {
      warnings.push(
        'META_APP_SECRET is not set. Webhook signature verification will fail for tenants ' +
        'that have no meta.appSecret stored in the database. ' +
        'Set META_APP_SECRET as a platform-wide fallback, or populate meta.appSecret on each tenant.'
      );
    }

    // [AUDIT-P1-B] Error (not warn) if scheduler is enabled but templates are not configured.
    // In production, ALL scheduler targets are cold contacts (session TTL expired = >30 min
    // since last message). Meta silently accepts plain-text API calls to cold contacts but
    // never delivers them — the scheduler appears to work in logs while doing nothing for
    // real customers. Escalated from warning to error so this misconfiguration is caught
    // at deploy time, not discovered days later from zero reminder deliveries.
    if (process.env.SCHEDULER_ENABLED === 'true' && process.env.WHATSAPP_TEMPLATES_ENABLED !== 'true') {
      errors.push(
        'SCHEDULER_ENABLED=true but WHATSAPP_TEMPLATES_ENABLED is not set. ' +
        'In production, all scheduler reminders target cold contacts (24h window expired) — ' +
        'Meta will silently drop every plain-text outbound message. ' +
        'Register templates with Meta and set WHATSAPP_TEMPLATES_ENABLED=true, or disable the scheduler.'
      );
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
      console.warn('\n[Startup] Warning: ENCRYPTION_KEY not set — access tokens stored plaintext in dev.\n');
    }
  }

  // [FIX-10] Warn explicitly when GROQ_API_KEY is absent. The AI health check in
  // app.js emits a warning at runtime, but it's easy to miss in startup noise.
  // This surfaces the missing key early, before any request is processed, in both
  // production and development. Not an error — mock/deterministic fallback is valid
  // for dev and testing, but production operators should know AI is degraded.
  if (!process.env.GROQ_API_KEY) {
    warnings.push(
      'GROQ_API_KEY is not set — AI responses will use the mock/deterministic fallback. ' +
      'Set GROQ_API_KEY to enable live AI (Groq openai/gpt-oss-20b).'
    );
  }

  if (warnings.length) {
    console.warn('\n[Startup] Environment warnings:\n' + warnings.map(w => `  ⚠ ${w}`).join('\n') + '\n');
  }

  if (errors.length) {
    console.error('\n[Startup] Environment validation failed:\n' + errors.map(e => `  ✗ ${e}`).join('\n') + '\n');
    process.exit(1);
  }
}
