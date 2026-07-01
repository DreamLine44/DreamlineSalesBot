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
      body: '🎂 *Custom Cake Builder*\n\nWhat *flavour* would you like?',
      buttons: [
        { id: 'FLAVOR_VANILLA',   title: '🍦 Vanilla'     },
        { id: 'FLAVOR_CHOCOLATE', title: '🍫 Chocolate'   },
        { id: 'FLAVOR_REDVELVET', title: '❤️ Red Velvet'  },
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
        body: `*${flavor}* — great choice! 🎂\n\nWhat *size* do you need?`,
        buttons: [
          { id: 'SIZE_SMALL',  title: '🎂 Small (6″)'   },
          { id: 'SIZE_MEDIUM', title: '🎂 Medium (8″)'  },
          { id: 'SIZE_LARGE',  title: '🎂 Large (10″)'  },
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
        body: `*${size}* — perfect! 🎉\n\nWhat *date* do you need this cake for? 📅\n\n_(e.g. *25 June*, *next Saturday*)_`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }
    case 'CAKE_EVENT_DATE': {
      // [FIX-TIME-2] Bakery cake event date had zero validation — a customer
      // could type "yesterday" and the order would confirm with a past date.
      // Import shared helpers to enforce the same rules as the booking flow.
      const { tryParseDate } = await import('../../../core/conversations/bookingFlow.js');
      // [FIX-TZ-BAKERY] business?.timezone was reading a non-existent top-level field.
      // timezone lives at business.hours.timezone (BusinessConfig schema). The silent
      // undefined caused tryParseDate and all local-midnight calculations to fall back
      // to UTC, so "tomorrow" in West Africa Time was one hour ahead of UTC midnight —
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
            body: `⚠️ *${fmt}* has already passed.\n\nPlease enter an *upcoming date* for your cake. 📅\n\n_(e.g. *25 June*, *next Saturday*)_`,
            buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
          };
        }
        const maxFuture = new Date(localNow); maxFuture.setUTCMonth(maxFuture.getUTCMonth() + 18);
        if (cakeParsed > maxFuture) {
          return {
            type: 'buttons',
            body: `⚠️ That date is too far ahead. Please choose a date within the next 18 months. 📅`,
            buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
          };
        }
      }
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
          body:    `⚠️ *Something went wrong saving your cake order.*\n\nPlease try again — tap below to start over.`,
          buttons: [
            { id: 'ORDER',    title: '🎂 Try Again'   },
            { id: 'SUPPORT',  title: '💬 Contact Us'  },
          ],
        };
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

      // [FIX-2] Capture return value — completeFlow may return a lead-capture UIResponse
      const _lcRbk = await completeFlow(session, 'ORDER', business, tenant);
      if (_lcRbk) return _lcRbk;
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

// ── Standard order flow — dedicated bakery flow (NOT the restaurant proxy) ───
export { handleBakeryOrderFlow as handleBakeryOrder } from './orderFlow.js';

// ── Booking/collection flow ───────────────────────────────────────────────────
export async function handleBakeryBooking({ session, message, business, tenant, isInteractive }) {
  return handleBookingFlow({ session, message, business, tenant, isInteractive });
}
