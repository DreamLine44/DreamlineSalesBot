/**
 * routes/adminMessageRoutes.js
 *
 * Mounted at /admin/messages — exposes ONLY the failed-message replay endpoints.
 * Previously businessRoutes was mounted here, which incorrectly exposed all
 * business config, orders, and booking routes under /admin/messages too.
 */

import { Router } from 'express';
import {
  listFailedMessages,
  replayFailedMessage,
} from '../controllers/ordersController.js';

const router = Router();

// GET  /admin/messages/failed-messages
// POST /admin/messages/failed-messages/:id/replay
router.get('/failed-messages',             listFailedMessages);
router.post('/failed-messages/:id/replay', replayFailedMessage);

export default router;
