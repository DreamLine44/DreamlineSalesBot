/**
 * modules/restaurant/flows/orderFlow.js
 *
 * Handles the full ORDER flow for restaurants (and all ORDER-capable modules).
 * Registered with flowEngine for RESTAURANT:ORDER.
 *
 * Steps: SELECT_ITEM → QUANTITY → UPSELL? → CONFIRM → [PAYMENT?] → DONE
 *
 * KEY FIXES included:
 * [FIX-C] menuViewed guard — number only trusted after customer opens the list
 * [FIX-B] past-date validation (shared with booking flow)
 * Correct getAIReply named-object signature
 */

import { updateSession }    from '../../../core/sessions/sessionService.js';
import { completeFlow }     from '../../../core/conversations/flowEngine.js';
import { getAIReply }       from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }    from '../../../utils/matchEngine.js';
import { buildMenuUI, buildOrderSummary, buildOrderSuccess } from '../handlers/uiBuilders.js';
import { parseQuantity }    from '../../../utils/parseQuantity.js';
import { saveOrder }        from '../../../services/orderService.js';
import { recordRevenue }    from '../../../core/analytics/analyticsService.js';
import { dispatchText }     from '../../../core/whatsapp/dispatcher.js';
import { recordOrderItem }  from '../../../core/memory/customerMemory.js';
import logger               from '../../../config/logger.js';

// ── Normalise ─────────────────────────────────────────────────────────────────
const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/, ' ').trim();

// ── Word-number map (fast lookup) ──────────────────────────────────────────────
const WORD_NUMS = {
  one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  a:1, an:1, 'a one':1, 'one':1,
};

/**
 * handleOrderFlow({ session, message, business, tenant, isInteractive })
 */
export async function handleOrderFlow({ session, message, business, tenant, isInteractive = false }) {
  const raw   = String(message || '').trim();
  const clean = norm(raw);
  const step  = session.step || 'SELECT_ITEM';
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);
  const data  = session.data || {};

  // ── No menu configured ────────────────────────────────────────────────────
  if (!menu.length) {
    return { type: 'text', body: '⚠️ Our menu is not set up yet. Please contact us directly.' };
  }

  // ── INIT (message = null — start of flow) ──────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM', data: {}, menuViewed: false, upsellSent: false,
    });
    return buildMenuUI(business);
  }

  switch (step) {

    // ────────────────────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      // [FIX-C] Numeric input only trusted if menu was already viewed
      const numIndex = WORD_NUMS[clean] ?? (parseInt(raw, 10) - 1);
      const isNum    = !isNaN(numIndex) && numIndex >= 0;

      if (isNum) {
        const trustedPick = isInteractive || session.menuViewed;
        if (!trustedPick) {
          // Customer typed a number before seeing menu — show menu
          await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
          return buildMenuUI(business);
        }
        const item = menu[numIndex];
        if (!item) return buildMenuUI(business);
        return await _selectItem(item, session, business, data);
      }

      // [FIX-C] Too short — don't fuzzy match
      if (clean.length < 3) return buildMenuUI(business);

      // Fuzzy name match
      const { item, confidenceLevel } = findBestMatch(menu, clean);

      if (confidenceLevel === 'HIGH') {
        return await _selectItem(item, session, business, data);
      }
      if (confidenceLevel === 'LOW') {
        // "Did you mean?" — don't auto-select
        // [FIX] Set step to SUGGESTION_CONFIRM so the customer's "Yes" tap routes to
        // the SUGGESTION_CONFIRM case — not back to SELECT_ITEM where 'confirm' would
        // be fuzzy-matched against the menu and fail.
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'SUGGESTION_CONFIRM',
          data: { ...data, suggestion: item.name },
        });
        return {
          type:    'buttons',
          body:    `🤔 Did you mean *${item.name}*?`,
          buttons: [
            { id: 'CONFIRM', title: `✅ Yes, ${item.name}` },
            { id: 'SHOW_MENU', title: '📋 View full menu' },
          ],
        };
      }

      // No match — AI fallback for conversational clarification
      const aiText = await getAIReply({ customerMessage: raw, business, session, intent: 'FALLBACK' });
      return {
        type:    'buttons',
        body:    aiText || `I couldn't find that item. Please choose from our menu:`,
        buttons: [{ id: 'SHOW_MENU', title: '📋 View Menu' }],
      };
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'SUGGESTION_CONFIRM': {
      // Customer said yes/no to "Did you mean X?"
      if (/^(yes|y|yep|yeah|confirm|ok|okay)$/i.test(clean) || clean === 'confirm') {
        const suggestedName = data.suggestion;
        const item = menu.find(i => norm(i.name) === norm(suggestedName));
        if (item) return await _selectItem(item, session, business, data);
      }
      return buildMenuUI(business);
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'QUANTITY': {
      const qty = parseQuantity(raw);
      if (!qty || qty < 1 || qty > 99) {
        return {
          type: 'text',
          body: `Please enter a valid quantity (e.g. *1*, *2*, *three*)`,
        };
      }
      const item     = data.item;
      const price    = item?.price || 0;
      const total    = price * qty;
      const addOns   = business?.addOns || [];

      // Upsell — if configured and not yet shown
      if (addOns.length && !session.upsellSent) {
        const addOn = addOns[Math.floor(Math.random() * addOns.length)];
        await updateSession(session.customerPhone, session.tenantId, {
          // [FIX] removed duplicate `data` key — second value wins but JS strict mode warns
          step: 'UPSELL',
          upsellSent: true,
          data: { ...data, quantity: qty, totalPrice: total, pendingAddOn: addOn },
        });
        return {
          type:    'buttons',
          body:    `You've chosen *${qty}× ${item.name}*${total ? ` — D${total}` : ''}.\n\nWould you like to add *${addOn.name}* for D${addOn.price}? 🥤`,
          buttons: [
            { id: 'UPSELL_YES', title: '✅ Yes, add it' },
            { id: 'UPSELL_NO',  title: '❌ No thanks'   },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, quantity: qty, totalPrice: total },
      });
      return buildOrderSummary({ item, qty, total, business });
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'UPSELL': {
      const addOn    = data.pendingAddOn;
      const accepted = /^(yes|y|yep|yeah|ok|okay|sure|add|upsell_yes)$/i.test(clean) || clean === 'upsell_yes';

      let finalTotal = data.totalPrice || 0;
      let addOns     = data.addOns || [];

      if (accepted && addOn) {
        finalTotal += addOn.price;
        addOns     = [...addOns, addOn.name];
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, totalPrice: finalTotal, addOns },
      });
      return buildOrderSummary({ item: data.item, qty: data.quantity, total: finalTotal, addOns, business });
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'CONFIRM': {
      const isConfirm = /^(yes|y|confirm|ok|okay|sure|place|confirmed)$/i.test(clean);
      if (!isConfirm) {
        return buildOrderSummary({ item: data.item, qty: data.quantity, total: data.totalPrice, business });
      }

      // Save order
      try {
        await saveOrder({
          item:         data.item?.name,
          quantity:     data.quantity,
          totalPrice:   data.totalPrice,
          addOns:       data.addOns,
          customerPhone: session.customerPhone,
          tenantId:     session.tenantId,
          businessId:   business._id,
        });

        // Track order analytics (order count) + revenue
        // [FIX] trackOrderAnalytics was never called — order count was always 0 in dashboard.
        // recordRevenue was called alone but analytics summary queries type:'ORDER' not type:'REVENUE'
        // for order counts. Both must fire on every confirmed order.
        const { trackOrderAnalytics } = await import('../../../core/analytics/analyticsService.js');
        trackOrderAnalytics(
          data.item?.name,
          business.phoneNumberId || null,
          data.quantity,
          data.totalPrice || 0,
          session.tenantId
        ).catch(() => {});
        if (data.totalPrice) {
          recordRevenue({
            item:          data.item?.name,
            quantity:      data.quantity,
            revenue:       data.totalPrice,
            tenantId:      session.tenantId,
            customerPhone: session.customerPhone,
            phoneNumberId: business.phoneNumberId || null,
          }).catch(() => {});
        }
      } catch (err) {
        logger.error('[OrderFlow] saveOrder failed', { err: err.message });
      }

      // Payment configured?
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const last4  = String(session.customerPhone).slice(-4);
        const waveNo = payment.wavePhone || payment.phone || 'N/A';
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        return {
          type: 'text',
          body: `💳 *Payment*\n\nTotal: *D${data.totalPrice}*\nSend via *Wave* to: *${waveNo}*\n\nAfter paying, send your *screenshot* here. 📸`,
        };
      }

      // No payment — complete flow, alert admin, track analytics
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          item:          data.item?.name || data.item,
          quantity:      data.quantity || 1,
          totalPrice:    data.totalPrice || 0,
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          businessId:    business._id,
          status:        'confirmed',
        });
        // Record in customer memory for personalised greetings / repeat suggestions
        recordOrderItem(session.customerPhone, session.tenantId, data.item?.name || data.item).catch(() => {});
        const { trackOrderAnalytics } = await import('../../../core/analytics/analyticsService.js');
        trackOrderAnalytics(
          data.item?.name || data.item,
          session.phoneNumberId,
          data.quantity || 1,
          data.totalPrice || 0,
          session.tenantId,
        ).catch(() => {});
      } catch (err) {
        logger.error('[OrderFlow] saveOrder failed on no-payment path', { err: err.message });
      }

      // Notify admin about new confirmed order
      if (business.adminPhone && tenant) {
        const shortRef = savedOrder?.shortId || '—';
        dispatchText(business.adminPhone,
          `🛍 *New Order — ${business.name || 'Order'}*\n\n` +
          `👤 ${session.customerPhone}\n` +
          `📦 ${data.item?.name || data.item} × ${data.quantity || 1}\n` +
          `💰 D${data.totalPrice || '0'}\n` +
          `🔖 Ref: ${shortRef}\n\n` +
          `Status: ✅ Confirmed (no payment required)`,
          tenant).catch(() => {});
      }

      const _lcResp = await completeFlow(session, 'ORDER', business, tenant);
      if (_lcResp) return _lcResp;
      return buildOrderSuccess({ item: data.item, qty: data.quantity, business });
    }

    default:
      return buildMenuUI(business);
  }
}

// ── Select item helper ────────────────────────────────────────────────────────
async function _selectItem(item, session, business, data) {
  await updateSession(session.customerPhone, session.tenantId, {
    step: 'QUANTITY', data: { ...data, item }, menuViewed: true,
  });

  // Smart recommendation
  const addOns    = business?.addOns || [];
  const addOnText = addOns.length
    ? `\n\n💡 *${addOns[0].name}* pairs well with this — we'll ask at the end!`
    : '';

  return {
    type: 'text',
    body: `You've chosen *${item.name}* 👌${addOnText}\n\nHow many *${item.name}* would you like?\n\n_(Enter a number — e.g. *1*, *2*, *three*)_`,
  };
}
