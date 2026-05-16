/**
 * routes/simulationRoutes.js — DreamLine SalesBot v23.0
 *
 * Phase 2: Simulate WhatsApp conversations locally without Meta.
 *
 * All routes protected by SIMULATION_SECRET (x-sim-key header).
 * Only active when SIMULATION_MODE=true in .env.
 *
 * Quick test with curl:
 *   curl -X POST http://localhost:5000/api/messages \
 *     -H "Content-Type: application/json" \
 *     -H "x-sim-key: sim_dev_key_change_in_production" \
 *     -d '{"userId":"customer_001","message":"I want to order"}'
 *
 * Or with Bruno:
 *   POST http://localhost:5000/api/messages
 *   Header: x-sim-key: sim_dev_key_change_in_production
 *   Body: { "userId": "customer_001", "message": "I want to order" }
 */

import express from 'express';
import {
  simulateMessage,
  getSimSession,
  clearSimSession,
  getSimHistory,
  listSimBusinesses,
  resetSimUser,
} from '../controllers/simulationController.js';
import logger from '../config/logger.js';

const router = express.Router();

// ── Simulation key guard ───────────────────────────────────────────────────────
function requireSimKey(req, res, next) {
  const simSecret  = process.env.SIMULATION_SECRET;
  const provided   = req.headers['x-sim-key'];

  if (!simSecret) {
    // No secret configured → allow (dev convenience)
    return next();
  }

  if (!provided || provided !== simSecret) {
    return res.status(401).json({
      error: 'Missing or invalid x-sim-key header',
      hint:  'Set SIMULATION_SECRET in your .env and pass it as x-sim-key header',
    });
  }
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/messages
 * Simulate an inbound WhatsApp message from a customer.
 *
 * Body: { userId, message, businessId?, mediaType? }
 * Returns: { userId, input, reply, ui, meta }
 */
router.post('/messages', requireSimKey, simulateMessage);

/**
 * GET /api/session?userId=&businessId=
 * Inspect the current session state for a simulated user.
 */
router.get('/session', requireSimKey, getSimSession);

/**
 * DELETE /api/session
 * Clear the session for a simulated user (simulate conversation end/timeout).
 * Body: { userId, businessId? }
 */
router.delete('/session', requireSimKey, clearSimSession);

/**
 * GET /api/history?userId=&businessId=
 * Get the full conversation history for a simulated user.
 */
router.get('/history', requireSimKey, getSimHistory);

/**
 * GET /api/businesses
 * List all business configs available for testing.
 */
router.get('/businesses', requireSimKey, listSimBusinesses);

/**
 * POST /api/reset
 * Full reset: clears session + history + UserProfile for a simulated user.
 * Body: { userId, businessId? }
 */
router.post('/reset', requireSimKey, resetSimUser);

/**
 * GET /api/health
 * Quick check that simulation mode is active.
 */
router.get('/health', (req, res) => {
  res.json({
    simulation: true,
    mode:       process.env.NODE_ENV,
    message:    'Simulation engine is active. POST /api/messages to test.',
    endpoints: {
      'POST /api/messages':   'Send a simulated customer message',
      'GET /api/session':     'Inspect session state (?userId=)',
      'DELETE /api/session':  'Clear session',
      'GET /api/history':     'Get conversation history (?userId=)',
      'GET /api/businesses':  'List test businesses',
      'POST /api/reset':      'Full user reset',
    },
  });
});

export default router;
