/**
 * routes/onboardingRoutes.js — WhatsBotLyn v12
 *
 * Public self-serve onboarding. No SUPER_ADMIN_API_KEY required.
 * Mounted in app.js as: app.use('/register', rateLimiter, onboardingRoutes)
 *
 *   POST /register              — Step 1: create account → returns apiKey
 *   GET  /register/status       — Check onboarding progress (requires apiKey)
 *   POST /register/business     — Step 2: configure bot   (requires apiKey)
 *   PUT  /register/whatsapp     — Step 3: connect WhatsApp (requires apiKey)
 *
 * Additionally mounted in app.js as: app.use('/onboarding', onboardingRoutes)
 *   GET  /onboarding/callback   — Meta Embedded Signup OAuth redirect target
 *                                 (no auth — Meta redirects here with ?code=...)
 */

import { Router } from 'express';
import { requireApiKeyForOnboarding } from '../middlewares/authMiddleware.js';
import {
  registerBusiness,
  setupBusiness,
  connectWhatsApp,
  getOnboardingStatus,
  handleMetaCallback,
} from '../controllers/onboardingController.js';

const router = Router();

// Step 1 — public (no auth)
router.post('/', registerBusiness);

// Steps 2, 3 and status — require the apiKey returned from step 1
router.get('/status',    requireApiKeyForOnboarding, getOnboardingStatus);
router.post('/business', requireApiKeyForOnboarding, setupBusiness);
router.put('/whatsapp',  requireApiKeyForOnboarding, connectWhatsApp);

// [FIX-CALLBACK] Meta Embedded Signup OAuth redirect — public, no auth.
// META_REDIRECT_URI in .env points to /onboarding/callback.
// This route MUST be public — Meta redirects the browser here with ?code=...
// and the server exchanges the code for an access token server-side.
router.get('/callback', handleMetaCallback);

export default router;
