/**
 * WhatSales E-Commerce Store Bot â€” app.js (Production)
 * AI-powered WhatsApp Business Assistant Platform
 *
 * Architecture: Intent Engine â†’ Module Router â†’ Flow Engine â†’ AI Fallback
 * Transport:    Meta WhatsApp Cloud API (isolated, plug-and-play)
 * AI:           Groq primary Â· Mock fallback Â· Provider-agnostic
 *
 * Production changes vs dev:
 *  - validateEnv() called before any I/O â€” crashes fast on missing vars
 *  - Simulation mode route disabled in production
 *  - Webhook signature verification middleware added
 *  - webhookLimiter / adminLimiter from rateLimiter (tighter in prod)
 *  - CORS: unknown origins rejected in production (no wildcard fallback)
 *  - Trust proxy correctly set for reverse-proxy deployments (Railway, Render, etc.)
 *  - /health exposes version and uptime â€” no simulation flag in production
 */

import './config/env.js';
import { validateEnv } from './config/env.js';
validateEnv(); // â† crashes early if .env is misconfigured

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
import { errorHandler }          from './middleware/error/errorHandler.js';
import { createRateLimiter, webhookLimiter, adminLimiter } from './middleware/rate-limiting/rateLimiter.js';
import { requireApiKey, requireSuperAdminKey } from './middleware/auth/authMiddleware.js';
import { startScheduler, stopScheduler } from './services/shared/sharedFeature.js';
import { provisionBookingDateFlowsOnStartup } from './services/booking/bookingFeature.js';
import { aiHealthCheck }         from './core/ai/providers/aiRouter.js';
import { registerAllModules }    from './core/shared/moduleRegistry.js';
import { getSupportedModes }     from './config/modes.js';

// Routes
import webhookRoutes     from './routes/webhook/webhookRoutes.js';
import { WEBHOOK_BUILD_MARKER } from './controllers/webhook/webhookController.js';
import simulateRoutes    from './routes/simulate/simulateRoutes.js';
import businessRoutes    from './routes/business/businessRoutes.js';
import dashboardRoutes   from './routes/dashboard/dashboardRoutes.js';
import adminUserRoutes   from './routes/admin/adminUserRoutes.js';
import tenantRoutes      from './routes/tenant/tenantRoutes.js';
import adminRoutes                 from './routes/admin/adminRoutes.js';
import whatsappOnboardingRoutes from './routes/whatsapp/whatsappOnboardingRoutes.js';

const app        = express();
const isProduction = process.env.NODE_ENV === 'production';

// â”€â”€ Security headers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet({
  contentSecurityPolicy: false, // Bot API â€” no HTML served
  // hsts is enabled by default in helmet â€” good for HTTPS deployments
}));

// â”€â”€ CORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',').map(o => o.trim()).filter(Boolean);

if (!isProduction) {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:5000');
}

// [IMPROVE-CORS-WARN] A missing CORS_ORIGIN in production doesn't throw or crash â€”
// it just makes every browser request from the real frontend fail with a CORS
// error that never even reaches this app's error handler (the browser blocks it
// client-side). That failure mode is invisible in server logs, so surface it loudly
// at boot instead of only discovering it via a confused "the frontend is broken"
// report later.
if (isProduction && allowedOrigins.length === 0) {
  logger.warn(
    '[CORS] CORS_ORIGIN is not set in production â€” every browser request from the ' +
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
  // [FIX-CORS-AUTH-HEADER] authMiddleware.js's tryBearerAuth() (the
  // multi-admin staff-login system â€” [FEATURE-MULTIADMIN-1]) reads
  // `Authorization: Bearer <token>` on every request, but that header was
  // never in allowedHeaders. A cross-origin request from the real dashboard
  // frontend sending Authorization fails the browser's CORS preflight
  // before the request is even sent â€” the backend logic was correct and
  // fully tested, but no browser-based caller could ever reach it. Staff
  // login (StaffPage.jsx / AcceptInvitePage.jsx) was silently unusable from
  // any deployed frontend origin.
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-sim-key', 'Authorization'],
}));

// â”€â”€ Body parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Raw body preserved for Meta webhook signature verification
app.use('/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body; // needed by verifyMetaSignature
    try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = {}; }
  }
  next();
});
// [FIX-DOUBLE-PARSE] Explicitly skip /webhook here instead of relying on
// body-parser's internal "request already finished" guard to make this a no-op
// for that route. That guard is real (verified: body-parser's read() checks
// onFinished.isFinished(req) and calls next() without touching req.body when
// the stream was already fully consumed by express.raw() above) â€” but leaning
// on an internal implementation detail of a dependency is fragile. Scoping the
// path explicitly removes any dependency on that detail and makes the intent
// unambiguous: /webhook's body is parsed exactly once, by the raw handler above.
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path.startsWith('/webhook/')) return next();
  express.json({ limit: '2mb' })(req, res, next);
});

// Trust reverse proxy headers (X-Forwarded-For) â€” required for Railway, Render, Heroku, etc.
app.set('trust proxy', 1);

// â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  platform: 'WhatSales E-Commerce Store Bot',
  version,
  // [DEPLOY-VERIFY] Curl this after every deploy. If it doesn't match the value
  // currently in controllers/webhookController.js, Railway is not running the
  // code you think it's running â€” full stop, no need to infer it from log shapes.
  webhookBuild: WEBHOOK_BUILD_MARKER,
  uptime: Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
  environment: process.env.NODE_ENV,
}));

app.get('/', (_req, res) => res.json({ platform: 'WhatSales E-Commerce Store Bot', version, status: 'running' }));

// WhatsApp webhook (Meta) â€” signature verification on POST only
app.use('/webhook', webhookLimiter, webhookRoutes);

// Simulation â€” local testing only (NEVER in production)
if (!isProduction && process.env.SIMULATION_MODE === 'true') {
  app.use('/api', createRateLimiter(300), simulateRoutes);
  logger.info('[App] Simulation mode ON â€” POST /api/message available (dev only)');
}

// Business management
app.use('/business', createRateLimiter(120), requireApiKey, businessRoutes);

// [FIX-ORPHAN-ROUTE-1] adminUserRoutes was built and fully wired to
// adminUserController.js but never imported/mounted here, leaving every route
// in it (including /dashboard/auth/login and /dashboard/auth/accept-invite)
// unreachable in production. Must be mounted at '/' BEFORE the /dashboard
// requireApiKey mount below â€” the file declares its own full paths and its
// login/accept-invite routes are intentionally unauthenticated (that's how a
// session token is obtained in the first place); mounting after the
// requireApiKey('/dashboard') line would make login permanently 401.
app.use('/', adminUserRoutes);

// Dashboard
app.use('/dashboard', createRateLimiter(120), requireApiKey, dashboardRoutes);

// Admin routes â€” ORDER IS LOAD-BEARING.
// Express matches routes in registration order. /admin/tenants MUST be mounted
// BEFORE /admin so requests to /admin/tenants/* hit requireSuperAdminKey (master
// key only) and are not also caught by the broader /admin mount which accepts
// tenant api keys via requireApiKey. If you ever add routes to adminRoutes that
// start with /tenants they will be silently shadowed by tenantRoutes above â€”
// put them in tenantRoutes instead, or use a prefix that avoids the collision.
// [FIX-SAKEY] Super admin key rotation â€” POST /admin/rotate-super-key
// IMPORTANT: This route MUST be registered BEFORE the broad `app.use('/admin', ...)` mount.
// Express matches routes in registration order; if the /admin mount comes first it will
// catch POST /admin/rotate-super-key (matching /rotate-super-key inside adminRoutes) before
// this handler ever runs, making the endpoint unreachable.
app.post('/admin/rotate-super-key', adminLimiter, requireSuperAdminKey, (_req, res) => {
  const candidate = crypto.randomBytes(40).toString('hex'); // 80 hex chars, 320 bits
  logger.info('[SuperAdmin] Super-admin key rotation candidate generated');
  res.json({
    ok: true,
    candidate,
    instructions: [
      '1. Copy the candidate key above.',
      '2. Set SUPER_ADMIN_API_KEY=<candidate> in your Railway / Render environment.',
      '3. Redeploy the service â€” the new key becomes active on startup.',
      '4. Verify access with the new key before discarding the old one.',
    ],
    warning: 'This endpoint does not invalidate the current key. Redeploy is required.',
  });
});

// WhatsApp onboarding â€” tenant-facing (/api/whatsapp/*) and admin-facing (/admin/whatsapp/*)
// Must be mounted BEFORE the broad /admin mount to prevent /admin/whatsapp/* being caught
// by /admin (which uses requireApiKey, not requireSuperAdminKey â€” the admin sub-routes
// apply their own middleware internally via requireSuperAdminKey).
// [FIX-MOUNT-1] whatsappOnboardingRoutes â€” tenant-facing /api/whatsapp/* and
// admin-facing /admin/whatsapp/* â€” must be mounted before the broad /admin catch-all.
app.use('/', whatsappOnboardingRoutes);
app.use('/admin/tenants', adminLimiter, requireSuperAdminKey, tenantRoutes);
app.use('/admin',         adminLimiter, requireApiKey,        adminRoutes);

app.use(errorHandler);

// â”€â”€ Startup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let httpServer = null;

async function start() {
  await connectToDB();
  await registerAllModules();

  const ai = await aiHealthCheck();
  logger.info(`[AI] Groq:  ${ai.groq.ok   ? 'âœ“ ' + ai.groq.model   : 'âœ— ' + ai.groq.error}`);
  logger.info('[AI] Mock:  always available (deterministic fallback)');
  if (!ai.groq.ok && isProduction) {
    logger.warn('[AI] WARNING: No live AI provider in production â€” mock/deterministic fallback active');
  }

  // [IMPROVE-ENCRYPTION-WARN] tenantController's encryptToken() silently falls
  // back to storing WhatsApp accessToken/verifyToken/webhookSecret/meta.appSecret
  // as PLAINTEXT if ENCRYPTION_KEY is unset â€” with only a per-call debug-level log
  // line, easy to miss entirely in normal operation. Surface this once, loudly, at
  // boot, since these are real tenant secrets (each tenant's own dedicated Meta
  // app credentials), not placeholder data.
  if (!process.env.ENCRYPTION_KEY) {
    logger.warn(
      '[SECURITY] ENCRYPTION_KEY is not set â€” WhatsApp access tokens, verify tokens, ' +
      'webhook secrets, and Meta app secrets will be stored in PLAINTEXT in MongoDB ' +
      'for every tenant. Set ENCRYPTION_KEY (any non-empty string â€” it is SHA-256 ' +
      'hashed internally) in your Railway environment, then re-save each existing ' +
      "tenant's WhatsApp credentials once to encrypt values that were saved before " +
      'this was set (existing plaintext values do not retroactively encrypt themselves).'
    );
  }

  startScheduler();
  provisionBookingDateFlowsOnStartup().catch(() => {});

  const PORT = process.env.PORT || 5000;
  httpServer = app.listen(PORT, () => {
    const modeList = getSupportedModes().map(m => m.toLowerCase()).join(' Â· ');
    logger.info(`\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”`);
    logger.info(`  WhatSales E-Commerce Store Bot v${version} â€” ${process.env.NODE_ENV} â€” port ${PORT}`);
    logger.info(`  Modes: ${modeList}`);
    logger.info(`  Simulation: ${process.env.SIMULATION_MODE === 'true' ? 'ON (dev)' : 'OFF (live Meta webhook)'}`);
    logger.info(`  Cloudinary: ${CLOUDINARY_ENABLED ? 'ON (image uploads enabled)' : 'OFF (set CLOUDINARY_* vars to enable)'}`);
    logger.info(`â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”`);
  });
}

async function gracefulShutdown(signal) {
  logger.info(`[Shutdown] ${signal} received â€” draining connections`);
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
// [FIX-STAY-ALIVE-1] Previously called process.exit(1) here, inconsistent with
// the unhandledRejection handler immediately above (which only logs) and with
// the log-and-stay-alive policy already established elsewhere on this platform
// specifically to stop one tenant's error from taking down every other
// tenant's bot on this same process. A single uncaught exception in, say, one
// tenant's message-handling code path would otherwise kill the whole server â€”
// every other tenant's webhook, dashboard, and API traffic goes down with it
// until the process manager restarts it. Log and keep the process alive
// instead; this trades a (rare, already-logged) risk of continuing after
// truly corrupted process state for guaranteed multi-tenant isolation on the
// far more common case of one bad code path in one tenant's flow.
process.on('uncaughtException', (err) => {
  logger.error('[Process] Uncaught exception', { err: err.message, stack: err.stack?.slice(0, 400) });
});

start().catch(err => {
  logger.error('[Startup] Fatal', { err: err.message });
  process.exit(1);
});

export default app;

