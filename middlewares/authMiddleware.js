import { timingSafeEqual, createHash } from "crypto";
import Tenant from "../models/Tenant.js";
import logger from "../config/logger.js";

// ================= HELPERS =================
const safeCompare = (a, b) => {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
};

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
    tenant = await Tenant.findOne({ apiKey: provided });
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

// ================= TENANT API KEY =================
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
    tenant = await Tenant.findOne({ apiKey: provided });
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
