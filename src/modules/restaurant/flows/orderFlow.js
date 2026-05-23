/**
 * modules/restaurant/flows/orderFlow.js
 *
 * Handles the full ORDER flow for restaurants (and all ORDER-capable modules).
 * Registered with flowEngine for RESTAURANT:ORDER and as the generic ORDER handler.
 *
 * Steps: SELECT_ITEM → QUANTITY → [UPSELL?] → CONFIRM → [PAYMENT?] → DONE
 *
 * FIXES:
 * [FIX-1] norm() regex was missing the 'g' flag — only the FIRST whitespace run was
 *         collapsed. "jollof  rice  combo" → "jollof rice  combo" (double-space survives).
 *         Fuzzy matching then failed against the normalised item name. Fixed: /\s+/g.
 *
 * [FIX-2] WORD_NUMS was 1-based (one:1, two:2 …) but numIndex feeds directly into
 *         menu[numIndex]. "one" gave menu[1] (the SECOND item). Fixed: now 0-indexed.
 *
 * [FIX-3] After order confirm with no payment configured, the admin was never notified.
 *         Cash/no-payment restaurants had silent orders — admin had no idea.
 *         Fixed: dispatchText() to adminPhone after every successful order save.
 *
 * [FIX-4] Payment step was reusing session data without re-fetching — race condition
 *         on slow connections. Now reads totalPrice from confirmed data object.
 */

import { updateSession }    from '../../../core/sessions/sessionService.js';
import { completeFlow }     from '../../../core/conversations/flowEngine.js';
import { getAIReply }       from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }    from '../../../utils/matchEngine.js';
import { buildMenuUI, buildOrderSummary, buildOrderSuccess } from '../handlers/uiBuilders.js';
import { parseQuantity }    from '../../../utils/parseQuantity.js';
import { saveOrder }        from '../../../services/orderService.js';
import { recordRevenue, trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import { dispatchText }     from '../../../core/whatsapp/dispatcher.js';
import logger               from '../../../config/logger.js';

// ── Normalise — [FIX-1] /\s+/ was missing the 'g' flag ──────────────────────
const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Word-number map — 0-indexed — [FIX-2] was 1-based causing off-by-1 errors ─
// "one" → menu[0], "two" → menu[1], etc. (parseInt path already does -1)
const WORD_NUMS = {
  one:0, two:1, three:2, four:3, five:4, six:5, seven:6, eight:7, nine:8, ten:9,
  a:0, an:0,
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
    return {
      type:    'buttons',
      body:    '⚠️ Our menu is being updated. Please contact us directly.',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
    };
  }

  // ── INIT (message = null — start of flow) ─────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM', data: {}, menuViewed: false, upsellSent: false,
    });
    return buildMenuUI(business);
  }

  switch (step) {

    // ────────────────────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      // [FIX-2] 0-indexed WORD_NUMS: WORD_NUMS['one']=0 → menu[0] ✓
      const numIndex = WORD_NUMS[clean] ?? (parseInt(raw, 10) - 1);
      const isNum    = !isNaN(numIndex) && numIndex >= 0;

      if (isNum) {
        const trustedPick = isInteractive || session.menuViewed;
        if (!trustedPick) {
          // Typed a number before seeing menu — show menu first
          await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
          return buildMenuUI(business);
        }
        const item = menu[numIndex];
        if (!item) return buildMenuUI(business);
        return await _selectItem(item, session, business, data);
      }

      // Cancel / escape keywords — let the flow engine handle them
      if (/^(cancel|stop|exit|back|menu|home)$/i.test(clean)) {
        return buildMenuUI(business);
      }

      // Too short — show a gentle nudge instead of just dumping the menu again
      if (clean.length < 3) {
        return {
          type:    'buttons',
          body:    `Please type the name of what you'd like to order, or tap *View Menu* to see all options:`,
          buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
        };
      }

      // Casual chat / greetings — customer is in ordering mode, redirect politely
      const CASUAL_RE = /^(hello|hi+|hey|helo|howdy|yo|sup|good morning|good afternoon|good evening|gm|ok|okay|k+|yes|no|nope|yep|yeah|sure|thanks|thank you|thx|ty|tq|lol|haha|why|what|how|who|huh|hmm|test|ping)$/i;
      if (CASUAL_RE.test(clean)) {
        return {
          type:    'buttons',
          body:    `Hi there! 😊 You're currently in the middle of placing an order.\n\nPlease type the name of what you'd like to order, or browse our menu:`,
          buttons: [
            { id: 'SHOW_MENU', title: '🔄 View Menu' },
            { id: 'CANCEL',    title: '❌ Cancel'    },
          ],
        };
      }

      // Fuzzy name match
      const { item, confidenceLevel } = findBestMatch(menu, clean);

      if (confidenceLevel === 'HIGH') {
        return await _selectItem(item, session, business, data);
      }
      if (confidenceLevel === 'LOW') {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'SUGGESTION_CONFIRM',
          data: { ...data, suggestion: item.name },
        });
        return {
          type:    'buttons',
          body:    `🤔 Did you mean *${item.name}*?`,
          buttons: [
            { id: 'CONFIRM', title: `✅ Yes, ${item.name.slice(0,15)}` },
            { id: 'SHOW_MENU', title: '🔄 Start Over' },
          ],
        };
      }

      // No match — show helpful nudge, not just a raw menu dump
      return {
        type:    'buttons',
        body:    `I couldn't find "*${raw.slice(0,30)}*" on our menu.\n\nTap below to browse all items:`,
        buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'SUGGESTION_CONFIRM': {
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
      // MAX_QTY is per-business configurable; default 20 for restaurants.
      // Read from business.settings.maxOrderQuantity if set, otherwise 20.
      const MAX_QTY = business?.settings?.maxOrderQuantity || 20;

      // Can't parse at all (e.g. "any", "yes", blank)
      if (!qty || qty < 1) {
        return {
          type:    'buttons',
          body:    `Please enter a number — e.g. *1*, *2*, *three*\n\n_(Maximum: ${MAX_QTY} per order)_`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      // Parsed fine but exceeds the business max
      if (qty > MAX_QTY) {
        return {
          type:    'buttons',
          body:    `⚠️ Maximum order quantity is *${MAX_QTY}*. Please enter a number between *1* and *${MAX_QTY}*.`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      const item   = data.item;
      const price  = item?.price || 0;
      const total  = price * qty;
      const addOns = business?.addOns || [];

      // Upsell — if configured and not yet shown
      if (addOns.length && !session.upsellSent) {
        // [FIX-14] Pin the add-on at first selection — re-use the stored one if we
        // somehow reach this branch again (e.g. after a session update race) so the
        // customer never sees different add-on offers across retries.
        const addOn = data.pendingAddOn || addOns[Math.floor(Math.random() * addOns.length)];
        await updateSession(session.customerPhone, session.tenantId, {
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
      let addOnsList = data.addOns || [];

      if (accepted && addOn) {
        finalTotal += addOn.price;
        addOnsList  = [...addOnsList, addOn.name];
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, totalPrice: finalTotal, addOns: addOnsList },
      });
      return buildOrderSummary({ item: data.item, qty: data.quantity, total: finalTotal, addOns: addOnsList, business });
    }

    // ────────────────────────────────────────────────────────────────────────
    case 'CONFIRM': {
      const isConfirm = /^(yes|y|confirm|ok|okay|sure|place|confirmed)$/i.test(clean);
      if (!isConfirm) {
        return buildOrderSummary({ item: data.item, qty: data.quantity, total: data.totalPrice, business });
      }

      // Save order
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          item:          data.item?.name,
          quantity:      data.quantity,
          totalPrice:    data.totalPrice,
          addOns:        data.addOns,
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          businessId:    business._id,
        });

        // Track analytics
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
        const waveNo = payment.wavePhone || payment.phone || 'N/A';
        const shortId = savedOrder?.shortId || '';
        // Generate reference: DSB-MMDD-XXXX
        const now    = new Date();
        const mmdd   = String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0');
        const ref    = `DSB-${mmdd}-${shortId}`;

        // Store the reference on the order
        if (savedOrder?._id) {
          const { default: Order } = await import('../../../models/Order.js');
          Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
        }

        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });

        // Notify admin that a new order is pending payment
        try {
          const adminPhone = business?.adminPhone || tenant?.adminPhone;
          if (adminPhone && tenant && savedOrder) {
            const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
            const currency = payment.currency || 'D';
            await dispatchMessage(adminPhone, {
              type: 'text',
              body:
                `🔔 *New Order — ${business.name || 'Restaurant'}*\n\n` +
                `👤 Customer: *${session.customerPhone}*\n` +
                `🛒 Items: *${data.quantity}× ${data.item?.name}*\n` +
                `💰 Total: *${currency}${data.totalPrice}*\n` +
                `📝 Ref: *${ref}*\n\n` +
                `⏳ Status: *Pending* — awaiting payment screenshot.`,
            }, tenant).catch(() => {});
          }
        } catch { /* non-fatal */ }

        return {
          type: 'text',
          body:
            `💳 *Payment Instructions*\n\n` +
            `🛒 Total: *${payment.currency || 'D'}${data.totalPrice}*\n` +
            `📝 Reference: *${ref}*\n\n` +
            `─────────────────────\n` +
            `📲 Send *${payment.currency || 'D'}${data.totalPrice}* via *Wave* to:\n\n` +
            `📱 *${waveNo}*\n\n` +
            `⚠️ Use *${ref}* as your payment reference.\n` +
            `─────────────────────\n\n` +
            `After sending, please *reply with a screenshot* of your Wave confirmation.\n\n` +
            `We'll verify and confirm your order shortly ✅`,
        };
      }

      // [FIX-3] No payment — notify admin with interactive buttons
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { buildAdminOrderAlertBody } = await import('../handlers/uiBuilders.js');
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const alertBody = buildAdminOrderAlertBody({
            customerPhone: session.customerPhone,
            item:          data.item?.name,
            quantity:      data.quantity,
            totalPrice:    data.totalPrice,
            addOns:        data.addOns,
            shortId:       savedOrder.shortId,
            business,
          });
          await dispatchMessage(adminPhone, {
            type:    'buttons',
            body:    alertBody,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Received' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'     },
            ],
          }, tenant).catch(() => {});
        }
      } catch (err) {
        logger.warn('[OrderFlow] Admin notification failed (non-fatal)', { err: err.message });
      }

      const _lcR = await completeFlow(session, 'ORDER', business, tenant);
      if (_lcR) return _lcR;
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

  const addOns    = business?.addOns || [];
  const addOnText = addOns.length
    ? `\n\n💡 *${addOns[0].name}* pairs well with this — we'll ask at checkout!`
    : '';

  return {
    type: 'buttons',
    body: `You've chosen *${item.name}* 👌${addOnText}\n\nHow many *${item.name}* would you like?\n\n_(Enter a number — e.g. *1*, *2*, *three*)_`,
    buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
  };
}
