/**
 * modules/bakery/flows/orderFlow.js
 *
 * BAKERY ORDER FLOW — dedicated, not a restaurant proxy.
 *
 * Bakery-specific logic:
 *   • Collection vs delivery (not dine-in/table)
 *   • Pickup time slot selection (morning / afternoon batches)
 *   • Custom message notes (e.g. "wedding cake, write Happy Anniversary")
 *   • Payment via Wave/cash — same payment service as restaurant
 *
 * Steps: SELECT_ITEM → QUANTITY → NOTES → FULFILMENT → PICKUP_TIME → CONFIRM → [PAYMENT?]
 */

import { updateSession }  from '../../../core/sessions/sessionService.js';
import { completeFlow }   from '../../../core/conversations/flowEngine.js';
import { findBestMatch }  from '../../../utils/matchEngine.js';
import { parseQuantity }  from '../../../utils/parseQuantity.js';
import { saveOrder }      from '../../../services/orderService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import logger             from '../../../config/logger.js';

const norm = (s = '') => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

export async function handleBakeryOrderFlow({ session, message, business, tenant, isInteractive = false }) {
  const raw   = String(message || '').trim();
  const clean = norm(raw);
  const step  = session.step || 'SELECT_ITEM';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);

  // ── No menu ───────────────────────────────────────────────────────────────
  if (!menu.length) {
    await updateSession(session.customerPhone, session.tenantId, { currentFlow: null, step: null, data: {} });
    return {
      type:    'buttons',
      body:    '🥐 Our menu is being updated — please check back soon or contact us directly.',
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }, { id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM', data: {}, menuViewed: false, upsellSent: false,
    });
    return _buildBakeryMenu(menu, business);
  }

  switch (step) {

    // ── SELECT_ITEM ──────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return _buildBakeryMenu(menu, business);
      }
      if (clean.length < 2) return _buildBakeryMenu(menu, business);

      // [AUDIT-FIX-PARSEINT] parseInt("2 red shirts") === 2, not NaN — only trust
      // the parsed index for a bare number or an interactive tap; mixed
      // alphanumeric input must fall through to fuzzy name matching below.
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const numIdx = parseInt(raw, 10) - 1;
      let item = ((isInteractive || isPureNumeric) && !isNaN(numIdx) && numIdx >= 0 && menu[numIdx]) ? menu[numIdx] : null;

      if (!item) {
        const { item: matched, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH') {
          item = matched;
        } else if (confidenceLevel === 'LOW' && matched) {
          return {
            type: 'buttons',
            body: `Did you mean *${matched.name}*? 🥐`,
            buttons: [
              { id: 'CONFIRM',   title: `✅ Yes, ${matched.name.slice(0, 15)}` },
              { id: 'SHOW_MENU', title: '🔄 Browse All'                         },
            ],
          };
        }
      }

      if (!item) return _buildBakeryMenu(menu, business);

      const price = item.price ? ` — ${item.currency || 'D'}${item.price}` : '';
      const desc  = item.description ? `\n_${item.description}_` : '';
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'QUANTITY', data: { item }, menuViewed: true,
      });

      return {
        type: 'buttons',
        body: `🧁 *${item.name}*${price}${desc}\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1️⃣  1' },
          { id: 'QTY_2', title: '2️⃣  2' },
          { id: 'QTY_3', title: '3️⃣  3' },
        ],
        footer: 'Or type any number e.g. 6, 12, 24',
      };
    }

    // ── QUANTITY ──────────────────────────────────────────────────────────────
    case 'QUANTITY': {
      const QTY = { 'QTY_1': 1, 'QTY_2': 2, 'QTY_3': 3 };
      const qty = QTY[raw.toUpperCase()] ?? parseQuantity(raw);
      const MAX = business?.settings?.maxOrderQuantity || 100;

      if (!qty || qty < 1) {
        return {
          type:    'buttons',
          body:    `🧁 How many *${data.item?.name}* would you like?\n_(Enter a number, e.g. 1, 6, 12)_`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1'  },
            { id: 'QTY_2', title: '2️⃣  2'  },
            { id: 'QTY_3', title: '3️⃣  3'  },
          ],
          footer: `Maximum: ${MAX}`,
        };
      }
      if (qty > MAX) {
        return {
          type:    'buttons',
          body:    `⚠️ Maximum order is *${MAX}* per order. For bulk/wholesale orders please contact us directly.`,
          buttons: [{ id: 'SUPPORT', title: '📞 Contact Us' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'NOTES', data: { ...data, quantity: qty, totalPrice: (data.item?.price || 0) * qty },
      });

      return {
        type: 'buttons',
        body: `🎂 *${qty}× ${data.item?.name}*\n\nAny special message or notes?\n_(e.g. "Write Happy Birthday Sara", "No nuts", "Extra icing")_`,
        buttons: [
          { id: 'NOTES_NONE', title: '✅ No special notes' },
          { id: 'CANCEL',     title: '❌ Cancel'            },
        ],
        footer: 'Or type your message/notes and send',
      };
    }

    // ── NOTES ─────────────────────────────────────────────────────────────────
    case 'NOTES': {
      const notes = raw.toUpperCase() === 'NOTES_NONE' ? null : raw;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'FULFILMENT', data: { ...data, notes: notes || null },
      });

      return {
        type: 'buttons',
        body: `📦 *How would you like to receive your order?*`,
        buttons: [
          { id: 'COLLECT',  title: '🏪 Collect In-Store' },
          { id: 'DELIVERY', title: '🚚 Home Delivery'     },
        ],
      };
    }

    // ── FULFILMENT ────────────────────────────────────────────────────────────
    case 'FULFILMENT': {
      const isDelivery = raw.toUpperCase() === 'DELIVERY';
      const isCollect  = raw.toUpperCase() === 'COLLECT';

      if (!isDelivery && !isCollect) {
        return {
          type: 'buttons',
          body: '📦 Would you like to collect in-store or have it delivered?',
          buttons: [
            { id: 'COLLECT',  title: '🏪 Collect In-Store' },
            { id: 'DELIVERY', title: '🚚 Home Delivery'     },
          ],
        };
      }

      if (isDelivery) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'DELIVERY_ADDRESS', data: { ...data, fulfilment: 'Delivery' },
        });
        return {
          type:    'buttons',
          body:    `📍 *Delivery Address*\n\nPlease type your full delivery address.\n\n_Include: street, area, and a landmark._`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
          footer:  'Type address and send',
        };
      }

      // Collect — pick a time slot
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'PICKUP_TIME', data: { ...data, fulfilment: 'Collection' },
      });
      return _buildPickupTimeUI(business);
    }

    // ── DELIVERY_ADDRESS ──────────────────────────────────────────────────────
    case 'DELIVERY_ADDRESS': {
      if (!raw || raw.length < 5) {
        return {
          type:    'buttons',
          body:    '📍 Please provide a valid delivery address.',
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'PICKUP_TIME', data: { ...data, deliveryAddress: raw },
      });
      return _buildPickupTimeUI(business);
    }

    // ── PICKUP_TIME ───────────────────────────────────────────────────────────
    case 'PICKUP_TIME': {
      const SLOT_MAP = {
        'SLOT_MORNING':   'Morning (8am – 12pm)',
        'SLOT_AFTERNOON': 'Afternoon (12pm – 4pm)',
        'SLOT_EVENING':   'Evening (4pm – 7pm)',
        'SLOT_TOMORROW':  'Tomorrow (any time)',
      };

      let slot = SLOT_MAP[raw.toUpperCase()] || null;

      // Allow free-text time entry
      if (!slot && raw.length >= 3) {
        slot = raw;
      }

      if (!slot) {
        return _buildPickupTimeUI(business);
      }

      const item     = data.item;
      const qty      = data.quantity || 1;
      const total    = data.totalPrice;
      const notes    = data.notes;
      const method   = data.fulfilment || 'Collection';
      const address  = data.deliveryAddress || null;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, pickupTime: slot },
      });

      const notesLine   = notes   ? `\n📝 *Notes:* ${notes}` : '';
      const addressLine = address ? `\n📍 *Deliver to:* ${address}` : '';
      const totalLine   = total   ? `\n💰 *Total:* ${item.currency || 'D'}${total}` : '';

      return {
        type: 'buttons',
        body:
          `🧾 *Order Summary*\n\n` +
          `🧁 *${qty}× ${item?.name}*\n` +
          `📦 *${method}*` +
          addressLine +
          `\n⏰ *${method === 'Delivery' ? 'Delivery' : 'Collection'} Time:* ${slot}` +
          notesLine +
          totalLine +
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
          type:    'buttons',
          body:    '🧁 Ready to place your bakery order?',
          buttons: [
            { id: 'CONFIRM', title: '✅ Confirm Order' },
            { id: 'CANCEL',  title: '❌ Cancel'         },
          ],
        };
      }

      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          item:          data.item?.name,
          quantity:      data.quantity || 1,
          totalPrice:    data.totalPrice || 0,
          notes:         [
            data.notes         ? `Message: ${data.notes}`        : null,
            data.fulfilment    ? `Fulfilment: ${data.fulfilment}` : null,
            data.deliveryAddress ? `Address: ${data.deliveryAddress}` : null,
            data.pickupTime    ? `Time: ${data.pickupTime}`      : null,
          ].filter(Boolean).join(' | '),
          businessId:    business._id,
        });
      } catch (err) {
        logger.error('[BakeryOrder] saveOrder failed', { err: err.message });
        // [FIX-SAVE-ERR-BAKERY] If we couldn't persist the order, do NOT proceed to
        // payment instructions or AWAIT_ADMIN_CONFIRM — the customer would be told the
        // order was received when nothing was saved. Clear the flow and let them retry.
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {},
        });
        return {
          type:    'buttons',
          body:    `⚠️ *Something went wrong saving your order.*\n\nPlease try again — tap below to start over.`,
          buttons: [
            { id: 'ORDER',    title: '🛒 Try Again'   },
            { id: 'SUPPORT',  title: '💬 Contact Us'  },
          ],
        };
      }

      // Payment flow
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        // [FIX-PAYREF-BAKERY] Generate and persist paymentReference so the ref shown to
        // the customer never drifts between the initial instructions card and any follow-up
        // messages. Mirrors restaurant/electronics/retail/delivery pattern.
        const shortIdRef = savedOrder?.shortId || '';
        let ref = null;
        if (shortIdRef) {
          const now = new Date();
          const mm  = String(now.getMonth() + 1).padStart(2, '0');
          const dd  = String(now.getDate()).padStart(2, '0');
          ref = `DSB-${mm}${dd}-${shortIdRef}`;
          if (savedOrder?._id) {
            const { default: Order } = await import('../../../models/Order.js');
            Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
          }
        }
        return buildPaymentInstructionsUI(business, data.totalPrice, shortIdRef || null, ref);
      }

      // [FIX-BUG3-BAKERY] Upgrade admin alert from dispatchText (plain text, no buttons)
      // to dispatchMessage with APPROVE_/REJECT_ buttons so admin can confirm/cancel
      // with a single tap instead of typing commands. Also parks session at
      // AWAIT_ADMIN_CONFIRM so the customer cannot place a duplicate order before
      // the admin acts — mirrors the restaurant/electronics pattern.
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const currency    = business?.payment?.currency || 'D';
          const notesLine   = data.notes          ? `\n📝 Notes: ${data.notes}`             : '';
          const addressLine = data.deliveryAddress ? `\n📍 Address: ${data.deliveryAddress}` : '';
          const totalLine   = data.totalPrice      ? `\n💰 Total: *${currency}${data.totalPrice}*` : '';
          await dispatchMessage(adminPhone, {
            type: 'buttons',
            body:
              `🔔 *New Bakery Order — ${business?.name || 'Bakery'}*\n\n` +
              `📞 Customer: *${session.customerPhone}*\n` +
              `🧁 *${data.quantity}× ${data.item?.name}*\n` +
              `📦 Fulfilment: *${data.fulfilment || 'Collection'}*\n` +
              `⏰ Time: *${data.pickupTime || 'ASAP'}*` +
              addressLine + notesLine + totalLine +
              `\n🔖 Ref: \`${savedOrder?.shortId || 'N/A'}\``,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
            ],
          }, tenant).catch(e => logger.warn('[BakeryOrder] admin notify failed', { err: e.message }));
        }
      } catch {}

      trackOrderAnalytics(data.item?.name, null, data.quantity, data.totalPrice || 0, session.tenantId).catch(() => {});
      // [AUDIT-FIX-4] recordRevenue() moved to adminCommandService.confirmPayment() —
      // recording it here at placement time counted unconfirmed/later-rejected orders
      // as revenue. See adminCommandService.js AUDIT-FIX-4 for full rationale.

      // Park session — customer waits for admin confirmation before placing another order
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data },
      });

      return {
        type: 'text',
        body:
          `✅ *Order Received!* 🥐\n\n` +
          `🧁 *${data.quantity}× ${data.item?.name}*\n` +
          `📦 ${data.fulfilment || 'Collection'} — ${data.pickupTime || 'ASAP'}\n` +
          (data.notes ? `📝 ${data.notes}\n` : '') +
          `\n⏳ Our team will confirm your order shortly. Please wait for confirmation before placing a new one. 🙏`,
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: {} });
      return handleBakeryOrderFlow({ session: { ...session, step: 'SELECT_ITEM', data: {} }, message: null, business, tenant, isInteractive });
  }
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function _buildBakeryMenu(menu, business) {
  const name = business?.businessName || business?.name || 'Bakery';
  if (!menu.length) {
    return {
      type:    'buttons',
      body:    `🥐 *${name}*\n\nOur menu is being updated. Please check back soon!`,
      buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }],
    };
  }
  const rows = menu.slice(0, 10).map((item, i) => ({
    id:          String(i + 1),
    title:       item.name.slice(0, 24),
    description: [
      item.description?.slice(0, 40),
      item.price ? `${item.currency || 'D'}${item.price}` : null,
    ].filter(Boolean).join(' — ').slice(0, 72) || undefined,
  }));
  return {
    type:   'list',
    header: `🥐 ${name}`,
    body:   'Fresh baked daily — what would you like?',
    button: 'View Menu',
    rows,
    footer: menu.length > 10 ? `Showing ${rows.length} of ${menu.length} items` : undefined,
  };
}

function _buildPickupTimeUI(business) {
  return {
    type:   'list',
    body:   `⏰ *When would you like it?*`,
    button: 'Choose time',
    sections: [{
      title: 'Collection / Delivery Window',
      rows: [
        { id: 'SLOT_MORNING',   title: '🌅 Morning',    description: '8:00 AM – 12:00 PM'  },
        { id: 'SLOT_AFTERNOON', title: '☀️ Afternoon',  description: '12:00 PM – 4:00 PM'  },
        { id: 'SLOT_EVENING',   title: '🌆 Evening',    description: '4:00 PM – 7:00 PM'   },
        { id: 'SLOT_TOMORROW',  title: '📅 Tomorrow',   description: 'Any time tomorrow'    },
      ],
    }],
    footer: 'Or type a specific time e.g. "10am today"',
  };
}
