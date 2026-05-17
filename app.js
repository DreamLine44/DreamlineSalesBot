/**
 * app.js — DreamLine SalesBot v23.0
 * [APP-1] OpenAI health check via aiService
 * [APP-2] Simulation routes at /api/* when SIMULATION_MODE=true
 * [APP-3] Dual AI provider startup banner
 */

import "./config/env.js";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const { version: APP_VERSION } = _require("./package.json");

import { connectToDB }       from "./config/database.js";
import webhookRoutes         from "./routes/webhookRoutes.js";
import businessRoutes        from "./routes/businessRoutes.js";
import adminMessageRoutes    from "./routes/adminMessageRoutes.js";
import tenantRoutes          from "./routes/tenantRoutes.js";
import onboardingRoutes      from "./routes/onboardingRoutes.js";
import dashboardRoutes       from "./routes/dashboardRoutes.js";
import platformRoutes        from "./routes/platformRoutes.js";
import simulationRoutes      from "./routes/simulationRoutes.js";
import { createRateLimiter } from "./middlewares/rateLimiter.js";
import { handleMetaCallback, fullOnboardingHandler } from "./controllers/onboardingController.js";
import { errorHandler }      from "./middlewares/errorHandler.js";
import logger                from "./config/logger.js";
import { requireApiKey, requireSuperAdminKey, requireApiKeyForDashboard } from "./middlewares/authMiddleware.js";
import { aiHealthCheck }     from "./services/aiService.js";
import { startScheduler, stopScheduler } from "./services/schedulerService.js";

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'", "https://connect.facebook.net"],
      "frame-src":  ["'self'", "https://www.facebook.com"],
      "img-src":    ["'self'", "data:", "https:"],
    },
  },
}));

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(o => o.trim()).filter(Boolean)
  : [];

// Always allow the app's own BASE_URL origin (covers dashboard hosted on same domain)
if (process.env.BASE_URL) {
  try {
    const o = new URL(process.env.BASE_URL).origin;
    if (!allowedOrigins.includes(o)) allowedOrigins.push(o);
  } catch {}
}

// In development, also allow localhost defaults so devs don't need CORS_ORIGIN set
if (process.env.NODE_ENV !== "production") {
  ["http://localhost:3000", "http://localhost:5000", "http://localhost:4000"].forEach(o => {
    if (!allowedOrigins.includes(o)) allowedOrigins.push(o);
  });
}

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no Origin header) — curl, Meta webhooks, etc.
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // In production with no CORS_ORIGIN set, log a warning but don't crash
    if (allowedOrigins.length === 0) {
      logger.warn(`[CORS] No CORS_ORIGIN configured — blocking browser request from ${origin}. Set CORS_ORIGIN env var.`);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key", "x-sim-key"],
}));

// Raw body for Meta webhook signature
app.use("/webhook",
  express.raw({ type: "*/*", limit: "1mb" }),
  (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      try { req.body = JSON.parse(req.rawBody.toString("utf8")); }
      catch { req.body = {}; }
    } else {
      req.rawBody = Buffer.alloc(0);
    }
    next();
  }
);

app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", 1);
app.use(express.static(path.join(__dirname, "public")));

app.get("/onboarding", (req, res) => res.sendFile(path.join(__dirname, "public", "onboarding.html")));

app.get("/health", (req, res) => res.json({
  status: "ok", version: APP_VERSION, timestamp: new Date().toISOString(),
  ai: { openai: !!process.env.OPENAI_API_KEY, groq: !!process.env.GROQ_API_KEY },
  simulation: process.env.SIMULATION_MODE === "true",
}));

app.get("/config", (req, res) => res.json({ metaAppId: process.env.META_APP_ID || null }));
app.get("/",       (req, res) => res.send("DreamLine SalesBot v" + APP_VERSION));

// Routes
app.use("/webhook", webhookRoutes);

if (process.env.SIMULATION_MODE === "true") {
  if (process.env.NODE_ENV === "production") {
    logger.warn("[App] WARNING: SIMULATION_MODE=true in production — /api/messages is exposed. Set SIMULATION_MODE=false unless intentional.");
  }
  app.use("/api", createRateLimiter(200), simulationRoutes);
  logger.info("[App] Simulation mode ON — POST /api/messages available");
}

app.use("/register",        createRateLimiter(60),  onboardingRoutes);
app.get("/onboarding/callback", handleMetaCallback);
app.post("/onboarding/full", createRateLimiter(60), fullOnboardingHandler);
app.use("/business",        createRateLimiter(120), requireApiKey,             businessRoutes);
app.use("/admin/tenants",   createRateLimiter(30),  requireSuperAdminKey,      tenantRoutes);
app.use("/admin/messages",  createRateLimiter(60),  requireApiKey,             adminMessageRoutes);
app.use("/dashboard",       createRateLimiter(120), requireApiKeyForDashboard, dashboardRoutes);
app.use("/platform",        createRateLimiter(30),  requireSuperAdminKey,      platformRoutes);
app.use(errorHandler);

let httpServer = null;

async function gracefulShutdown(signal) {
  logger.info(`[Shutdown] ${signal} — graceful shutdown starting`);
  stopScheduler();
  if (httpServer) await new Promise(r => httpServer.close(r));
  try { await mongoose.connection.close(false); } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => { setTimeout(() => process.exit(1), 10000).unref(); gracefulShutdown("SIGTERM"); });
process.on("SIGINT",  () => { setTimeout(() => process.exit(1), 10000).unref(); gracefulShutdown("SIGINT"); });

(async () => {
  if (process.env.NODE_ENV === "production") {
    const missing = [];
    if (!process.env.META_APP_SECRET)     missing.push("META_APP_SECRET");
    if (!process.env.SUPER_ADMIN_API_KEY) missing.push("SUPER_ADMIN_API_KEY");
    if (!process.env.MONGODB_URI)         missing.push("MONGODB_URI");
    if (!process.env.OPENAI_API_KEY && !process.env.GROQ_API_KEY)
      missing.push("OPENAI_API_KEY or GROQ_API_KEY");
    if (missing.length) { logger.error("FATAL: Missing env vars", { missing }); process.exit(1); }
  }

  await connectToDB();

  const ai = await aiHealthCheck();
  logger.info(`[AI] OpenAI: ${ai.openai.ok ? "✓ " + ai.openai.model : "✗ " + ai.openai.error}`);
  logger.info(`[AI] Groq:   ${ai.groq.ok   ? "✓ " + ai.groq.model   : "✗ " + ai.groq.error}`);
  if (!ai.anyOk) logger.warn("[AI] No AI provider available — deterministic fallback only");

  startScheduler();

  const PORT = process.env.PORT || 5000;
  httpServer = app.listen(PORT, () => {
    logger.info(`DreamLine SalesBot v${APP_VERSION} on port ${PORT}`);
    logger.info(`Routes: /webhook | /business | /dashboard | /platform | /admin/tenants | /admin/messages`);
    if (process.env.SIMULATION_MODE === "true")
      logger.info(`Simulation: POST /api/messages | GET /api/session | GET /api/businesses`);
  });
})();

process.on("unhandledRejection", (r) => {
  logger.error("[Process] Unhandled rejection", { reason: r instanceof Error ? r.message : String(r) });
  setTimeout(() => process.exit(1), 100);
});
process.on("uncaughtException", (e) => {
  logger.error("[Process] Uncaught exception", { err: e.message, stack: e.stack });
  setTimeout(() => process.exit(1), 100);
});
