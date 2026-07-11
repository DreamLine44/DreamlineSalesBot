/**
 * services/promoService.js  [PROMO-1]
 *
 * Discount code validation + application, sitting entirely inside the
 * config layer. This is intentionally called from ONE place —
 * orderService.saveOrder() — at the moment an order is persisted, the same
 * integration point already used for stock decrement (see
 * decrementStockForOrder in orderService.js). It never reads or writes
 * Session, never touches flow/step state, and has zero effect on any tenant
 * that hasn't created a promotion — so existing bot behaviour is unchanged
 * unless a tenant explicitly opts in via the dashboard.
 *
 * A promo code currently has to be typed in by whoever is placing the order.
 * None of the WhatsApp module flows prompt for one today — wiring a
 * "Got a promo code?" step into all ~9 module flows is a separate, larger
 * change (each module's order flow has its own confirmation step). This
 * service and the dashboard CRUD are the config-safe foundation for that;
 * saveOrder() already accepts and applies a promoCode whenever a caller
 * (dashboard-created order, future flow step, admin tool) supplies one.
 */

import BusinessConfig from '../models/BusinessConfig.js';
import logger from '../config/logger.js';

/**
 * validatePromoCode
 *
 * Pure-ish validation against the CURRENT state of a tenant's promotions —
 * does not mutate anything. Callers that intend to actually consume a use
 * should call applyPromoUsage() afterwards (see saveOrder()).
 *
 * @returns {{ valid: true, promotion, discountAmount, newTotal }}
 *        | { valid: false, reason }
 */
export async function validatePromoCode(tenantId, code, subtotal) {
  if (!code || typeof code !== 'string') {
    return { valid: false, reason: 'No promo code provided' };
  }
  if (subtotal == null || Number.isNaN(Number(subtotal))) {
    return { valid: false, reason: 'Order has no known subtotal to discount' };
  }

  const normalizedCode = code.trim().toUpperCase();
  const business = await BusinessConfig.findOne({ tenantId })
    .select('promotions').lean();
  if (!business) return { valid: false, reason: 'Business not found' };

  const promotion = (business.promotions || []).find(p => p.code === normalizedCode);
  if (!promotion) return { valid: false, reason: 'Invalid promo code' };
  if (!promotion.active) return { valid: false, reason: 'This promo code is no longer active' };
  if (promotion.expiresAt && new Date(promotion.expiresAt) < new Date()) {
    return { valid: false, reason: 'This promo code has expired' };
  }
  if (promotion.maxUses != null && promotion.usedCount >= promotion.maxUses) {
    return { valid: false, reason: 'This promo code has reached its usage limit' };
  }
  if (promotion.minOrderValue && Number(subtotal) < promotion.minOrderValue) {
    return {
      valid: false,
      reason: `Minimum order value for this code is ${promotion.minOrderValue}`,
    };
  }

  const rawDiscount = promotion.type === 'PERCENT'
    ? (Number(subtotal) * promotion.value) / 100
    : promotion.value;

  // Never discount below zero, and never discount more than the subtotal itself.
  const discountAmount = Math.min(Math.max(rawDiscount, 0), Number(subtotal));
  const newTotal = Math.max(Number(subtotal) - discountAmount, 0);

  return { valid: true, promotion, discountAmount, newTotal };
}

/**
 * applyPromoUsage
 *
 * Atomically increments usedCount for a promo code, but only if it's still
 * under its maxUses at the moment of the write (guards the same
 * check-then-write race documented in dashboardController.addMenuItem —
 * acceptable here for the same reason: this is a best-effort usage counter,
 * not a payment-authorization system). Never throws outward — a failed
 * increment must not roll back an order that has already been created.
 *
 * [AUDIT-FIX-PROMO-RACE] The docstring above always described a maxUses
 * guard "at the moment of the write", but the update query used to be a
 * plain `{ tenantId, 'promotions.code': code }` filter with no maxUses
 * condition at all — every call unconditionally incremented usedCount.
 * Two concurrent saveOrder() calls that both call validatePromoCode() while
 * usedCount is one below maxUses both see `valid: true` (validatePromoCode
 * is a separate, earlier read) and then both increments land here,
 * pushing usedCount past maxUses with nothing to stop it. A simple
 * `usedCount: { $lt: maxUses }` filter can't be expressed against a plain
 * `$elemMatch` because it needs to compare two fields of the *same* array
 * element to each other, and maxUses is nullable (unlimited-use codes)
 * — so this now uses a pipeline update ($map/$cond), which MongoDB
 * evaluates atomically server-side: only the matching promotions entry
 * gets its usedCount bumped, and only when maxUses is null/unset or
 * usedCount is still strictly below it.
 */
export async function applyPromoUsage(tenantId, code) {
  if (!code) return;
  const normalizedCode = code.trim().toUpperCase();
  try {
    await BusinessConfig.updateOne(
      { tenantId, 'promotions.code': normalizedCode },
      [
        {
          $set: {
            promotions: {
              $map: {
                input: '$promotions',
                as: 'p',
                in: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$$p.code', normalizedCode] },
                        {
                          $or: [
                            { $eq: ['$$p.maxUses', null] },
                            { $lt: ['$$p.usedCount', '$$p.maxUses'] },
                          ],
                        },
                      ],
                    },
                    { $mergeObjects: ['$$p', { usedCount: { $add: [{ $ifNull: ['$$p.usedCount', 0] }, 1] } }] },
                    '$$p',
                  ],
                },
              },
            },
          },
        },
      ],
    );
  } catch (err) {
    logger.warn('[PromoService] applyPromoUsage failed (non-fatal)', { err: err.message, tenantId, code });
  }
}
