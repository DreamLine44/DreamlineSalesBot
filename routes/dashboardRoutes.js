/**
 * routes/dashboardRoutes.js — Dreamline Sales Bot v6.0
 *
 * Client self-service dashboard routes.
 * All routes require x-api-key (requireApiKey middleware applied in app.js).
 *
 * Note: requireApiKey blocks PENDING tenants (WhatsApp not yet connected).
 * For PENDING tenants, use /register/* routes instead.
 */

import { Router } from 'express';
import {
  getOverview,
  getProfile,
  updateProfile,
  getBotConfig,
  updateBotConfig,
  addMenuItem,
  removeMenuItem,
  updateMenuItems,
  updateHours,
  addFaqEntry,
  removeFaqEntry,
  getStats,
  rotateApiKey,
} from '../controllers/dashboardController.js';

const router = Router();

// ── Overview ─────────────────────────────────────────────────────────────────
// GET /dashboard
router.get('/', getOverview);

// ── Profile ──────────────────────────────────────────────────────────────────
// GET  /dashboard/profile
// PUT  /dashboard/profile
router.get('/profile',  getProfile);
router.put('/profile',  updateProfile);

// ── Bot configuration ─────────────────────────────────────────────────────────
// GET /dashboard/bot
// PUT /dashboard/bot
router.get('/bot', getBotConfig);
router.put('/bot', updateBotConfig);

// ── Menu management ───────────────────────────────────────────────────────────
// GET    /dashboard/bot/menu          → (use GET /dashboard/bot for full config including menu)
// PUT    /dashboard/bot/menu          → replace entire menu array
// POST   /dashboard/bot/menu          → add single item
// DELETE /dashboard/bot/menu/:itemId  → remove single item
router.put('/bot/menu',           updateMenuItems);
router.post('/bot/menu',          addMenuItem);
router.delete('/bot/menu/:itemId', removeMenuItem);

// ── Hours ─────────────────────────────────────────────────────────────────────
// PUT /dashboard/bot/hours
router.put('/bot/hours', updateHours);

// ── FAQ ───────────────────────────────────────────────────────────────────────
// POST   /dashboard/bot/faq          → add FAQ entry
// DELETE /dashboard/bot/faq/:faqId   → remove FAQ entry
router.post('/bot/faq',           addFaqEntry);
router.delete('/bot/faq/:faqId',  removeFaqEntry);

// ── Stats ─────────────────────────────────────────────────────────────────────
// GET /dashboard/stats
router.get('/stats', getStats);

// ── Security ──────────────────────────────────────────────────────────────────
// POST /dashboard/rotate-key
router.post('/rotate-key', rotateApiKey);

export default router;
