/**
 * services/revenueEngineService.js — Dreamline Sales Bot v10.0
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  REVENUE ENGINE — SAFE OPTIONAL LAYER                           ║
 * ║                                                                 ║
 * ║  This service handles all revenue-driving logic in a            ║
 * ║  controlled, non-intrusive way.                                 ║
 * ║                                                                 ║
 * ║  RULES (strict):                                                ║
 * ║  ✅ One upsell suggestion per session (never repeated)          ║
 * ║  ✅ Upsell only shown AFTER order summary, BEFORE payment       ║
 * ║  ✅ Customer can decline — no retry, no pressure                ║
 * ║  ✅ Revenue tracked per order for analytics                     ║
 * ║                                                                 ║
 * ║  NEVER:                                                         ║
 * ║  ❌ Interrupt active flows                                       ║
 * ║  ❌ Send unsolicited messages                                   ║
 * ║  ❌ Override system logic                                       ║
 * ║  ❌ Auto-confirm payments                                        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import { getModeConfig } from '../config/modes.js';
import { trackRevenue }  from './analyticsService.js';
import logger            from '../config/logger.js';

// ─── Upsell selection ─────────────────────────────────────────────────────────
//
// Picks one random add-on from the mode's configured addOns list.
// Returns null if no add-ons configured, or session already had upsell shown.
//
// RULES:
//  - Called ONCE per order (upsellSent guards re-show)
//  - Returns { name, price } or null
//  - Caller decides when to show it — this service never sends messages

export function selectUpsell(business, session) {
  // Guard: already shown this session
  if (session?.upsellSent) return null;

  const cfg    = getModeConfig(business);
  const addOns = cfg?.addOns || [];
  if (!addOns.length) return null;

  // Pick a random add-on from the mode preset list
  const addOn = addOns[Math.floor(Math.random() * addOns.length)];
  return { name: addOn.name, price: addOn.price };
}

// ─── Apply upsell to order data ───────────────────────────────────────────────
//
// When customer accepts the upsell, merge it into the order:
//   - Append add-on name to item string (e.g. "Jollof Rice + Soft Drink")
//   - Add price to running total
//
// Returns { item, totalPrice } with updated values.
// Safe: if pendingAddOn is null, returns original values unchanged.

export function applyUpsell(item, totalPrice, pendingAddOn) {
  if (!pendingAddOn) return { item, totalPrice };

  const updatedTotal = (totalPrice || 0) + (pendingAddOn.price || 0);
  const updatedItem  = `${item} + ${pendingAddOn.name}`;

  logger.info('[RevenueEngine] Upsell accepted', {
    addOn:    pendingAddOn.name,
    addedAmt: pendingAddOn.price,
    newTotal: updatedTotal,
  });

  return { item: updatedItem, totalPrice: updatedTotal };
}

// ─── Track order revenue ──────────────────────────────────────────────────────
//
// Called after order finalization. Records revenue for analytics.
// Fails silently — never blocks order completion.

export async function recordOrderRevenue({ item, quantity, totalPrice, phoneNumberId, customerPhone }) {
  if (!totalPrice || totalPrice <= 0) return;

  try {
    await trackRevenue({
      item,
      quantity,
      revenue:       totalPrice,
      phoneNumberId,
      customerPhone,
    });

    logger.info('[RevenueEngine] Revenue recorded', {
      item,
      quantity,
      revenue:       totalPrice,
      phoneNumberId,
    });
  } catch (err) {
    // Never let analytics failure block order flow
    logger.error('[RevenueEngine] Revenue tracking failed (non-fatal)', {
      err: err.message,
    });
  }
}

// ─── Revenue summary helper ───────────────────────────────────────────────────
//
// Returns a human-readable revenue summary string for admin alerts.
// Example: "D450 (3× Jollof Rice + Soft Drink)"

export function buildRevenueSummary(item, quantity, totalPrice, currency = 'GMD') {
  if (!totalPrice) return null;
  return `${currency} ${totalPrice} (${quantity}× ${item})`;
}
