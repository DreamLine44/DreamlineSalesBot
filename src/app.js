/**
 * WhatSalesAgent2 — app.js (Production)
 * AI-powered WhatsApp Business Assistant Platform
 *
 * Architecture: Intent Engine → Module Router → Flow Engine → AI Fallback
 * Transport:    Meta WhatsApp Cloud API (isolated, plug-and-play)
 * AI:           Groq primary · Mock fallback · Provider-agnostic
 *
 * Production changes vs dev:
 *  - validateEnv() called before any I/O — crashes fast on missing vars
 *  - Simulation mode route disabled in production
 *  - Webhook signature verification middleware added
 *  - webhookLimiter / adminLimiter from rateLimiter (tighter in prod)
 *  - CORS: unknown origins rejected in production (no wildcard fallback)
 *  - Trust proxy correctly set for reverse-proxy deployments (Railway, Render, etc.)
 *  - /health exposes version and uptime — no simulation flag in production
 */

import './config/env.js';
import { validateEnv } from './config/env.js';
validateEnv(); // ← crashes early if .env is misconfigured

import express        from 'express';
import helmet         from 'helmet';
import cors           from 'cors';
import mongoose       from 'mongoose';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path           from 'path';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const _require   = createRequire(import.meta.url);
const { version } = (() => { try { return _require('./package.json'); } catch { return { version: '2.0.0' }; } })();

import crypto            from 'crypto';
import { connectToDB }           from './config/database.js';
import logger                    from './config/logger.js';
import { CLOUDINARY_ENABLED }    from './config/cloudinary.js'; // initialise at boot, not on first request
import { errorHandler }          from './middleware/errorHandler.js';
import { createRateLimiter, webhookLimiter, adminLimiter } from './middleware/rateLimiter.js';
import { requireApiKey, requireSuperAdminKey } from './middleware/authMiddleware.js';
import { startScheduler, stopScheduler } from './services/schedulerService.js';
import { aiHealthCheck }         from './core/ai/providers/aiRouter.js';
import { registerAllModules }    from './core/shared/moduleRegistry.js';
import { getSupportedModes }     from './config/modes.js';

// Routes
import webhookRoutes     from './routes/webhookRoutes.js';
import simulateRoutes    from './routes/simulateRoutes.js';
import businessRoutes    from './routes/businessRoutes.js';
import dashboardRoutes   from './routes/dashboardRoutes.js';
import tenantRoutes      from './routes/tenantRoutes.js';
import adminRoutes                 from './routes/adminRoutes.js';
import whatsappOnboardingRoutes from './routes/whatsappOnboardingRoutes.js';
import adminUserRoutes          from './routes/adminUserRoutes.js';

const app        = express();
const isProduction = process.env.NODE_ENV === 'production';

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Bot API — no HTML served
  // hsts is enabled by default in helmet — good for HTTPS deployments
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',').map(o => o.trim()).filter(Boolean);

if (!isProduction) {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:5000');
}

// [IMPROVE-CORS-WARN] A missing CORS_ORIGIN in production doesn't throw or crash —
// it just makes every browser request from the real frontend fail with a CORS
// error that never even reaches this app's error handler (the browser blocks it
// client-side). That failure mode is invisible in server logs, so surface it loudly
// at boot instead of only discovering it via a confused "the frontend is broken"
// report later.
if (isProduction && allowedOrigins.length === 0) {
  logger.warn(
    '[CORS] CORS_ORIGIN is not set in production — every browser request from the ' +
    'frontend will be silently rejected by the browser (not by this server, so it ' +
    'will not appear in these logs). Set CORS_ORIGIN to the frontend\'s deployed ' +
    'domain(s), comma-separated, e.g. CORS_ORIGIN=https://what-sales.vercel.app'
  );
}

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, curl, Postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // In production, reject unknown origins with a clean 403 (not a thrown Error)
    if (isProduction) return cb(null, false);
    // In dev, allow all (developer convenience)
    return cb(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // [AUDIT-FIX-CORS-1] 'Authorization' was missing from allowedHeaders even though
  // the whole AdminUser Bearer-session login flow (authMiddleware.js tryBearerAuth,
  // used by /dashboard/auth/login and every subsequent Bearer-authenticated request)
  // depends on the browser being allowed to send it. A cross-origin SPA (the
  // documented deployment shape — see CORS_ORIGIN above) sending
  // `Authorization: Bearer <token>` triggers a CORS preflight; without 'Authorization'
  // in Access-Control-Allow-Headers, the browser blocks the preflight and every
  // Bearer-authenticated request fails client-side before it ever reaches this
  // server — invisible in server logs, identical failure mode to the missing-
  // CORS_ORIGIN case warned about above. The legacy x-api-key path was unaffected
  // (that header was already allowed), which is why this was easy to miss in
  // testing that only exercised the legacy auth path.
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-sim-key'],
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
// Raw body preserved for Meta webhook signature verification
app.use('/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body; // needed by verifyMetaSignature
    try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = {}; }
  }
  next();
});
app.use(express.json({ limit: '2mb' }));

// Trust reverse proxy headers (X-Forwarded-For) — required for Railway, Render, Heroku, etc.
app.set('trust proxy', 1);

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  platform: 'WhatSalesAgent2',
  version,
  uptime: Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
  environment: process.env.NODE_ENV,
}));

app.get('/', (_req, res) => res.json({ platform: 'WhatSalesAgent2', version, status: 'running' }));

// WhatsApp webhook (Meta) — signature verification on POST only
app.use('/webhook', webhookLimiter, webhookRoutes);

// Simulation — local testing only (NEVER in production)
if (!isProduction && process.env.SIMULATION_MODE === 'true') {
  app.use('/api', createRateLimiter(300), simulateRoutes);
  logger.info('[App] Simulation mode ON — POST /api/message available (dev only)');
}

// [FEATURE-MULTIADMIN-1] Must be mounted BEFORE the broad '/dashboard' mount
// below — that mount applies requireApiKey to every path under /dashboard,
// which would shadow /dashboard/auth/login and /dashboard/auth/accept-invite,
// both deliberately unauthenticated (they're how a session token is obtained
// in the first place). Same "specific before catch-all" pattern already used
// for whatsappOnboardingRoutes vs the broad /admin mount above.
app.use('/', adminUserRoutes);

// Business management
app.use('/business', createRateLimiter(120), requireApiKey, businessRoutes);

// Dashboard
app.use('/dashboard', createRateLimiter(120), requireApiKey, dashboardRoutes);


app.post('/admin/rotate-super-key', adminLimiter, requireSuperAdminKey, (_req, res) => {
  const candidate = crypto.randomBytes(40).toString('hex'); // 80 hex chars, 320 bits
  logger.info('[SuperAdmin] Super-admin key rotation candidate generated');
  res.json({
    ok: true,
    candidate,
    instructions: [
      '1. Copy the candidate key above.',
      '2. Set SUPER_ADMIN_API_KEY=<candidate> in your Railway / Render environment.',
      '3. Redeploy the service — the new key becomes active on startup.',
      '4. Verify access with the new key before discarding the old one.',
    ],
    warning: 'This endpoint does not invalidate the current key. Redeploy is required.',
  });
});

// WhatsApp onboarding — tenant-facing (/api/whatsapp/*) and admin-facing (/admin/whatsapp/*)
// Must be mounted BEFORE the broad /admin mount to prevent /admin/whatsapp/* being caught
// by /admin (which uses requireApiKey, not requireSuperAdminKey — the admin sub-routes
// apply their own middleware internally via requireSuperAdminKey).
// [FIX-MOUNT-1] whatsappOnboardingRoutes — tenant-facing /api/whatsapp/* and
// admin-facing /admin/whatsapp/* — must be mounted before the broad /admin catch-all.
app.use('/', whatsappOnboardingRoutes);
app.use('/admin/tenants', adminLimiter, requireSuperAdminKey, tenantRoutes);
app.use('/admin',         adminLimiter, requireApiKey,        adminRoutes);

app.use(errorHandler);

// ── Startup ───────────────────────────────────────────────────────────────────
let httpServer = null;

async function start() {
  await connectToDB();
  await registerAllModules();

  const ai = await aiHealthCheck();
  logger.info(`[AI] Groq:  ${ai.groq.ok   ? '✓ ' + ai.groq.model   : '✗ ' + ai.groq.error}`);
  logger.info('[AI] Mock:  always available (deterministic fallback)');
  if (!ai.groq.ok && isProduction) {
    logger.warn('[AI] WARNING: No live AI provider in production — mock/deterministic fallback active');
  }

  // [IMPROVE-ENCRYPTION-WARN] tenantController's encryptToken() silently falls
  // back to storing WhatsApp accessToken/verifyToken/webhookSecret/meta.appSecret
  // as PLAINTEXT if ENCRYPTION_KEY is unset — with only a per-call debug-level log
  // line, easy to miss entirely in normal operation. Surface this once, loudly, at
  // boot, since these are real tenant secrets (each tenant's own dedicated Meta
  // app credentials), not placeholder data.
  if (!process.env.ENCRYPTION_KEY) {
    logger.warn(
      '[SECURITY] ENCRYPTION_KEY is not set — WhatsApp access tokens, verify tokens, ' +
      'webhook secrets, and Meta app secrets will be stored in PLAINTEXT in MongoDB ' +
      'for every tenant. Set ENCRYPTION_KEY (any non-empty string — it is SHA-256 ' +
      'hashed internally) in your Railway environment, then re-save each existing ' +
      "tenant's WhatsApp credentials once to encrypt values that were saved before " +
      'this was set (existing plaintext values do not retroactively encrypt themselves).'
    );
  }

  startScheduler();

  const PORT = process.env.PORT || 5000;
  httpServer = app.listen(PORT, () => {
    const modeList = getSupportedModes().map(m => m.toLowerCase()).join(' · ');
    logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`  WhatSalesAgent2 v${version} — ${process.env.NODE_ENV} — port ${PORT}`);
    logger.info(`  Modes: ${modeList}`);
    logger.info(`  Simulation: ${process.env.SIMULATION_MODE === 'true' ? 'ON (dev)' : 'OFF (live Meta webhook)'}`);
    logger.info(`  Cloudinary: ${CLOUDINARY_ENABLED ? 'ON (image uploads enabled)' : 'OFF (set CLOUDINARY_* vars to enable)'}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  });
}

async function gracefulShutdown(signal) {
  logger.info(`[Shutdown] ${signal} received — draining connections`);
  stopScheduler();
  if (httpServer) {
    await new Promise(r => httpServer.close(r));
    logger.info('[Shutdown] HTTP server closed');
  }
  try {
    await mongoose.connection.close(false);
    logger.info('[Shutdown] MongoDB connection closed');
  } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (r) => {
  logger.error('[Process] Unhandled rejection', { reason: r instanceof Error ? r.message : String(r) });
});
process.on('uncaughtException', (err) => {
  logger.error('[Process] Uncaught exception', { err: err.message, stack: err.stack?.slice(0, 400) });
  process.exit(1);
});

start().catch(err => {
  logger.error('[Startup] Fatal', { err: err.message });
  process.exit(1);
});

export default app;
