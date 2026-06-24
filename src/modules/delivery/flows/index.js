/**
 * modules/delivery/flows/index.js
 *
 * DELIVERY mode — dedicated flow for courier, on-demand delivery, and dark-kitchen businesses.
 * Not a re-skin of the restaurant — proper delivery-first personality:
 *   - Delivery address collection
 *   - Delivery slot / ASAP selection
 *   - Distance-aware messaging
 *   - Order tracking CTA
 *   - Rider dispatch notification to admin
 *
 * Flows:
 *   ORDER   — item → quantity → address → slot → confirm
 *   TRACKING — check order status
 */

import { updateSession }  from '../../../core/sessions/sessionService.js';
// [FIX-DELIVERY-IMPORT] completeFlow was imported but never called in this module.
// Delivery flow completion (postFlowAck + lead capture) is triggered by adminCommandService
// after admin APPROVE/REJECT — not inline here. Removed the dead import to prevent
// confusion during future audits about where flow completion happens.
import { getAIReply }     from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { saveOrder }      from '../../../services/orderService.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import { trackOrderAnalytics, recordRevenue } from '../../../core/analytics/analyticsService.js';
import logger             from '../../../config/logger.js';

// ── Config ────────────────────────────────────────────────────────────────────

export const DELIVERY_CONFIG = {
  businessMode: 'DELIVERY',
  flows: ['ORDER'],
  persona: 'a fast, efficient delivery coordinator who confirms orders quickly and provides clear delivery updates',
  steps: {
    ORDER: ['SELECT_ITEM', 'QUANTITY', 'DELIVERY_ADDRESS', 'DELIVERY_SLOT', 'CONFIRM'],
  },
  ui: {
    // [FIX-4BTN-DEL] Meta button cap is 3 — the 4th button (QUESTION) was silently
    // dropped by the dispatcher's .slice(0,3). Customers ordering delivery care most
    // about placing an order, viewing the menu, and tracking. SUPPORT handles questions.
    welcomeButtons: [
      { id: 'ORDER',       title: '🚚 Order Now'      },
      { id: 'SHOW_MENU',   title: '📋 View Menu'       },
      { id: 'TRACK_ORDER', title: '📍 Track My Order'  },
    ],
    fallbackButtons: [
      { id: 'ORDER',       title: '🚚 Order Now'     },
      { id: 'TRACK_ORDER', title: '📍 Track Order'   },
      { id: 'SHOW_MENU',   title: '📋 View Menu'     },
    ],
    confirmButtons: [
      { id: 'CONFIRM', title: '✅ Confirm Order' },
      { id: 'CANCEL',  title: '❌ Cancel'         },
    ],
  },
  messages: {
    welcome:      '🚚 Welcome! What would you like delivered today?\n\nBrowse our menu or type what you want.',
    orderPrompt:  '📋 What would you like to order?',
    cancelMsg:    '✅ Order cancelled. Come back whenever you\'re ready! 🚚',
    fallback:     'Would you like to *place an order*, *track a delivery*, or ask a *question*?',
  },
};

// ── Main Order Flow ───────────────────────────────────────────────────────────

export async function handleDeliveryOrder({ session, message, business, tenant, isInteractive }) {
  const raw   = String(message || '').trim();
  const clean = raw.toLowerCase();
  const step  = session.step || 'SELECT_ITEM';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    // [FIX-FLOW-STUCK] If menu is empty, clear the flow immediately so the
    // session is not stuck in ORDER state on every subsequent message.
    if (!menu.length) {
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, data: {},
      });
      return _buildMenuUI(menu, business);
    }
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM',
      data: {},
      menuViewed: false,
    });
    return _buildMenuUI(menu, business);
  }

  switch (step) {

    // ── SELECT_ITEM ───────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return _buildMenuUI(menu, business);
      }
      if (clean.length < 2) return _buildMenuUI(menu, business);

      const numIdx = parseInt(raw, 10) - 1;
      let item = (!isNaN(numIdx) && menu[numIdx]) ? menu[numIdx] : null;

      if (!item) {
        const { item: m, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH') {
          item = m;
        } else if (confidenceLevel === 'LOW' && m) {
          return {
            type: 'buttons',
            body: `Did you mean *${m.name}*?`,
            buttons: [
              { id: 'CONFIRM',   title: '✅ Yes'         },
              { id: 'SHOW_MENU', title: '📋 View Menu'   },
            ],
          };
        }
      }

      if (!item) {
        const aiReply = await getAIReply({
          customerMessage: raw,
          business,
          session,
          intent: 'DELIVERY_QUESTION',
        });
        return {
          type: 'buttons',
          body: aiReply || `Hmm, I couldn't find *"${raw}"*. Here's what we deliver:`,
          buttons: [
            { id: 'SHOW_MENU', title: '📋 View Menu'      },
            { id: 'QUESTION',  title: '❓ Ask a Question' },
          ],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'QUANTITY',
        data: { ...data, item },
        menuViewed: true,
      });

      const price = item.price ? ` — ${item.currency || '$'}${item.price}` : '';
      return {
        type: 'buttons',
        body: `🚚 *${item.name}*${price}\n\n${item.description ? `_${item.description}_\n\n` : ''}How many would you like?`,
        // [UX-DEL-1] Drop Cancel from qty row — 3-button limit. Cancel is on the next error screen.
        buttons: [
          { id: 'QTY_1', title: '1️⃣  1' },
          { id: 'QTY_2', title: '2️⃣  2' },
          { id: 'QTY_3', title: '3️⃣  3' },
        ],
        footer: 'Or type any number e.g. 4, 5, 10',
      };
    }

    // ── QUANTITY ──────────────────────────────────────────────────────────────
    case 'QUANTITY': {
      const qtyShortcut = { 'QTY_1': 1, 'QTY_2': 2, 'QTY_3': 3 };
      const qty = qtyShortcut[raw.toUpperCase()] ?? parseQuantity(raw);

      if (!qty || qty < 1 || qty > 50) {
        return {
          type: 'buttons',
          body: `How many *${data.item?.name}* would you like delivered?\n_(Enter a number)_`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
          footer: 'Or type any number',
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DELIVERY_ADDRESS',
        data: { ...data, quantity: qty },
      });

      // Check if we have a saved address from previous orders
      const savedAddress = session.savedAddress || null;

      if (savedAddress) {
        return {
          type: 'buttons',
          body: `📍 *Delivery Address*\n\nDeliver to your usual address?\n\n_${savedAddress}_`,
          buttons: [
            { id: 'USE_SAVED_ADDRESS', title: '✅ Yes, use this'     },
            { id: 'NEW_ADDRESS',       title: '📝 Use different one' },
          ],
        };
      }

      // [UX-ADDR-1] Show location-sharing tip + cancel. Pure text-only forced customers
      // to type before knowing what format was expected. Now we list the requirement
      // clearly and keep Cancel accessible without making them type first.
      return {
        type: 'buttons',
        body: `📍 *Delivery Address*\n\nPlease type your full delivery address below.\n\n` +
              `_Include: street name, area/neighbourhood, and a landmark for the rider._\n\n` +
              `*Example:* 15 Kairaba Ave, Bakau, near the mosque`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        footer: 'Type your address and send',
      };
    }

    // ── DELIVERY_ADDRESS ──────────────────────────────────────────────────────
    case 'DELIVERY_ADDRESS': {
      let address;

      if (raw.toUpperCase() === 'USE_SAVED_ADDRESS' && session.savedAddress) {
        address = session.savedAddress;
      } else if (raw.toUpperCase() === 'NEW_ADDRESS') {
        return {
          type: 'buttons',
          body: '📍 Please type your delivery address:\n\n_Include: street, area/neighbourhood, and a landmark for the rider._\n\n*Example:* 15 Kairaba Ave, Bakau, near the mosque',
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      } else {
        address = raw;
      }

      if (!address || address.length < 5) {
        return {
          type: 'buttons',
          body: '📍 Please provide a valid delivery address so we can send the rider to the right place.',
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      // Save address for future orders
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DELIVERY_SLOT',
        data:         { ...data, deliveryAddress: address },
        savedAddress: address,
      });

      // [UX-DEL-2] 4 slot options → list widget
      return {
        type: 'list',
        body: `⏱ *When do you need it?*\n\n📍 Delivering to: _${address}_`,
        button: 'Choose delivery time',
        sections: [{ title: 'Delivery Window', rows: [
          { id: 'SLOT_ASAP',     title: '🔥 ASAP',          description: 'As soon as possible'        },
          { id: 'SLOT_30',       title: '⏱ In ~30 mins',    description: 'Quick delivery'              },
          { id: 'SLOT_1HR',      title: '⏳ In ~1 hour',    description: 'Standard delivery'           },
          { id: 'SLOT_SCHEDULE', title: '📅 Schedule it',   description: 'Pick a specific time slot'   },
        ]}],
      };
    }

    // ── DELIVERY_SLOT ─────────────────────────────────────────────────────────
    case 'DELIVERY_SLOT': {
      const SLOT_MAP = {
        'SLOT_ASAP':     'ASAP (as soon as possible)',
        'SLOT_30':       'In approximately 30 minutes',
        'SLOT_1HR':      'In approximately 1 hour',
        'SLOT_SCHEDULE': null, // handled below
      };

      if (raw.toUpperCase() === 'SLOT_SCHEDULE') {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'DELIVERY_SLOT',
          data: { ...data, awaitingSlotText: true },
        });
        // [UX-7] Show a time-slot list instead of a blank text prompt.
        // Previously asked "What time would you like?" with only a Cancel button,
        // forcing customers to type "3pm today" with no guidance.
        return {
          type: 'list',
          body: '🕐 *Schedule Delivery*\n\nChoose a time slot or tap "Custom time" to type your own:',
          button: 'Choose time',
          sections: [
            {
              title: '🌅 Morning',
              rows: [
                { id: 'SCHED_9AM',  title: '9:00 AM',  description: 'Morning delivery' },
                { id: 'SCHED_10AM', title: '10:00 AM', description: 'Morning delivery' },
                { id: 'SCHED_11AM', title: '11:00 AM', description: 'Morning delivery' },
              ],
            },
            {
              title: '☀️ Afternoon',
              rows: [
                { id: 'SCHED_12PM', title: '12:00 PM', description: 'Midday delivery'    },
                { id: 'SCHED_2PM',  title: '2:00 PM',  description: 'Afternoon delivery' },
                { id: 'SCHED_4PM',  title: '4:00 PM',  description: 'Afternoon delivery' },
              ],
            },
            {
              title: '🌆 Evening',
              rows: [
                { id: 'SCHED_6PM',    title: '6:00 PM',    description: 'Evening delivery' },
                { id: 'SCHED_CUSTOM', title: '✏️ Custom time', description: 'Type a specific time' },
              ],
            },
          ],
          footer: 'Or type a time e.g. "3pm tomorrow"',
        };
      }

      // Resolve scheduled time-slot IDs to human-readable strings
      const SCHED_MAP = {
        'SCHED_9AM':  'Today at 9:00 AM',
        'SCHED_10AM': 'Today at 10:00 AM',
        'SCHED_11AM': 'Today at 11:00 AM',
        'SCHED_12PM': 'Today at 12:00 PM',
        'SCHED_2PM':  'Today at 2:00 PM',
        'SCHED_4PM':  'Today at 4:00 PM',
        'SCHED_6PM':  'Today at 6:00 PM',
      };
      if (raw.toUpperCase() === 'SCHED_CUSTOM') {
        // Customer wants to type a custom time — stay in DELIVERY_SLOT with awaitingSlotText
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...data, awaitingSlotText: true },
        });
        return {
          type: 'buttons',
          body: '📅 Type your preferred delivery time:\n\n_(e.g. *3pm today*, *tomorrow morning*, *Saturday 11am*)_',
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      if (SCHED_MAP[raw.toUpperCase()]) {
        const resolvedScheduled = SCHED_MAP[raw.toUpperCase()];
        const item     = data.item;
        const qty      = data.quantity || 1;
        const address  = data.deliveryAddress;
        const subtotal = item?.price ? item.price * qty : null;
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'CONFIRM',
          data: { ...data, deliverySlot: resolvedScheduled },
        });
        return {
          type: 'buttons',
          body: `🧾 *Order Summary*\n\n` +
            `🚚 *Item:* ${item?.name} × ${qty}\n` +
            `📍 *Deliver to:* ${address}\n` +
            `⏱ *When:* ${resolvedScheduled}` +
            (subtotal ? `\n💰 *Total:* ${item.currency || '$'}${subtotal.toFixed(2)}` : '') +
            `\n\nReady to confirm?`,
          buttons: [
            { id: 'CONFIRM', title: '✅ Confirm Order' },
            { id: 'CANCEL',  title: '❌ Cancel'         },
          ],
        };
      }

      const slot = SLOT_MAP[raw.toUpperCase()] || raw;

      if (!slot || slot.length < 2) {
        return {
          type: 'buttons',
          body: '⏱ When do you need the delivery?',
          buttons: [
            { id: 'SLOT_ASAP', title: '🔥 ASAP'       },
            { id: 'SLOT_1HR',  title: '⏳ In ~1 hour' },
            { id: 'CANCEL',    title: '❌ Cancel'      },
          ],
        };
      }

      // [FIX-TIME-3] When the customer types a scheduled delivery time (free-text),
      // check it isn't in the past. Only applies to typed slots — ASAP/30min/1hr are
      // always future by definition.
      if (data.awaitingSlotText && SLOT_MAP[raw.toUpperCase()] === undefined) {
        const { tryParseDate } = await import('../../../core/conversations/bookingFlow.js');
        // [FIX-TZ-DELIVERY] business?.timezone was reading a non-existent top-level field.
        // timezone lives at business.hours.timezone (BusinessConfig schema).
        const tz = business?.hours?.timezone || 'UTC';
        // Try to extract a date component — if none found, treat as today
        const lowerSlot = raw.toLowerCase();
        const datePart = lowerSlot.includes('tomorrow') ? 'tomorrow' : 'today';
        const parsedSlotDate = tryParseDate(datePart, tz);

        // Extract a time component with a simple regex
        const timeMatch = raw.match(/(\d{1,2})(:\d{2})?\s*(am|pm)/i) ||
                          raw.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
        if (timeMatch && parsedSlotDate) {
          const { validateTime: _vt } = await import('../../../core/conversations/bookingFlow.js').catch(() => ({ validateTime: null }));
          // validateTime is not exported — inline a lightweight check
          const safeZone = (() => { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; } catch { return 'UTC'; } })();
          const parts = new Intl.DateTimeFormat('en-CA', { timeZone: safeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
          const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
          const nowMins = get('hour') * 60 + get('minute');
          const todayUTC = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
          const isToday = parsedSlotDate.getTime() === todayUTC.getTime();
          if (isToday) {
            // Parse the time from the match
            const rawTime = timeMatch[0];
            const hmm = rawTime.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
            if (hmm) {
              let h = parseInt(hmm[1], 10);
              const m = parseInt(hmm[2] || '0', 10);
              const mer = (hmm[3] || '').toLowerCase();
              if (mer === 'pm' && h < 12) h += 12;
              if (mer === 'am' && h === 12) h = 0;
              const slotMins = h * 60 + m;
              if (slotMins < nowMins - 5) {
                return {
                  type: 'buttons',
                  body: `⚠️ That time has already passed today.\n\nPlease enter an *upcoming* delivery time, or pick a slot below.`,
                  buttons: [
                    { id: 'SLOT_ASAP', title: '🔥 ASAP'    },
                    { id: 'SLOT_1HR',  title: '⏳ 1 hour'   },
                    { id: 'CANCEL',    title: '❌ Cancel'    },
                  ],
                };
              }
            }
          }
        }
      }

      const item      = data.item;
      const qty       = data.quantity || 1;
      const address   = data.deliveryAddress;
      const subtotal  = item?.price ? item.price * qty : null;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM',
        data: { ...data, deliverySlot: slot },
      });

      return {
        type: 'buttons',
        body: `🧾 *Order Summary*\n\n` +
          `🚚 *Item:* ${item?.name} × ${qty}\n` +
          `📍 *Deliver to:* ${address}\n` +
          `⏱ *When:* ${slot}` +
          (subtotal ? `\n💰 *Total:* ${item.currency || '$'}${subtotal.toFixed(2)}` : '') +
          `\n\nReady to confirm?`,
        buttons: [
          { id: 'CONFIRM', title: '✅ Confirm Order' },
          { id: 'CANCEL',  title: '❌ Cancel'         },
        ],
      };
    }

    // ── CONFIRM ───────────────────────────────────────────────────────────────
    case 'CONFIRM': {
      if (!['CONFIRM', 'YES'].includes(raw.toUpperCase())) {
        return {
          type: 'buttons',
          body: 'Shall we confirm your delivery order?',
          buttons: [
            { id: 'CONFIRM', title: '✅ Confirm' },
            { id: 'CANCEL',  title: '❌ Cancel'  },
          ],
        };
      }

      const item       = data.item;
      const qty        = data.quantity || 1;
      const address    = data.deliveryAddress;
      const slot       = data.deliverySlot || 'ASAP';
      const totalPrice = item?.price ? item.price * qty : null;

      // [FIX-BUG4-DELIVERY] saveOrder previously hardcoded status:'confirmed', bypassing
      // admin review. Now saved as 'pending' so APPROVE_/REJECT_ flow works correctly.
      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          item:          item?.name,
          quantity:      qty,
          notes:         `Delivery to: ${address} | Slot: ${slot}`,
          status:        'pending',
          // [FIX-DELIVERY-1] totalAmount → totalPrice (same bug as retail — see retail fix)
          totalPrice:    totalPrice || undefined,
        });

        if (totalPrice) {
          // [FIX-DELIVERY-2] recordRevenue wrong positional call — same bug as retail
          recordRevenue({
            item:          item?.name,
            quantity:      qty,
            revenue:       totalPrice,
            tenantId:      session.tenantId,
            customerPhone: session.customerPhone,
          }).catch(() => {});
        }
        // [FIX-DELIVERY-3] trackOrderAnalytics wrong positional call — same bug as retail
        trackOrderAnalytics(item?.name, null, qty, totalPrice || 0, session.tenantId).catch(() => {});
      } catch (err) {
        logger.error('[Delivery] saveOrder error:', err.message);
      }

      // [FIX-BUG4-DELIVERY] Payment flow — was completely absent. If tenant has
      // payment enabled and item has a price, show payment instructions.
      const payment = business?.payment;
      if (payment?.enabled && totalPrice) {
        const shortId = savedOrder?.shortId || '';
        const now  = new Date();
        const mm   = String(now.getMonth() + 1).padStart(2, '0');
        const dd   = String(now.getDate()).padStart(2, '0');
        const ref  = `DLV-${mm}${dd}-${shortId}`;

        if (savedOrder?._id) {
          const { default: Order } = await import('../../../models/Order.js');
          Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
        }

        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });

        try {
          const adminPhone = business?.adminPhone;
          if (adminPhone && tenant && savedOrder) {
            const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
            const currency = payment.currency || 'D';
            await dispatchMessage(adminPhone, {
              type: 'text',
              body:
                `🔔 *New Delivery Order — ${business?.name || 'Delivery'}*\n\n` +
                `📞 Customer: *${session.customerPhone}*\n` +
                `📦 *${qty}× ${item?.name}*\n` +
                `📍 Address: *${address}*\n` +
                `⏱ Slot: *${slot}*\n` +
                `💰 Total: *${currency}${totalPrice}*\n` +
                `📝 Ref: *${ref}*\n\n` +
                `⏳ Status: *Pending* — awaiting payment screenshot.`,
            }, tenant).catch(() => {});
          }
        } catch { /* non-fatal */ }

        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
        return buildPaymentInstructionsUI(business, totalPrice, shortId, ref);
      }

      // [FIX-BUG3-DELIVERY] Admin alert: upgraded from dispatchText (no buttons) to
      // dispatchMessage with APPROVE_/REJECT_ buttons. Session parked at AWAIT_ADMIN_CONFIRM.
      try {
        const adminPhone = business?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const currency = payment?.currency || 'D';
          await dispatchMessage(adminPhone, {
            type: 'buttons',
            body:
              `🔔 *New Delivery Order — ${business?.name || 'Delivery'}*\n\n` +
              `📞 Customer: *${session.customerPhone}*\n` +
              `📦 *${qty}× ${item?.name}*\n` +
              `📍 Address: *${address}*\n` +
              `⏱ Slot: *${slot}*\n` +
              (totalPrice ? `💰 Total: *${currency}${totalPrice}*\n` : '') +
              `🔖 Ref: \`${savedOrder?.shortId || 'N/A'}\``,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
            ],
          }, tenant);
        }
      } catch (err) {
        logger.warn('[Delivery] admin notify failed:', err.message);
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data, totalPrice },
      });

      return {
        type: 'text',
        body:
          `✅ *Order Received!* 🚚\n\n` +
          `*${item?.name}* × ${qty}\n` +
          `📍 Delivering to: *${address}*\n` +
          `⏱ Requested slot: *${slot}*\n\n` +
          `⏳ Our team will confirm your order and assign a rider shortly. Please wait for confirmation before placing a new one. 🙏`,
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'SELECT_ITEM',
        data: {},
        menuViewed: false,
      });
      return handleDeliveryOrder({ session: { ...session, step: 'SELECT_ITEM', data: {} }, message: null, business, tenant, isInteractive });
  }
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function _buildMenuUI(menu, business) {
  if (!menu.length) {
    return {
      type: 'buttons',
      body: `🚚 *${business?.name || 'Delivery'}*\n\nWhat would you like to order today?\n\n_Type what you'd like and we'll check if we can deliver it._`,
      buttons: [
        { id: 'QUESTION', title: '❓ Ask a Question' },
        { id: 'CANCEL',   title: '❌ Cancel'          },
      ],
    };
  }

  const lines = menu.slice(0, 20).map((item, idx) => {
    const price = item.price ? ` — ${item.currency || '$'}${item.price}` : '';
    const desc  = item.description ? `\n   _${item.description.slice(0, 60)}_` : '';
    return `${idx + 1}. *${item.name}*${price}${desc}`;
  });

  return {
    type: 'buttons',
    body: `🚚 *${business?.name || 'Delivery Menu'}*\n\n${lines.join('\n\n')}\n\n_Type a number or name to order_`,
    buttons: [
      { id: 'TRACK_ORDER', title: '📍 Track Order'    },
      { id: 'QUESTION',    title: '❓ Ask a Question'  },
    ],
  };
}
