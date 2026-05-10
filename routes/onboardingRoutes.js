/**
 * routes/onboardingRoutes.js — Dreamline Sales Bot v7.0
 *
 * Mounted in app.js as: app.use('/register', rateLimiter, onboardingRoutes)
 *
 * ── SIMPLE FLOW (2 requests) ──────────────────────────────────────────────────
 *   PUT  /register/whatsapp   → Step 1: validate Meta + create tenant + return apiKey (ONCE)
 *   POST /register/business   → Step 2: configure bot (requires x-api-key)
 *
 * ── UNIFIED FLOW (1 request) ──────────────────────────────────────────────────
 *   POST /register/full       → Step 1 + Step 2 in one shot (returns apiKey ONCE)
 *
 * ── STATUS ────────────────────────────────────────────────────────────────────
 *   GET  /register/status     → onboarding progress (requires x-api-key)
 *
 * ── LEGACY (backward compat) ──────────────────────────────────────────────────
 *   POST /register            → old email/name registration (kept so existing integrations don't break)
 *
 * ── META OAUTH (also mounted at /onboarding/callback in app.js) ───────────────
 *   GET  /register/callback   → Meta Embedded Signup redirect (public, no auth)
 */

import { Router } from 'express';
import { requireApiKeyForOnboarding, optionalApiKey } from '../middlewares/authMiddleware.js';
import {
  registerBusiness,
  setupBusiness,
  connectWhatsApp,
  fullOnboardingHandler,
  getOnboardingStatus,
  handleMetaCallback,
} from '../controllers/onboardingController.js';

const router = Router();

// ── Public (no auth) ──────────────────────────────────────────────────────────

// Step 1: Connect WhatsApp → creates tenant → returns apiKey ONCE
// Also handles Step 3 of the email-first flow: if x-api-key is present,
// updates the existing tenant's WhatsApp credentials instead of creating a new one.
router.put('/whatsapp', optionalApiKey, connectWhatsApp);

// Unified: Step 1 + Step 2 in one request → returns apiKey ONCE
// (No auth: includes WhatsApp connect = registration)
router.post('/full', fullOnboardingHandler);

// Legacy email/name registration (backward compat)
router.post('/', registerBusiness);

// Meta OAuth callback (public — Meta redirects here)
router.get('/callback', handleMetaCallback);

// ── Authenticated (requires x-api-key from Step 1) ────────────────────────────

// Step 2: Configure bot
router.post('/business', requireApiKeyForOnboarding, setupBusiness);

// Onboarding progress check
router.get('/status', requireApiKeyForOnboarding, getOnboardingStatus);

export default router;
