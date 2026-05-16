/**
 * config/env.js — v23.0
 * MUST be imported FIRST in app.js
 */
import { config } from "dotenv";

config({
  path: `.env.${process.env.NODE_ENV || "development"}.local`,
});

export const { NODE_ENV, PORT, MONGODB_URI, SUPER_ADMIN_API_KEY, BASE_URL, LOG_LEVEL, CORS_ORIGIN } = process.env;
export const { OPENAI_API_KEY, OPENAI_MODEL, OPENAI_MAX_TOKENS, OPENAI_TIMEOUT_MS, GROQ_API_KEY } = process.env;
export const { META_APP_ID, META_APP_SECRET, META_REDIRECT_URI, META_WEBHOOK_VERIFY_TOKEN, META_WHATSAPP_TOKEN, META_PHONE_NUMBER_ID, META_API_VERSION } = process.env;
export const { SIMULATION_MODE, SIMULATION_SECRET } = process.env;
export const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
export const { ENCRYPTION_KEY } = process.env;

if (!process.env.WA_API_VERSION && process.env.META_API_VERSION) {
  process.env.WA_API_VERSION = process.env.META_API_VERSION;
}
