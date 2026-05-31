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
        type: 'buttons',
        body: `*${raw}* — perfect! 🎉\n\nWhat *date* do you need this for? 📅\n\n(e.g. *25 June*, *next Saturday*)`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
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
        return {
          type: 'buttons',
          body: '🎂 Ready to place your cake order?',
          buttons: [{ id: 'CONFIRM', title: '✅ Place Order' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          item:         `Custom Cake — ${data.flavor} (${data.size})`,
          quantity:     1,
          totalPrice:   0,
          customerPhone: session.customerPhone,
          tenantId:     session.tenantId,
          businessId:   business._id,
        });
      } catch (err) {
        logger.error('[BakeryModule] saveCakeOrder failed', { err: err.message });
      }

      // [FIX-9] Notify admin — bakery cake orders were placed silently with no alert
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
          const alert =
            `🎂 *Custom Cake Order — ${business?.name || 'Bakery'}*\n\n` +
            `👤 Customer: ${session.customerPhone}\n` +
            `🍰 Flavour: *${data.flavor}*\n` +
            `📏 Size: *${data.size}*\n` +
            `📅 For: *${data.eventDate}*\n` +
            `🔖 Ref: \`${savedOrder.shortId}\`\n\n` +
            `Please contact customer to confirm pricing.`;
          dispatchText(adminPhone, alert, tenant).catch(() => {});
        }
      } catch {}

      await completeFlow(session, 'ORDER', business, tenant);
      return {
        type: 'buttons',
        body: `✅ *Cake order placed!*\n\n🎂 *${data.flavor} cake (${data.size})*\n📅 For: *${data.eventDate}*\n\nWe'll be in touch to confirm details and pricing. Thank you! 🥐`,
        buttons: [
          { id: 'ORDER',     title: '🧁 Order More'      },
          { id: 'BOOK',      title: '📅 Book Collection' },
          { id: 'SHOW_MENU', title: '🔄 Start Over'      },
        ],
      };
    }
    default:
      return {
        type: 'buttons',
        body: '🎂 What flavour would you like for your cake?',
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
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
