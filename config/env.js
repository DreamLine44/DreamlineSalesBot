/**
 * config/env.js — v24.0
 * MUST be imported FIRST in app.js
 *
 * Load order (first file found wins):
 *   1. .env.{NODE_ENV}.local   (e.g. .env.development.local, .env.production.local)
 *   2. .env                    (fallback — useful on Render/Railway when users upload a .env)
 *
 * On Railway/Render env vars are injected directly by the platform, so dotenv
 * may find no file at all — that is fine and expected. dotenv silently ignores
 * missing files without throwing.
 */
import { config } from "dotenv";

// Primary: .env.{NODE_ENV}.local
config({ path: `.env.${process.env.NODE_ENV || "development"}.local` });

// Fallback: plain .env (only fills vars not already set by the primary file or platform)
config({ path: ".env", override: false });

export const { NODE_ENV, PORT, MONGODB_URI, SUPER_ADMIN_API_KEY, BASE_URL, LOG_LEVEL, CORS_ORIGIN } = process.env;
export const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_MAX_TOKENS, OPENAI_TIMEOUT_MS, GROQ_API_KEY } = process.env;
export const { META_APP_ID, META_APP_SECRET, META_REDIRECT_URI, META_WEBHOOK_VERIFY_TOKEN, META_WHATSAPP_TOKEN, META_PHONE_NUMBER_ID, META_API_VERSION } = process.env;
export const { SIMULATION_MODE, SIMULATION_SECRET } = process.env;
export const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
export const { ENCRYPTION_KEY } = process.env;

if (!process.env.WA_API_VERSION && process.env.META_API_VERSION) {
  process.env.WA_API_VERSION = process.env.META_API_VERSION;
}

