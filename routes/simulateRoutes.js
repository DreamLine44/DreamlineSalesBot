/**
 * routes/simulateRoutes.js
 *
 * Local testing endpoints — no Meta account required.
 *
 * POST   /api/message              Send a message as a customer
 * POST   /api/reset                Clear a customer session
 * GET    /api/session/:userId      Inspect current session state
 * GET    /api/businesses           List all configured businesses
 *
 * Example:
 *   curl -X POST http://localhost:5000/api/message \
 *     -H "Content-Type: application/json" \
 *     -d '{"userId":"test_user_1","message":"I want to order food"}'
 */
import { Router } from 'express';
import {
  simulateMessage, simulateReset,
  simulateGetSession, listBusinesses,
} from '../controllers/simulateController.js';

const r = Router();
r.post('/message',        simulateMessage);
r.post('/reset',          simulateReset);
r.get('/session/:userId', simulateGetSession);
r.get('/businesses',      listBusinesses);
export default r;
