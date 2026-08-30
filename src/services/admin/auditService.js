/**
 * services/auditService.js
 *
 * Single-function audit trail writer. Always fire-and-forget.
 * A write failure here must NEVER block order processing.
 *
 * Usage:
 *   import { logAudit } from '../services/admin/auditService.js';
 *   logAudit({ tenantId, orderId, actor: 'admin', actorId: adminPhone,
 *              action: 'payment_approved', metadata: { shortId } });
 *   // Do NOT await — non-blocking by design.
 */

import AuditLog from '../../models/AuditLog.js';
import logger   from '../../config/logger.js';

/**
 * logAudit — write one audit entry.
 *
 * @param {object} params
 * @param {string|ObjectId} params.tenantId   - required
 * @param {string|ObjectId} [params.orderId]  - optional; pass null when no order
 * @param {'admin'|'customer'|'system'} params.actor
 * @param {string} [params.actorId]           - phone, 'system', or 'scheduler'
 * @param {string} params.action              - one of AuditLog action enum values
 * @param {object} [params.metadata]          - arbitrary JSON
 *
 * Returns a Promise — callers should NOT await it. Logs on failure.
 */
export const logAudit = ({ tenantId, orderId = null, actor, actorId = null, action, metadata = {} }) => {
  return AuditLog.create({
    tenantId,
    orderId:  orderId  || null,
    actor,
    actorId:  actorId  || null,
    action,
    metadata,
  }).catch(err => {
    // Log but never throw — audit failures must not interrupt order processing.
    logger.warn('[AuditService] Failed to write audit log (non-fatal)', {
      action, tenantId: String(tenantId), err: err.message,
    });
  });
}

