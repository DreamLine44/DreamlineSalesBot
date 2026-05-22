/**
 * modules/bakery/flows/index.js
 * Bakery module — order + collection booking + custom cake builder
 */
import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow }   from '../../../core/conversations/flowEngine.js';
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { saveOrder }      from '../../../services/orderService.js';
import { saveBooking }    from '../../../services/bookingService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import { recordOrderItem }     from '../../../core/memory/customerMemory.js';
import { dispatchText }        from '../../../core/whatsapp/dispatcher.js';
import logger             from '../../../config/logger.js';

export const BAKERY_CONFIG = {
  businessMode: 'BAKERY',
  flows: ['ORDER', 'BOOKING'],
  persona: 'warm bakery assistant who loves fresh baked goods and reminds customers about daily specials',
  steps: {
    ORDER:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: '🧁 Place an Order'      },
      { id: 'BOOK',     title: '📅 Schedule Collection' },
      { id: 'QUESTION', title: '❓ Ask a Question'      },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: '🧁 Order'    },
      { id: 'BOOK',     title: '📅 Collect'  },
      { id: 'QUESTION', title: '❓ Question' },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: '✅ Confirm Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
    upsellButtons:  [{ id: 'UPSELL_YES', title: '✅ Add it' },    { id: 'UPSELL_NO', title: '❌ No thanks' }],
  },
  messages: {
    welcome:       '🥐 Welcome! Fresh baked just for you. What can we get you?',
    orderPrompt:   "🎂 Here's what's fresh today — choose your item:",
    cancelMsg:     '✅ Cancelled! Come back any time — we bake fresh daily 🥐',
    fallback:      'Would you like to *order*, *schedule a collection*, or ask a *question*?',
  },
};

// ── Custom cake builder flow ───────────────────────────────────────────────────
export async function handleCakeCustomization({ session, message, business, tenant }) {
  const raw  = String(message || '').trim();
  const step = session.step || 'CAKE_FLAVOR';
  const data = session.data || {};

  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'CAKE_FLAVOR', data: {} });
    return {
      type: 'buttons',
      body: '🎂 *Custom Cake Builder*\n\nWhat *flavour* would you like?\n\n• Vanilla\n• Chocolate\n• Red Velvet\n• Carrot\n• Lemon',
      buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
    };
  }

  switch (step) {
    case 'CAKE_FLAVOR': {
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAKE_SIZE', data: { ...data, flavor: raw },
      });
      return {
        type: 'buttons',
        body: `*${raw}* — great choice! 🎂\n\nWhat *size* do you need?\n\n• Small (6 inch)\n• Medium (8 inch)\n• Large (10 inch)\n• Extra Large (12 inch)`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }
    case 'CAKE_SIZE': {
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAKE_EVENT_DATE', data: { ...data, size: raw },
      });
      return {
        type: 'text',
        body: `*${raw}* — perfect! 🎉\n\nWhat *date* do you need this for? 📅\n\n(e.g. *25 June*, *next Saturday*)`,
      };
    }
    case 'CAKE_EVENT_DATE': {
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAKE_CONFIRM', data: { ...data, eventDate: raw },
      });
      const summary =
        `🎂 *Custom Cake Summary*\n\n` +
        `🍰 Flavour: *${data.flavor}*\n` +
        `📏 Size: *${data.size}*\n` +
        `📅 For: *${raw}*\n\nShall we proceed?`;
      return {
        type: 'buttons',
        body: summary,
        buttons: [{ id: 'CONFIRM', title: '✅ Place Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
      };
    }
    case 'CAKE_CONFIRM': {
      if (!/^(yes|y|confirm|ok|sure)$/i.test(raw.toLowerCase())) {
        return { type: 'text', body: 'Tap *Confirm* to place your cake order, or *Cancel* to start over.' };
      }

      // Payment gate
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const waveNo = payment.wavePhone || payment.phone || 'N/A';
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        return {
          type: 'text',
          body: `💳 *Payment*\n\nTotal: *D${data.totalPrice}*\nSend via *Wave* to: *${waveNo}*\n\nAfter paying, send your *screenshot* here. 📸`,
        };
      }

      const itemName = `Custom Cake — ${data.flavor} (${data.size})`;
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          item: itemName, quantity: 1, totalPrice: data.totalPrice || 0,
          customerPhone: session.customerPhone, tenantId: session.tenantId, businessId: business._id,
          status: 'confirmed',
        });
        recordOrderItem(session.customerPhone, session.tenantId, itemName).catch(() => {});
        trackOrderAnalytics(itemName, session.phoneNumberId, 1, data.totalPrice || 0, session.tenantId).catch(() => {});
      } catch (err) {
        logger.error('[BakeryModule] saveCakeOrder failed', { err: err.message });
      }
      const _lcResp = await completeFlow(session, 'ORDER', business, tenant);
      if (_lcResp) return _lcResp;

      if (business.adminPhone && tenant) {
        dispatchText(business.adminPhone,
          `🎂 *New Cake Order — ${business.name || 'Bakery'}*\n\n` +
          `👤 ${session.customerPhone}\n` +
          `🎂 ${itemName}\n📅 For: ${data.eventDate || 'TBD'}\n` +
          `🔖 #${savedOrder?.shortId || '—'}`,
          tenant).catch(() => {});
      }

      return {
        type: 'text',
        body: `✅ *Cake order placed!*\n\n🎂 *${data.flavor} cake (${data.size})*\n📅 For: *${data.eventDate}*\n\nWe'll be in touch to confirm details and pricing. Thank you! 🥐`,
      };
    }
    default:
      return { type: 'text', body: 'What flavour would you like for your cake? 🎂' };
  }
}

// ── Standard order flow (delegates to shared order logic) ─────────────────────
export async function handleBakeryOrder({ session, message, business, tenant, isInteractive }) {
  const { handleOrderFlow } = await import('../../restaurant/flows/orderFlow.js');
  return handleOrderFlow({ session, message, business, tenant, isInteractive });
}

// ── Booking/collection flow ───────────────────────────────────────────────────
export async function handleBakeryBooking({ session, message, business, tenant, isInteractive }) {
  return handleBookingFlow({ session, message, business, tenant, isInteractive });
}
