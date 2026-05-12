import "./config/env.js"; // MUST be first — loads .env.*.local before anything reads process.env
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { connectToDB } from "./config/database.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import businessRoutes from "./routes/businessRoutes.js";
import adminMessageRoutes from "./routes/adminMessageRoutes.js";
import tenantRoutes from "./routes/tenantRoutes.js";
import onboardingRoutes from "./routes/onboardingRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import platformRoutes from "./routes/platformRoutes.js";
import { createRateLimiter } from "./middlewares/rateLimiter.js";
import { handleMetaCallback, fullOnboardingHandler } from "./controllers/onboardingController.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import logger from "./config/logger.js";
import { requireApiKey, requireSuperAdminKey, requireApiKeyForDashboard } from "./middlewares/authMiddleware.js";
import { groqHealthCheck }                    from "./services/groqService.js";
import { startScheduler }                     from "./services/schedulerService.js";

const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require("./package.json");

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'", "https://connect.facebook.net"],
      "frame-src": ["'self'", "https://www.facebook.com"],
      "img-src": ["'self'", "data:", "https:"],
    },
  },
}));

// CORS — restrict to known origins in production
// No-origin requests (same-origin server fetches, curl, mobile apps) are always allowed.
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : ["http://localhost:3000", "http://localhost:5000"];

// Always add BASE_URL origin so the hosted onboarding page can call its own API
if (process.env.BASE_URL) {
  try {
    const baseOrigin = new URL(process.env.BASE_URL).origin;
    if (!allowedOrigins.includes(baseOrigin)) allowedOrigins.push(baseOrigin);
  } catch { /* invalid BASE_URL — ignore */ }
}

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no Origin header (same-origin, curl, server-to-server)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
  // [FIX] Accept all content types — Meta sometimes sends without Content-Type header.
  // express.raw({ type: "application/json" }) silently skips those requests,
  // leaving rawBody undefined and causing all HMAC signature checks to fail (403).
  // [UPGRADE] 1mb limit prevents memory exhaustion from crafted oversized payloads.
  express.raw({ type: "*/*", limit: "1mb" }),
  (req, _res, next) => {
    // Store raw bytes for signature verification in webhookController.
    // Guard: Buffer.isBuffer check handles GET requests (webhook verification)
    // which have no body — those get an empty buffer, not a crash.
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      try {
        req.body = JSON.parse(req.rawBody.toString("utf8"));
      } catch {
        req.body = {};
      }
    } else {
      req.rawBody = Buffer.alloc(0);
    }
    next();
  }
);

// Global JSON parser for all non-webhook routes
app.use(express.json());
app.set("trust proxy", 1);

// ── Static files — onboarding UI ─────────────────────────────────────────────
// Serves /public/onboarding.html at GET /onboarding
// Must come BEFORE route mounts so the file is reachable.
app.use(express.static(path.join(__dirname, "public")));

// Convenience redirect: GET /onboarding → onboarding.html
app.get("/onboarding", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "onboarding.html"));
});

// Health check — no auth required
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// Public config — exposes only non-secret client-side env vars
// Used by onboarding.html to get META_APP_ID without embedding it in the HTML
app.get("/config", (req, res) => {
  res.json({
    metaAppId: process.env.META_APP_ID || null,
  });
});

// Webhook — no rate limit (Meta sends rapidly and needs instant 200)
app.use("/webhook", webhookRoutes);

app.get('/', (req, res) => res.send('OK'));

// [FIX-2] Each mount gets its own independent rate-limit counter via createRateLimiter().
// Previously one shared singleton meant all routes competed for one 60-req/min budget.

// Self-serve onboarding — public (whatsapp connect, full) + apiKey-gated (business, status)
app.use("/register", createRateLimiter(60), onboardingRoutes);

// Aliases: /onboarding/* maps to the same routes for backward compat
// GET /onboarding/callback — Meta Embedded Signup OAuth redirect (public)
app.get("/onboarding/callback", handleMetaCallback);
// POST /onboarding/full — unified onboarding (same handler as /register/full)
app.post("/onboarding/full", createRateLimiter(60), fullOnboardingHandler);

// Business config & orders/bookings — rate limited + tenant auth required
// Higher limit (120/min) to handle concurrent customer sessions
app.use("/business", createRateLimiter(120), requireApiKey, businessRoutes);

// Tenant management — super-admin key only; tighter limit to protect admin ops
app.use("/admin/tenants", createRateLimiter(30), requireSuperAdminKey, tenantRoutes);

// Failed-message admin replay — same tenant auth as /business
// Mounted at /admin/messages; uses dedicated router (not businessRoutes)
// so only the failed-message endpoints are exposed here.
app.use("/admin/messages", createRateLimiter(60), requireApiKey, adminMessageRoutes);

// Client self-service dashboard — allows PENDING tenants (pre-WhatsApp connection)
app.use("/dashboard", createRateLimiter(120), requireApiKeyForDashboard, dashboardRoutes);

// Platform owner (SaaS admin) routes — super-admin key only
app.use("/platform", createRateLimiter(30), requireSuperAdminKey, platformRoutes);

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

  // Start background scheduler (abandoned cart, booking reminders, payment nudges)
  // Controlled by SCHEDULER_ENABLED=true env var — off by default.
  startScheduler();
  if (groqStatus.ok) {
    logger.info(`[Groq] Ready — model: ${groqStatus.model}`);
  } else {
    logger.warn(`[Groq] Health check failed: ${groqStatus.error} — AI replies will use standard fallback`);
  }

  app.listen(PORT, () => {
    logger.info(`Dreamline Sales Bot v${APP_VERSION} running on port ${PORT}`);
    logger.info("Onboarding: PUT /register/whatsapp (Step 1: connect WhatsApp + create tenant) | POST /register/business (Step 2: configure bot, requires x-api-key) | POST /register/full (unified single-call onboarding)");
    logger.info("Routes: /webhook | /business | /dashboard | /platform | /admin/tenants | /admin/messages");
    logger.info("Advanced config: POST /business/menu | /business/hours | /business/payment | /business/faq | /business/settings");
    logger.info("Image uploads:  POST /business/menu/upload-image (multipart/form-data, field: image) — requires CLOUDINARY_* env vars");
    logger.info("Dashboard: GET /dashboard — client self-service");
    logger.info("Platform:  GET /platform/stats — SaaS owner panel");
  });
})();

// ── Global error guards ───────────────────────────────────────────────────────
// Without these, an unhandled Promise rejection or synchronous throw escapes
// Express's error handler and crashes the process silently (Node ≥15 exits on
// unhandledRejection by default with no log entry in production log aggregators).
process.on('unhandledRejection', (reason, promise) => {
  logger.error('[Process] Unhandled Promise rejection — process will exit', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack:  reason instanceof Error ? reason.stack  : undefined,
  });
  setTimeout(() => process.exit(1), 100);
});

process.on('uncaughtException', (err) => {
  logger.error('[Process] Uncaught exception — process will exit', {
    err:   err.message,
    stack: err.stack,
  });
  setTimeout(() => process.exit(1), 100);
});
