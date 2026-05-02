import { config } from "dotenv";

// Only load .env files in development
if (process.env.NODE_ENV !== "production") {
  config({
    path: `.env.${process.env.NODE_ENV || "development"}.local`,
  });
}

// Fallback (optional safety)
config();

export const {
  NODE_ENV,
  PORT,
  MONGODB_URI,
  SUPER_ADMIN_API_KEY,
  META_APP_ID,
  META_APP_SECRET,
  META_REDIRECT_URI,
  META_WEBHOOK_VERIFY_TOKEN,
  META_WHATSAPP_TOKEN,
  META_PHONE_NUMBER_ID,
  META_API_VERSION,
  BASE_URL,
  LOG_LEVEL,
  CORS_ORIGIN,
  GROQ_API_KEY
} = process.env;

// Ensure compatibility
if (!process.env.WA_API_VERSION && process.env.META_API_VERSION) {
  process.env.WA_API_VERSION = process.env.META_API_VERSION;
}










// import { config } from "dotenv";

// config({
//   path: `.env.${process.env.NODE_ENV || "development"}.local`,
// });

// export const {
//   NODE_ENV,
//   PORT,
//   MONGODB_URI,
//   SUPER_ADMIN_API_KEY,
//   META_APP_ID,
//   META_APP_SECRET,
//   META_REDIRECT_URI,
//   META_WEBHOOK_VERIFY_TOKEN,
//   META_WHATSAPP_TOKEN,
//   META_PHONE_NUMBER_ID,
//   META_API_VERSION,
//   BASE_URL,
//   LOG_LEVEL,
//   CORS_ORIGIN,
//   GROQ_API_KEY
// } = process.env;

// // WA_API_VERSION is the name used throughout services/controllers.
// // .env files define it as META_API_VERSION — expose both so either name works.
// if (!process.env.WA_API_VERSION && process.env.META_API_VERSION) {
//   process.env.WA_API_VERSION = process.env.META_API_VERSION;
// }
