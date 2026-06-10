/**
 * routes/webhookRoutes.js — WhatSalesAgent2 (Production)
 *
 * Changes from dev:
 *  - POST /webhook now runs verifyMetaSignature BEFORE receiveWebhook.
 *    This ensures unauthenticated requests are rejected at the route level
 *    before any DB or business logic runs.
 */
import { Router } from 'express';
import { verifyWebhook, receiveWebhook } from '../controllers/webhookController.js';
import { verifyMetaSignature } from '../middleware/webhookSignature.js';

const r = Router();

// GET — Meta webhook subscription verification (no signature on GET)
r.get('/',  verifyWebhook);

// POST — incoming messages (verify Meta signature before processing)
r.post('/', verifyMetaSignature, receiveWebhook);

export default r;
