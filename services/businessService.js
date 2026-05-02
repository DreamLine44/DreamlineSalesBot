/**
 * services/businessService.js
 *
 * Thin data-access layer for BusinessConfig documents.
 * Imported by webhookController (and anything else that needs to look up
 * a business by tenantId) so the Mongoose query is not scattered across
 * controllers.
 */

import mongoose from 'mongoose';
import BusinessConfig from '../models/BusinessConfig.js';
import logger from "../config/logger.js";

/**
 * Fetch the BusinessConfig for a given tenantId.
 * Returns null if not found — callers must handle the null case.
 *
 * [FIX-7] Cast string tenantId to ObjectId — Mongoose does NOT automatically
 * coerce strings to ObjectId for embedded document queries, so a plain string
 * will never match. Use the same cast-with-fallback pattern as flowService.
 *
 * @param {ObjectId|string} tenantId
 * @returns {Promise<object|null>}
 */
export async function getBusiness(tenantId) {
  try {
    let tid = tenantId;
    try { tid = new mongoose.Types.ObjectId(tenantId); } catch { /* keep original */ }
    return await BusinessConfig.findOne({ tenantId: tid }).lean();
  } catch (err) {
    logger.error('[businessService.getBusiness] DB error:', err.message);
    return null;
  }
}
