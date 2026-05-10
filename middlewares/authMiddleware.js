import { timingSafeEqual, createHash } from "crypto";
import Tenant from "../models/Tenant.js";
import logger from "../config/logger.js";

// ================= HELPERS =================
const safeCompare = (a, b) => {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
};

/**
 * Hash a plaintext API key the same way the migration script does.
 * We always look up by hash so the raw key is never stored in or compared
 * against MongoDB — a DB breach exposes only hashes, not live keys.
 *
 * MIGRATION NOTE: run `node scripts/migrate-apikey-hash.js` once to convert
 * all existing plaintext apiKey values to apiKeyHash. After migration set
 * APIKEY_MIGRATION_DONE=true in your env to disable the plaintext fallback.
 */
const hashApiKey = (key) => createHash("sha256").update(key).digest("hex");

/**
 * Resolve a tenant from the provided API key.
 * Tries hashed lookup first (post-migration). Falls back to plaintext for
 * tenants whose keys haven't been migrated yet (APIKEY_MIGRATION_DONE != true).
 */
async function tenantFromApiKey(provided) {
  if (!provided) return null;

  const hashed = hashApiKey(provided);

  // Primary: hash lookup (safe — hash is not sensitive)
  let tenant = await Tenant.findOne({ apiKeyHash: hashed });
  if (tenant) return tenant;

  // Fallback: plaintext lookup for tenants not yet migrated.
  // Disable once all keys are migrated by setting APIKEY_MIGRATION_DONE=true.
  if (process.env.APIKEY_MIGRATION_DONE !== "true") {
    tenant = await Tenant.findOne({ apiKey: provided });
    if (tenant) {
      // Opportunistically hash the key now to speed future lookups
      try {
        await Tenant.updateOne({ _id: tenant._id }, { $set: { apiKeyHash: hashed } });
      } catch (e) {
        logger.warn("[authMiddleware] Could not migrate apiKey to hash", { err: e.message });
      }
      return tenant;
    }
  }

  return null;
}

// ================= SUPER ADMIN KEY =================
// Used for: tenant management (register/list/delete clients)
export const requireSuperAdminKey = (req, res, next) => {
  const adminKey = process.env.SUPER_ADMIN_API_KEY;

  if (!adminKey) {
    return res.status(500).json({
      success: false,
      message: "Server misconfiguration: SUPER_ADMIN_API_KEY is not set."
    });
  }

  const provided = req.headers["x-api-key"] || "";

  if (!provided || !safeCompare(provided, adminKey)) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: invalid or missing super-admin API key."
    });
  }

  next();
};

// ================= ONBOARDING API KEY (permissive) =================
// Used for onboarding steps 2 & 3 — does NOT block if WhatsApp is not yet connected.
export const requireApiKeyForOnboarding = async (req, res, next) => {
  const provided = req.headers["x-api-key"] || "";

  if (!provided) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: x-api-key header is required.",
    });
  }

  let tenant;
  try {
    tenant = await tenantFromApiKey(provided);
  } catch (err) {
    logger.error("[authMiddleware] DB error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }

  if (!tenant) {
    return res.status(401).json({ success: false, message: "Unauthorized: invalid API key." });
  }

  if (tenant.status === "SUSPENDED") {
    return res.status(403).json({
      success: false,
      message: "Your account has been suspended. Contact support.",
    });
  }

  // NOTE: WhatsApp connection is NOT checked here — that's the point of onboarding.
  req.tenant = tenant;
  next();
};

// ================= DASHBOARD API KEY (allows PENDING) =================
// Used for /dashboard — allows tenants to access their dashboard even before
// WhatsApp is connected, so they can see setup progress and manage their config.
export const requireApiKeyForDashboard = async (req, res, next) => {
  const provided = req.headers["x-api-key"] || "";

  if (!provided) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: x-api-key header is required.",
    });
  }

  let tenant;
  try {
    tenant = await tenantFromApiKey(provided);
  } catch (err) {
    logger.error("[authMiddleware] DB error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }

  if (!tenant) {
    return res.status(401).json({ success: false, message: "Unauthorized: invalid API key." });
  }

  if (tenant.status === "SUSPENDED") {
    return res.status(403).json({
      success: false,
      message: "Your account has been suspended. Contact support.",
    });
  }

  // Allow PENDING tenants — dashboard is used during onboarding too
  req.tenant = tenant;
  next();
};


// Used for: business config CRUD (clients managing their own bot)
export const requireApiKey = async (req, res, next) => {
  const provided = req.headers["x-api-key"] || "";

  if (!provided) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: x-api-key header is required."
    });
  }

  let tenant;
  try {
    tenant = await tenantFromApiKey(provided);
  } catch (err) {
    logger.error("[authMiddleware] DB error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }

  if (!tenant) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: invalid API key."
    });
  }

  if (tenant.status === "SUSPENDED") {
    return res.status(403).json({
      success: false,
      message: "Your account has been suspended. Contact support."
    });
  }

  // Warn if WhatsApp is not yet connected — bot won't work
  if (tenant.status === "PENDING" || !tenant.whatsapp?.connected) {
    return res.status(403).json({
      success: false,
      message: "WhatsApp not yet connected. Complete the onboarding to activate your bot."
    });
  }

  req.tenant = tenant;
  next();
};

/**
 * optionalApiKey — same as requireApiKey but does NOT reject if the key is
 * absent or invalid. Sets req.tenant when the key resolves, leaves it
 * undefined otherwise. Used on endpoints that serve both authenticated
 * (update existing tenant) and unauthenticated (create new tenant) flows.
 */
export const optionalApiKey = async (req, res, next) => {
  const provided = req.headers["x-api-key"];
  if (!provided) return next(); // No key → unauthenticated path

  try {
    const tenant = await tenantFromApiKey(provided);
    if (tenant) req.tenant = tenant; // Silently ignore bad/unknown keys
  } catch (err) {
    logger.warn("[authMiddleware] optionalApiKey DB error (continuing unauthenticated)", { err: err.message });
  }
  next();
};
