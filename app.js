import "./config/env.js"; // MUST be first — loads .env.*.local before anything reads process.env
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { createRequire } from "module";
import { connectToDB } from "./config/database.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import businessRoutes from "./routes/businessRoutes.js";
import adminMessageRoutes from "./routes/adminMessageRoutes.js";
import tenantRoutes from "./routes/tenantRoutes.js";
import onboardingRoutes from "./routes/onboardingRoutes.js";
import rateLimiter from "./middlewares/rateLimiter.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import logger from "./config/logger.js";
import { requireApiKey, requireSuperAdminKey } from "./middlewares/authMiddleware.js";
import { groqHealthCheck }                    from "./services/groqService.js";

const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require("./package.json");

const app = express();

app.use(helmet());

// CORS — restrict to known origins in production
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : ["http://localhost:3000"];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

// ✅ NEW — Raw body capture for webhook signature verification.
//
// Meta signs every webhook POST with X-Hub-Signature-256 (HMAC-SHA256).
// To verify the signature we need the raw bytes BEFORE JSON.parse() touches them.
//
// Strategy:
//   /webhook/* routes → express.raw() stores raw bytes in req.rawBody,
//                        then JSON.parse() runs so req.body is still usable.
//   All other routes   → normal express.json() only.
//
// ORDER MATTERS: this must come before app.use(express.json()) below.

app.use(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, _res, next) => {
    // Store raw bytes for signature verification in webhookController
    req.rawBody = req.body;
    // Parse JSON so the rest of the app still sees req.body as an object
    try {
      req.body = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      req.body = {};
    }
    next();
  }
);

// Global JSON parser for all non-webhook routes
app.use(express.json());
app.set("trust proxy", 1);

// Health check — no auth required
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// Webhook — no rate limit (Meta sends rapidly and needs instant 200)
app.use("/webhook", webhookRoutes);

app.get('/', (req, res) => res.send('OK'));
// Self-serve onboarding — public (step 1) + apiKey-gated (steps 2-3)
// No SUPER_ADMIN_API_KEY required — businesses self-register here
app.use("/register", rateLimiter, onboardingRoutes);

// Business config & orders/bookings — rate limited + tenant auth required
app.use("/business", rateLimiter, requireApiKey, businessRoutes);

// Tenant management — super-admin key only (separate from tenant API key)
app.use("/admin/tenants", rateLimiter, requireSuperAdminKey, tenantRoutes);

// Failed-message admin replay — same tenant auth as /business
// Mounted at /admin/messages to avoid conflicting with /admin/tenants
// Uses dedicated router (not businessRoutes) so only failed-message endpoints are exposed here.
app.use("/admin/messages", rateLimiter, requireApiKey, adminMessageRoutes);

// Error handler MUST be last
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

(async () => {
  // ── PRODUCTION SAFETY CHECKS ──
  // Refuse to start in production if critical security config is missing.
  // This prevents the silent "verification skipped" path in webhookController
  // from ever running on a live server.
  if (process.env.NODE_ENV === "production") {
    const missing = [];
    if (!process.env.META_APP_SECRET)       missing.push("META_APP_SECRET");
    if (!process.env.SUPER_ADMIN_API_KEY)   missing.push("SUPER_ADMIN_API_KEY");
    if (!process.env.MONGODB_URI)           missing.push("MONGODB_URI");
    if (!process.env.GROQ_API_KEY)          missing.push("GROQ_API_KEY");

    if (missing.length > 0) {
      logger.error("FATAL: Missing required env vars for production", { missing });
      process.exit(1);
    }
  }

  await connectToDB();

  // ── GROQ HEALTH CHECK ──
  // Validate the Groq API key is live before the first customer message arrives.
  const groqStatus = await groqHealthCheck();
  if (groqStatus.ok) {
    logger.info(`[Groq] Ready — model: ${groqStatus.model}`);
  } else {
    logger.warn(`[Groq] Health check failed: ${groqStatus.error} — AI replies will use standard fallback`);
  }

  app.listen(PORT, () => {
    logger.info(`WhatsBotLyn v${APP_VERSION} running on port ${PORT}`);
    logger.info("Routes: /webhook | /business | /register | /admin/tenants");
    logger.info("Analytics: GET /business/analytics");
    logger.info("Human mode: POST /business/human-mode");
  });
})();
