/**
 * modules/bakery/flows/index.js
 * Bakery module â€” order + collection booking + custom cake builder
 */
import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow }   from '../../../core/conversations/flowEngine.js';
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { saveOrder }      from '../../../services/order/orderService.js';
import { saveBooking }    from '../../../services/booking/bookingService.js';
import logger             from '../../../config/logger.js';

export const BAKERY_CONFIG = {
  businessMode: 'BAKERY',
  flows: ['ORDER', 'BOOKING'],
  persona: 'warm bakery assistant who loves fresh baked goods and reminds customers about daily specials',
  steps: {
    // [CART-AI] CART_REVIEW added â€” reached from SELECT_ITEM on a multi-item
    // message, mirroring restaurant/salon's MULTICART-v39-PHASE2 pattern.
    ORDER:   ['BROWSE_CATEGORY', 'SELECT_ITEM', 'CART_REVIEW', 'QUANTITY', 'CONFIRM'],
    BOOKING: ['SELECT_SERVICE', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
  },
  ui: {
    welcomeButtons: [
      { id: 'ORDER',    title: 'ðŸ§ Place an Order'      },
      { id: 'BOOK',     title: 'ðŸ“… Schedule Collection' },
      { id: 'QUESTION', title: 'â“ Ask a Question'      },
    ],
    fallbackButtons: [
      { id: 'ORDER',    title: 'ðŸ§ Order'    },
      { id: 'BOOK',     title: 'ðŸ“… Collect'  },
      { id: 'QUESTION', title: 'â“ Question' },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: 'âœ… Confirm Order' }, { id: 'CANCEL', title: 'âŒ Cancel' }],
    upsellButtons:  [{ id: 'UPSELL_YES', title: 'âœ… Add it' },    { id: 'UPSELL_NO', title: 'âŒ No thanks' }],
  },
  messages: {
    welcome:       'ðŸ¥ Welcome! Fresh baked just for you. What can we get you?',
    orderPrompt:   "ðŸŽ‚ Here's what's fresh today â€” choose your item:",
    cancelMsg:     'âœ… Cancelled! Come back any time â€” we bake fresh daily ðŸ¥',
    fallback:      'Would you like to *order*, *schedule a collection*, or ask a *question*?',
  },
};

// â”€â”€ Custom cake builder flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function handleCakeCustomization({ session, message, business, tenant }) {
  const raw  = String(message || '').trim();
  const step = session.step || 'CAKE_FLAVOR';
  const data = session.data || {};

  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'CAKE_FLAVOR', data: {} });
    return {
      type: 'buttons',
      body: 'ðŸŽ‚ *Custom Cake Builder*\n\nWhat *flavour* would you like?',
      buttons: [
        { id: 'FLAVOR_VANILLA',   title: 'ðŸ¦ Vanilla'     },
        { id: 'FLAVOR_CHOCOLATE', title: 'ðŸ« Chocolate'   },
        { id: 'FLAVOR_REDVELVET', title: 'â¤ï¸ Red Velvet'  },
      ],
    };
  }

  switch (step) {
    case 'CAKE_FLAVOR': {
      const FLAVOR_MAP = {
        'FLAVOR_VANILLA':   'Vanilla',
        'FLAVOR_CHOCOLATE': 'Chocolate',
        'FLAVOR_REDVELVET': 'Red Velvet',
        'FLAVOR_CARROT':    'Carrot',
        'FLAVOR_LEMON':     'Lemon',
      };
      const flavor = FLAVOR_MAP[raw.toUpperCase()] || raw;
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAKE_SIZE', data: { ...data, flavor },
      });
      return {
        type: 'buttons',
        body: `*${flavor}* â€” great choice! ðŸŽ‚\n\nWhat *size* do you need?`,
        buttons: [
          { id: 'SIZE_SMALL',  title: 'ðŸŽ‚ Small (6â€³)'   },
          { id: 'SIZE_MEDIUM', title: 'ðŸŽ‚ Medium (8â€³)'  },
          { id: 'SIZE_LARGE',  title: 'ðŸŽ‚ Large (10â€³)'  },
        ],
      };
    }
    case 'CAKE_SIZE': {
      const SIZE_MAP = {
        'SIZE_SMALL':  'Small (6 inch)',
        'SIZE_MEDIUM': 'Medium (8 inch)',
        'SIZE_LARGE':  'Large (10 inch)',
        'SIZE_XL':     'Extra Large (12 inch)',
      };
      const size = SIZE_MAP[raw.toUpperCase()] || raw;
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAKE_EVENT_DATE', data: { ...data, size },
      });
      return {
        type: 'buttons',
        body: `*${size}* â€” perfect! ðŸŽ‰\n\nWhat *date* do you need this cake for? ðŸ“…\n\n_(e.g. *25 June*, *next Saturday*)_`,
        buttons: [{ id: 'CANCEL', title: 'âŒ Cancel' }],
      };
    }
    case 'CAKE_EVENT_DATE': {
      // [FIX-TIME-2] Bakery cake event date had zero validation â€” a customer
      // could type "yesterday" and the order would confirm with a past date.
      // Import shared helpers to enforce the same rules as the booking flow.
      const { tryParseDate } = await import('../../../core/conversations/bookingFlow.js');
      // [FIX-TZ-BAKERY] business?.timezone was reading a non-existent top-level field.
      // timezone lives at business.hours.timezone (BusinessConfig schema). The silent
      // undefined caused tryParseDate and all local-midnight calculations to fall back
      // to UTC, so "tomorrow" in West Africa Time was one hour ahead of UTC midnight â€”
      // meaning an evening order for "tomorrow" would sometimes be rejected as "past".
      const cakeParsed = tryParseDate(raw, business?.hours?.timezone);
      if (cakeParsed) {
        const tz = business?.hours?.timezone || 'UTC';
        // Midnight in the business's local clock
        const localNow = (() => {
          const safeZone = (() => { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; } catch { return 'UTC'; } })();
          const parts = new Intl.DateTimeFormat('en-CA', { timeZone: safeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour12: false }).formatToParts(new Date());
          const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
          return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
        })();
        if (cakeParsed < localNow) {
          const fmt = cakeParsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
          return {
            type: 'buttons',
            body: `âš ï¸ *${fmt}* has already passed.\n\nPlease enter an *upcoming date* for your cake. ðŸ“…\n\n_(e.g. *25 June*, *next Saturday*)_`,
            buttons: [{ id: 'CANCEL', title: 'âŒ Cancel' }],
          };
        }
        const maxFuture = new Date(localNow); maxFuture.setUTCMonth(maxFuture.getUTCMonth() + 18);
        if (cakeParsed > maxFuture) {
          return {
            type: 'buttons',
            body: `âš ï¸ That date is too far ahead. Please choose a date within the next 18 months. ðŸ“…`,
            buttons: [{ id: 'CANCEL', title: 'âŒ Cancel' }],
          };
        }
      }
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CAKE_CONFIRM', data: { ...data, eventDate: raw },
      });
      const summary =
        `ðŸŽ‚ *Custom Cake Summary*\n\n` +
        `ðŸ° Flavour: *${data.flavor}*\n` +
        `ðŸ“ Size: *${data.size}*\n` +
        `ðŸ“… For: *${raw}*\n\nShall we proceed?`;
      return {
        type: 'buttons',
        body: summary,
        buttons: [{ id: 'CONFIRM', title: 'âœ… Place Order' }, { id: 'CANCEL', title: 'âŒ Cancel' }],
      };
    }
    case 'CAKE_CONFIRM': {
      if (!/^(yes|y|confirm|ok|sure)$/i.test(raw.toLowerCase())) {
        return {
          type: 'buttons',
          body: 'ðŸŽ‚ Ready to place your cake order?',
          buttons: [{ id: 'CONFIRM', title: 'âœ… Place Order' }, { id: 'CANCEL', title: 'âŒ Cancel' }],
        };
      }
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          item:         `Custom Cake â€” ${data.flavor} (${data.size})`,
          quantity:     1,
          totalPrice:   0,
          customerName:  session.customerName || null, // [FIX-SAVE-2]
          customerPhone: session.customerPhone,
          tenantId:     session.tenantId,
          businessId:   business._id,
        });
      } catch (err) {
        logger.error('[BakeryModule] saveCakeOrder failed', { err: err.message });
        // [FIX-SAVE-ERR-CAKE] Don't tell the customer the cake order was placed when
        // nothing was persisted and admin was never notified. Clear flow, let retry.
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {},
        });
        return {
          type:    'buttons',
          body:    `âš ï¸ *Something went wrong saving your cake order.*\n\nPlease try again â€” tap below to start over.`,
          buttons: [
            { id: 'ORDER',    title: 'ðŸŽ‚ Try Again'   },
            { id: 'SUPPORT',  title: 'ðŸ’¬ Contact Us'  },
          ],
        };
      }

      // [FIX-9] Notify admin â€” bakery cake orders were placed silently with no alert
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
          const alert =
            `ðŸŽ‚ *Custom Cake Order â€” ${business?.name || 'Bakery'}*\n\n` +
            `ðŸ‘¤ Customer: ${session.customerPhone}\n` +
            `ðŸ° Flavour: *${data.flavor}*\n` +
            `ðŸ“ Size: *${data.size}*\n` +
            `ðŸ“… For: *${data.eventDate}*\n` +
            `ðŸ”– Ref: \`${savedOrder.shortId}\`\n\n` +
            `Please contact customer to confirm pricing.`;
          dispatchText(adminPhone, alert, tenant).catch(() => {});
        }
      } catch {}

      // [FIX-2] Capture return value â€” completeFlow may return a lead-capture UIResponse
      const _lcRbk = await completeFlow(session, 'ORDER', business, tenant);
      if (_lcRbk) return _lcRbk;
      return {
        type: 'buttons',
        body: `âœ… *Cake order placed!*\n\nðŸŽ‚ *${data.flavor} cake (${data.size})*\nðŸ“… For: *${data.eventDate}*\n\nWe'll be in touch to confirm details and pricing. Thank you! ðŸ¥`,
        buttons: [
          { id: 'ORDER',     title: 'ðŸ§ Order More'      },
          { id: 'BOOK',      title: 'ðŸ“… Book Collection' },
          { id: 'SHOW_MENU', title: 'ðŸ”„ Start Over'      },
        ],
      };
    }
    default:
      return {
        type: 'buttons',
        body: 'ðŸŽ‚ What flavour would you like for your cake?',
        buttons: [{ id: 'CANCEL', title: 'âŒ Cancel' }],
      };
  }
}

// â”€â”€ Standard order flow â€” dedicated bakery flow (NOT the restaurant proxy) â”€â”€â”€
export { handleBakeryOrderFlow as handleBakeryOrder } from './orderFlow.js';

// â”€â”€ Booking/collection flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function handleBakeryBooking({ session, message, business, tenant, isInteractive }) {
  return handleBookingFlow({ session, message, business, tenant, isInteractive });
}

