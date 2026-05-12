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

import { trackRevenue }  from './analyticsService.js';
import logger            from '../config/logger.js';

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



