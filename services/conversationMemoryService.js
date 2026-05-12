/**
 * services/conversationMemoryService.js — DreamLine SalesBot v13.0
 *
 * PURPOSE:
 *   Provides a durable memory layer that survives session expiry.
 *   Used specifically to anchor a customer's active order across:
 *     - Payment proof retries
 *     - Session TTL expiry during long Wave transactions
 *     - Admin payment rejection → customer resend cycles
 *
 * DESIGN:
 *   Uses Order.notes as a JSON anchor stored on the order document itself.
 *   No new collections, no migration required. The anchor contains only the
 *   customer phone and tenantId — the proof of linkage. The Order document
 *   is the source of truth for all order data.
 *
 *   This service is ADDITIVE to sessions, not a replacement. The session
 *   still drives conversation state. This service only kicks in when:
 *     1. A screenshot arrives with no active session (TTL expired), OR
 *     2. A proof upload is rejected and needs to link back to the same order.
 *
 * EXPORTED FUNCTIONS:
 *   anchorOrderToCustomer(orderId, customerPhone, tenantId)
 *     Called by flowService when PAYMENT_PROOF step begins.
 *     Stores a linkage note on the order so we can find it later.
 *
 *   findActiveOrderForProof(customerPhone, tenantId)
 *     Called by paymentService / webhookController when processing a screenshot.
 *     Returns the best matching order for this customer, including rejected orders
 *     eligible for re-upload.
 *
 *   clearOrderAnchor(orderId)
 *     Called when order reaches terminal state (paid / completed / cancelled).
 *     Removes the memory anchor — the order record stays, only the anchor is cleared.
 */

import Order  from '../models/Order.js';
import logger from '../config/logger.js';

// How long (hours) we consider an order eligible for proof upload
// Default: 48h so customers who pay on a different day can still upload
const PROOF_ELIGIBLE_HOURS = parseInt(process.env.PROOF_ELIGIBLE_HOURS, 10) || 48;

// ─── ANCHOR ──────────────────────────────────────────────────────────────────
/**
 * Store a lightweight anchor on the Order record that links it to the customer.
 * This is idempotent — safe to call multiple times (e.g. if the session restarts).
 */
export const anchorOrderToCustomer = async (orderId, customerPhone, tenantId) => {
  try {
    const anchor = JSON.stringify({
      __memAnchor: true,
      customerPhone,
      tenantId:   String(tenantId),
      anchoredAt: new Date().toISOString(),
    });

    await Order.findByIdAndUpdate(orderId, {
      $set: { notes: anchor },
    });

    logger.info('[ConversationMemory] Order anchored', { orderId, customerPhone });
  } catch (err) {
    // Non-critical — log and continue; worst case is the customer gets the
    // "couldn't find order" error, which is gracefully handled downstream.
    logger.warn('[ConversationMemory] Anchor write failed', { orderId, err: err.message });
  }
};

// ─── FIND ACTIVE ORDER FOR PROOF ─────────────────────────────────────────────
/**
 * Find the best order for a customer that is eligible to receive a proof upload.
 *
 * Priority:
 *   1. Orders in 'unpaid' status (first upload)
 *   2. Orders in 'payment_failed' status with paymentProof cleared (retry after rejection)
 *   3. Orders in 'payment_pending_verification' with paymentProof null (edge case)
 *
 * Returns the Order document, or null if nothing eligible is found.
 */
export const findActiveOrderForProof = async (customerPhone, tenantId) => {
  const cutoff = new Date(Date.now() - PROOF_ELIGIBLE_HOURS * 60 * 60 * 1000);

  try {
    // Single query covering all eligible states, most recent first
    const order = await Order.findOne({
      tenantId,
      customerPhone,
      paymentStatus: { $in: ['unpaid', 'payment_failed', 'payment_pending_verification'] },
      paymentProof:  null,          // only accept if no proof is stored (idempotent)
      createdAt:     { $gte: cutoff },
    })
    .sort({ createdAt: -1 })
    .lean();

    if (order) {
      logger.info('[ConversationMemory] Active order found for proof', {
        orderId: order._id,
        status:  order.paymentStatus,
        customerPhone,
      });
    }

    return order;
  } catch (err) {
    logger.error('[ConversationMemory] findActiveOrderForProof error', { err: err.message, customerPhone });
    return null;
  }
};

// ─── CHECK ALREADY PENDING ────────────────────────────────────────────────────
/**
 * Check if a customer already has a proof in verification (duplicate upload guard).
 * Returns the order if found, null otherwise.
 */
export const findPendingVerification = async (customerPhone, tenantId) => {
  const cutoff = new Date(Date.now() - PROOF_ELIGIBLE_HOURS * 60 * 60 * 1000);

  try {
    return await Order.findOne({
      tenantId,
      customerPhone,
      paymentStatus: 'payment_pending_verification',
      paymentProof:  { $ne: null },
      createdAt:     { $gte: cutoff },
    })
    .sort({ createdAt: -1 })
    .lean();
  } catch (err) {
    logger.error('[ConversationMemory] findPendingVerification error', { err: err.message });
    return null;
  }
};

// ─── CLEAR ANCHOR ─────────────────────────────────────────────────────────────
/**
 * Remove the memory anchor from a terminal-state order.
 * The order record is preserved; only the anchor note is removed.
 */
export const clearOrderAnchor = async (orderId) => {
  try {
    const order = await Order.findById(orderId).select('notes').lean();
    if (!order?.notes) return;

    // Only clear if the note is an anchor (don't overwrite human-written notes)
    try {
      const parsed = JSON.parse(order.notes);
      if (parsed.__memAnchor) {
        await Order.findByIdAndUpdate(orderId, { $set: { notes: null } });
        logger.info('[ConversationMemory] Anchor cleared', { orderId });
      }
    } catch {
      // notes is not JSON (human-written note) — leave it alone
    }
  } catch (err) {
    logger.warn('[ConversationMemory] clearOrderAnchor error', { orderId, err: err.message });
  }
};
