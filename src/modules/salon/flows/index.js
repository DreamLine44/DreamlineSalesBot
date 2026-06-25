/**
 * modules/salon/flows/index.js
 *
 * SALON & BARBERSHOP module — appointment booking, walk-in queue,
 * product sales, and stylist/barber selection.
 *
 * These are NOT generic booking wrappers. Salon-specific logic:
 *   - Walk-in queue management (adds customer to queue instead of date/time)
 *   - Stylist / barber selection (if business has staff defined)
 *   - Service upsells (e.g. deep conditioning after haircut)
 *   - Product retail sales (shampoo, conditioner, wax etc. from menu)
 *   - Loyalty-aware messaging (X visits = free treatment reminder)
 *
 * Flows:
 *   BOOKING   — proper appointment (date + time + stylist + service)
 *   WALKIN    — walk-in queue entry (service + stylist only, no date)
 *   ORDER     — retail product sales (salon/barbershop often sell products)
 *   QUESTION  — AI-powered FAQ (opening hours, prices, aftercare advice)
 */

import { updateSession }     from '../../../core/sessions/sessionService.js';
import { completeFlow }      from '../../../core/conversations/flowEngine.js';
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { getAIReply }        from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }     from '../../../utils/matchEngine.js';
import { parseQuantity }     from '../../../utils/parseQuantity.js';
import { saveOrder }         from '../../../services/orderService.js';
import { saveBooking }       from '../../../services/bookingService.js';
import { trackOrderAnalytics, recordRevenue } from '../../../core/analytics/analyticsService.js';
import logger                from '../../../config/logger.js';

// ── Salon Config ──────────────────────────────────────────────────────────────

export const SALON_CONFIG = {
  businessMode: 'SALON',
  flows: ['BOOKING', 'WALKIN', 'ORDER', 'QUESTION'],
  persona: 'professional, welcoming salon receptionist who helps clients book appointments, join the walk-in queue, and find the right hair and beauty products',
  steps: {
    BOOKING: ['SELECT_SERVICE', 'SELECT_STYLIST', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
    WALKIN:  ['SELECT_SERVICE', 'SELECT_STYLIST', 'CONFIRM'],
    ORDER:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
  },
  ui: {
    // [FIX-4BTN-SALON] Meta caps button messages at 3 buttons; the dispatcher's
    // .slice(0,3) silently drops any 4th button. The previous 4-button array meant
    // 'QUESTION' was never rendered and customers had no way to tap it.
    // Fix: keep the 3 highest-priority actions. ORDER (shop products) is accessible
    // via the QUESTION flow or by typing — it's the least-used primary CTA for salons.
    welcomeButtons: [
      { id: 'BOOK',     title: '📅 Book Appointment'   },
      { id: 'WALKIN',   title: '🚶 Join Walk-In Queue'  },
      { id: 'QUESTION', title: '❓ Ask a Question'      },
    ],
    fallbackButtons: [
      { id: 'BOOK',     title: '📅 Book'      },
      { id: 'WALKIN',   title: '🚶 Walk-In'   },
      { id: 'QUESTION', title: '❓ Question'  },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'CANCEL', title: '❌ Cancel' }],
  },
  messages: {
    welcome:      '💇 Welcome! How can we help you today?\n\nBook an appointment, join our walk-in queue, or shop our products.',
    cancelMsg:    '✅ No problem! Tap below whenever you\'re ready. 💇',
    fallback:     'Would you like to *book an appointment*, join the *walk-in queue*, or ask a *question*?',
    orderPrompt:  '🛍 Our hair & beauty products — tap to select:',
    bookPrompt:   '📅 What service would you like to book?',
  },
};

// ── Barbershop Config ─────────────────────────────────────────────────────────

export const BARBERSHOP_CONFIG = {
  businessMode: 'BARBERSHOP',
  flows: ['BOOKING', 'WALKIN', 'ORDER', 'QUESTION'],
  persona: 'friendly, confident barber who helps clients book cuts, join the queue, and answers style and grooming questions',
  steps: {
    BOOKING: ['SELECT_SERVICE', 'SELECT_STYLIST', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
    WALKIN:  ['SELECT_SERVICE', 'SELECT_STYLIST', 'CONFIRM'],
    ORDER:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
  },
  ui: {
    // [FIX-4BTN-BARBER] Same 4→3 button cap fix as SALON above.
    // ORDER (grooming products) dropped from welcome screen — accessible via
    // QUESTION flow or by typing. Book, Walk-In, and Ask are the primary CTAs.
    welcomeButtons: [
      { id: 'BOOK',     title: '💈 Book Appointment'   },
      { id: 'WALKIN',   title: '🚶 Join Walk-In Queue'  },
      { id: 'QUESTION', title: '❓ Ask a Question'      },
    ],
    fallbackButtons: [
      { id: 'BOOK',     title: '💈 Book'     },
      { id: 'WALKIN',   title: '🚶 Walk-In'  },
      { id: 'QUESTION', title: '❓ Question' },
    ],
    confirmButtons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'CANCEL', title: '❌ Cancel' }],
  },
  messages: {
    welcome:      '✂️ Welcome! Ready for a fresh cut?\n\nBook an appointment, join our walk-in queue, or browse our grooming products.',
    cancelMsg:    '✅ No problem! Come back whenever you\'re ready. ✂️',
    fallback:     'Would you like to *book an appointment*, join the *walk-in queue*, or ask a *question*?',
    orderPrompt:  '🛍 Our grooming products — tap to select:',
    bookPrompt:   '✂️ What cut or treatment would you like to book?',
  },
};

// ── Walk-In Queue Flow ────────────────────────────────────────────────────────
// Salon-specific: customer joins a live queue without booking a date/time.
// Steps: SELECT_SERVICE → SELECT_STYLIST → CONFIRM

export async function handleSalonWalkIn({ session, message, business, tenant, isInteractive }) {
  const raw  = String(message || '').trim();
  const step = session.step || 'SELECT_SERVICE';
  const data = session.data || {};
  const isBarbershop = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
  const emoji = isBarbershop ? '✂️' : '💇';

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_SERVICE', data: {},
    });
    return _buildServiceMenu(business, 'walkin');
  }

  switch (step) {

    // ── SELECT_SERVICE ────────────────────────────────────────────────────────
    case 'SELECT_SERVICE': {
      const services = _getServices(business);
      const SVC_MAP  = _buildServiceIdMap(services);
      const matched  = SVC_MAP[raw.toUpperCase()] || services.find(s =>
        s.toLowerCase() === raw.toLowerCase()
      ) || (raw.length >= 3 ? raw : null);

      if (!matched) return _buildServiceMenu(business, 'walkin');

      const staff = _getStaff(business);

      await updateSession(session.customerPhone, session.tenantId, {
        step: staff.length > 0 ? 'SELECT_STYLIST' : 'CONFIRM',
        data: { ...data, service: matched },
      });

      if (staff.length === 0) {
        // No staff defined — skip stylist step, go straight to confirm
        return {
          type: 'buttons',
          body:
            `${emoji} *Walk-In Queue*\n\n` +
            `✂️ *Service:* ${matched}\n\n` +
            `You'll be added to the queue when you arrive. Shall we confirm?`,
          buttons: [
            { id: 'CONFIRM', title: '✅ Join Queue' },
            { id: 'CANCEL',  title: '❌ Cancel'      },
          ],
        };
      }

      return _buildStylistMenu(staff, business, isBarbershop);
    }

    // ── SELECT_STYLIST ────────────────────────────────────────────────────────
    case 'SELECT_STYLIST': {
      const staff     = _getStaff(business);
      const STAFF_MAP = _buildStaffIdMap(staff);
      const isBarbershop = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';

      let stylist =
        STAFF_MAP[raw.toUpperCase()] ||
        staff.find(s => s.toLowerCase() === raw.toLowerCase()) ||
        (raw.toUpperCase() === 'STYLIST_ANY' ? 'Any available' : null) ||
        (raw.length >= 2 && !['CANCEL', 'CONFIRM'].includes(raw.toUpperCase()) ? raw : null);

      if (!stylist) return _buildStylistMenu(staff, business, isBarbershop);

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM',
        data: { ...data, stylist },
      });

      const stylistLine = stylist === 'Any available'
        ? '\n👤 *Stylist:* Any available'
        : `\n👤 *${isBarbershop ? 'Barber' : 'Stylist'}:* ${stylist}`;

      return {
        type: 'buttons',
        body:
          `${emoji} *Walk-In Summary*\n\n` +
          `✂️ *Service:* ${data.service}` +
          stylistLine +
          `\n\nYou'll be added to the walk-in queue when you arrive. Confirm?`,
        buttons: [
          { id: 'CONFIRM', title: '✅ Join Queue' },
          { id: 'CANCEL',  title: '❌ Cancel'      },
        ],
      };
    }

    // ── CONFIRM ───────────────────────────────────────────────────────────────
    case 'CONFIRM': {
      if (!['CONFIRM', 'YES'].includes(raw.toUpperCase())) {
        return {
          type: 'buttons',
          body: `${emoji} Ready to join the walk-in queue?`,
          buttons: [
            { id: 'CONFIRM', title: '✅ Yes, join queue' },
            { id: 'CANCEL',  title: '❌ Cancel'           },
          ],
        };
      }

      // Save as booking record with type 'walkin'
      let savedBooking = null;
      try {
        savedBooking = await saveBooking({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          service:       data.service,
          staff:         data.stylist || null,
          date:          new Date().toISOString().split('T')[0], // today
          time:          'Walk-In',
          notes:         `Walk-in queue entry${data.stylist ? ` — requesting ${data.stylist}` : ''}`,
          status:        'pending',
          businessId:    business._id,
        });
      } catch (err) {
        logger.error('[SalonWalkIn] saveBooking failed', { err: err.message });
      }

      // Notify admin
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant) {
          const { dispatchText } = await import('../../../core/whatsapp/dispatcher.js');
          await dispatchText(
            adminPhone,
            `🚶 *Walk-In Queue — ${business?.name || 'Salon'}*\n\n` +
            `📞 Customer: ${session.customerPhone}${session.customerName ? ` (${session.customerName})` : ''}\n` +
            `✂️ Service: ${data.service}\n` +
            (data.stylist ? `👤 Requesting: ${data.stylist}\n` : '') +
            `⏰ Joined: ${new Date().toLocaleTimeString()}`,
            tenant,
          ).catch(e => logger.warn('[SalonWalkIn] admin notify failed', { err: e.message }));
        }
      } catch {}

      const lc = await completeFlow(session, 'WALKIN', business, tenant);
      if (lc) return lc;

      const isBarbershopConfirm = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
      return {
        type: 'buttons',
        body:
          `✅ *You're in the queue!* ${isBarbershopConfirm ? '✂️' : '💇'}\n\n` +
          `*Service:* ${data.service}\n` +
          (data.stylist && data.stylist !== 'Any available'
            ? `*${isBarbershopConfirm ? 'Barber' : 'Stylist'}:* ${data.stylist}\n`
            : '') +
          `\nPlease head to the salon and let the team know you're here. See you soon! 🙏`,
        buttons: [
          { id: 'BOOK',     title: '📅 Book Next Time' },
          { id: 'QUESTION', title: '❓ Ask a Question'  },
          { id: 'SHOW_MENU', title: '🔄 Start Over'     },
        ],
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_SERVICE', data: {} });
      return handleSalonWalkIn({ session: { ...session, step: 'SELECT_SERVICE', data: {} }, message: null, business, tenant });
  }
}

// ── Appointment Booking Flow ──────────────────────────────────────────────────
// Wraps the shared bookingFlow but adds stylist selection BEFORE date/time.

export async function handleSalonBooking({ session, message, business, tenant, isInteractive }) {
  const raw  = String(message || '').trim();
  const step = session.step || 'SELECT_SERVICE';
  const data = session.data || {};
  const isBarbershop = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';

  // If we're past the salon-specific steps, hand off to shared bookingFlow
  const BOOKING_SHARED_STEPS = new Set([
    'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM',
  ]);
  if (BOOKING_SHARED_STEPS.has(step)) {
    return handleBookingFlow({ session, message, business, tenant, isInteractive });
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_SERVICE', data: {},
    });
    return _buildServiceMenu(business, 'booking');
  }

  switch (step) {

    // ── SELECT_SERVICE ────────────────────────────────────────────────────────
    case 'SELECT_SERVICE': {
      const services = _getServices(business);
      const SVC_MAP  = _buildServiceIdMap(services);
      const matched  =
        SVC_MAP[raw.toUpperCase()] ||
        services.find(s => s.toLowerCase() === raw.toLowerCase()) ||
        (raw.length >= 3 ? raw : null);

      if (!matched) return _buildServiceMenu(business, 'booking');

      const staff = _getStaff(business);

      await updateSession(session.customerPhone, session.tenantId, {
        // Inject service into session.data.selectedService so bookingFlow can pick it up
        step: staff.length > 0 ? 'SELECT_STYLIST' : 'DATE',
        data: { ...data, service: matched, selectedService: matched },
      });

      if (staff.length === 0) {
        // Hand off to shared booking flow — it will handle DATE onwards
        return handleBookingFlow({
          session: { ...session, step: 'DATE', data: { ...data, service: matched, selectedService: matched } },
          message: null,
          business,
          tenant,
          isInteractive,
        });
      }

      return _buildStylistMenu(staff, business, isBarbershop);
    }

    // ── SELECT_STYLIST ────────────────────────────────────────────────────────
    case 'SELECT_STYLIST': {
      const staff     = _getStaff(business);
      const STAFF_MAP = _buildStaffIdMap(staff);

      const stylist =
        STAFF_MAP[raw.toUpperCase()] ||
        staff.find(s => s.toLowerCase() === raw.toLowerCase()) ||
        (raw.toUpperCase() === 'STYLIST_ANY' ? 'Any available' : null) ||
        (raw.length >= 2 && !['CANCEL', 'CONFIRM'].includes(raw.toUpperCase()) ? raw : null);

      if (!stylist) return _buildStylistMenu(staff, business, isBarbershop);

      const updatedData = { ...data, stylist, selectedService: data.service };
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DATE',
        data: updatedData,
      });

      // Hand off to shared booking flow for date/time selection
      return handleBookingFlow({
        session: { ...session, step: 'DATE', data: updatedData },
        message: null,
        business,
        tenant,
        isInteractive,
      });
    }

    default:
      // Anything else — fall through to shared bookingFlow
      return handleBookingFlow({ session, message, business, tenant, isInteractive });
  }
}

// ── Product Order Flow ────────────────────────────────────────────────────────
// Salon/barbershop retail — shampoo, conditioner, pomade, wax, etc.
// Steps: SELECT_ITEM → QUANTITY → CONFIRM

export async function handleSalonProductOrder({ session, message, business, tenant, isInteractive = false }) {
  const raw   = String(message || '').trim();
  const clean = raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const step  = session.step || 'SELECT_ITEM';
  const data  = session.data || {};
  const menu  = (business?.menuItems || []).filter(i => i.available !== false);
  const isBarbershop = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
  const emoji = isBarbershop ? '✂️' : '💇';

  // ── No products ───────────────────────────────────────────────────────────
  if (!menu.length) {
    await updateSession(session.customerPhone, session.tenantId, { currentFlow: null, step: null, data: {} });
    return {
      type:    'buttons',
      body:    `${emoji} Our product range is currently being updated. Please check back soon or ask us directly!`,
      buttons: [
        { id: 'BOOK',     title: '📅 Book Appointment' },
        { id: 'QUESTION', title: '❓ Ask a Question'   },
      ],
    };
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_ITEM', data: {}, menuViewed: false,
    });
    return _buildProductMenu(menu, business, isBarbershop);
  }

  switch (step) {

    // ── SELECT_ITEM ───────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      if (!isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return _buildProductMenu(menu, business, isBarbershop);
      }
      if (clean.length < 2) return _buildProductMenu(menu, business, isBarbershop);

      const numIdx = parseInt(raw, 10) - 1;
      let item = (!isNaN(numIdx) && numIdx >= 0 && menu[numIdx]) ? menu[numIdx] : null;

      if (!item) {
        const { item: matched, confidenceLevel } = findBestMatch(menu, clean);
        if (confidenceLevel === 'HIGH') {
          item = matched;
        } else if (confidenceLevel === 'LOW' && matched) {
          return {
            type: 'buttons',
            body: `Did you mean *${matched.name}*?`,
            buttons: [
              { id: 'CONFIRM',   title: `✅ Yes, ${matched.name.slice(0, 15)}` },
              { id: 'SHOW_MENU', title: '🔄 Browse All'                         },
            ],
          };
        }
      }

      if (!item) return _buildProductMenu(menu, business, isBarbershop);

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'QUANTITY', data: { ...data, item }, menuViewed: true,
      });

      const price = item.price ? ` — ${item.currency || 'D'}${item.price}` : '';
      const desc  = item.description ? `\n_${item.description}_` : '';
      return {
        type: 'buttons',
        body: `🛍 *${item.name}*${price}${desc}\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1️⃣  1' },
          { id: 'QTY_2', title: '2️⃣  2' },
          { id: 'QTY_3', title: '3️⃣  3' },
        ],
        footer: 'Or type any number',
      };
    }

    // ── QUANTITY ──────────────────────────────────────────────────────────────
    case 'QUANTITY': {
      const QTY = { 'QTY_1': 1, 'QTY_2': 2, 'QTY_3': 3 };
      const qty = QTY[raw.toUpperCase()] ?? parseQuantity(raw);
      const MAX = business?.settings?.maxOrderQuantity || 20;

      if (!qty || qty < 1) {
        return {
          type: 'buttons',
          body: `🛍 How many *${data.item?.name}* would you like?`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
          footer: `Max: ${MAX} per order`,
        };
      }
      if (qty > MAX) {
        return {
          type: 'buttons',
          body: `⚠️ Maximum is *${MAX}* per order. For bulk orders please contact us.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      const total = (data.item?.price || 0) * qty;
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM', data: { ...data, quantity: qty, totalPrice: total },
      });

      return {
        type: 'buttons',
        body:
          `🧾 *Order Summary*\n\n` +
          `🛍 *${qty}× ${data.item?.name}*\n` +
          (total ? `💰 *Total:* ${data.item?.currency || 'D'}${total}\n` : '') +
          `\nReady to confirm?`,
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
          body: `${emoji} Ready to place your order?`,
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
          businessId:    business._id,
        });
      } catch (err) {
        logger.error('[SalonProduct] saveOrder failed', { err: err.message });
      }

      // Payment flow
      const payment = business?.payment;
      if (payment?.enabled && data.totalPrice) {
        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        // [FIX-PAYREF-SALON] Generate and persist paymentReference — mirrors restaurant/bakery pattern.
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

      // Admin notify with APPROVE_/REJECT_ buttons — mirrors restaurant/bakery/fashion pattern
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedOrder) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const currency = business?.payment?.currency || 'D';
          await dispatchMessage(
            adminPhone,
            {
              type: 'buttons',
              body:
                `🔔 *New Product Order — ${business?.name || (isBarbershop ? 'Barbershop' : 'Salon')}*\n\n` +
                `📞 Customer: ${session.customerPhone}\n` +
                `🛍 *${data.quantity}× ${data.item?.name}*\n` +
                (data.totalPrice ? `💰 Total: ${currency}${data.totalPrice}\n` : '') +
                `🔖 Ref: \`${savedOrder?.shortId || 'N/A'}\``,
              buttons: [
                { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
                { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
              ],
            },
            tenant,
          ).catch(e => logger.warn('[SalonProduct] admin notify failed', { err: e.message }));
        }
      } catch {}

      trackOrderAnalytics(data.item?.name, null, data.quantity, data.totalPrice || 0, session.tenantId).catch(() => {});
      if (data.totalPrice) {
        recordRevenue({
          item: data.item?.name, quantity: data.quantity,
          revenue: data.totalPrice, tenantId: session.tenantId,
          customerPhone: session.customerPhone,
        }).catch(() => {});
      }

      // Park session at AWAIT_ADMIN_CONFIRM — mirrors restaurant/bakery/fashion/retail pattern
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data },
      });

      return {
        type: 'text',
        body:
          `✅ *Order received!* ${emoji}\n\n` +
          `🛍 *${data.quantity}× ${data.item?.name}*\n` +
          `\n⏳ Our team will confirm your order shortly. We'll send you a message when it's ready! 🙏`,
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: {} });
      return handleSalonProductOrder({
        session: { ...session, step: 'SELECT_ITEM', data: {} },
        message: null, business, tenant, isInteractive,
      });
  }
}

// ── AI Question Handler ───────────────────────────────────────────────────────
// Salon-specific: handles aftercare advice, product recommendations, pricing FAQs

export async function handleSalonQuestion({ session, message, business, tenant }) {
  const raw = String(message || '').trim();
  const isBarbershop = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';

  if (!raw || raw.length < 2) {
    return {
      type: 'buttons',
      body: `${isBarbershop ? '✂️' : '💇'} What would you like to know? Feel free to type your question.\n\n_(e.g. pricing, opening hours, aftercare tips, product recommendations)_`,
      buttons: [
        { id: 'BOOK',      title: isBarbershop ? '💈 Book Cut' : '📅 Book Appointment' },
        { id: 'SHOW_MENU', title: '🔄 Start Over' },
      ],
    };
  }

  const aiReply = await getAIReply({
    customerMessage: raw,
    business,
    session,
    intent: 'SALON_QUESTION',
  });

  const lc = await completeFlow(session, 'QUESTION', business, tenant);
  if (lc) return lc;

  return {
    type: 'buttons',
    body: aiReply || `Great question! For detailed information please contact us directly.`,
    buttons: [
      { id: 'BOOK',     title: isBarbershop ? '💈 Book Now' : '📅 Book Now'    },
      { id: 'WALKIN',   title: '🚶 Walk-In Queue'                               },
      { id: 'QUESTION', title: '❓ Another Question'                            },
    ],
  };
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

/** Returns service list — from menuItems (category = 'services') or fallback defaults */
function _getServices(business) {
  const items = (business?.menuItems || []).filter(i => i.available !== false);
  const isBarbershop = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';

  if (items.length > 0) return items.map(i => i.name);

  // Fallback defaults differ by mode
  return isBarbershop
    ? ['Haircut', 'Beard Trim', 'Shape-Up / Edge', 'Full Service (Cut + Beard)', 'Kids Cut']
    : ['Haircut & Style', 'Blow Dry', 'Hair Colour', 'Highlights', 'Deep Conditioning', 'Braids / Weave', 'Trim'];
}

/** Returns staff list — from business.staff array or empty */
function _getStaff(business) {
  return Array.isArray(business?.staff) && business.staff.length > 0
    ? business.staff.map(s => (typeof s === 'string' ? s : s.name || s.displayName || String(s)))
    : [];
}

function _buildServiceIdMap(services) {
  const map = {};
  services.forEach(s => {
    map[`SVC_${s.toUpperCase().replace(/\s+/g, '_')}`] = s;
  });
  return map;
}

function _buildStaffIdMap(staff) {
  const map = {};
  staff.forEach(s => {
    map[`STYLIST_${s.toUpperCase().replace(/\s+/g, '_')}`] = s;
  });
  map['STYLIST_ANY'] = 'Any available';
  return map;
}

function _buildServiceMenu(business, mode = 'booking') {
  const services  = _getServices(business);
  const isBarbershop = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
  const emoji     = isBarbershop ? '✂️' : '💇';
  const heading   = mode === 'walkin'
    ? `${emoji} *Walk-In Queue*\n\nWhat service do you need today?`
    : `${emoji} *Book Appointment*\n\nWhat service would you like to book?`;

  if (services.length <= 3) {
    return {
      type: 'buttons',
      body: heading,
      buttons: services.slice(0, 3).map(s => ({
        id:    `SVC_${s.toUpperCase().replace(/\s+/g, '_')}`,
        title: s.slice(0, 20),
      })),
    };
  }

  return {
    type:   'list',
    body:   heading,
    button: 'Choose service',
    sections: [{
      title: 'Our Services',
      rows: services.slice(0, 10).map(s => ({
        id:    `SVC_${s.toUpperCase().replace(/\s+/g, '_')}`,
        title: s.slice(0, 24),
      })),
    }],
    footer: 'Tap a service or type its name',
  };
}

function _buildStylistMenu(staff, business, isBarbershop) {
  const role    = isBarbershop ? 'barber' : 'stylist';
  const emoji   = isBarbershop ? '✂️' : '💇';
  const options = [...staff, 'Any available'];

  if (options.length <= 3) {
    return {
      type: 'buttons',
      body: `${emoji} Which *${role}* would you prefer?\n\n_(Or choose "Any available" for the next free ${role})_`,
      buttons: options.slice(0, 3).map(s => ({
        id:    s === 'Any available' ? 'STYLIST_ANY' : `STYLIST_${s.toUpperCase().replace(/\s+/g, '_')}`,
        title: s.slice(0, 20),
      })),
    };
  }

  return {
    type:   'list',
    body:   `${emoji} Which *${role}* would you prefer?`,
    button: `Choose ${role}`,
    sections: [{
      title: `Our ${isBarbershop ? 'Barbers' : 'Stylists'}`,
      rows: options.slice(0, 10).map(s => ({
        id:    s === 'Any available' ? 'STYLIST_ANY' : `STYLIST_${s.toUpperCase().replace(/\s+/g, '_')}`,
        title: s.slice(0, 24),
        description: s === 'Any available' ? `Next available ${role}` : undefined,
      })),
    }],
    footer: 'Tap a name or type it',
  };
}

function _buildProductMenu(items, business, isBarbershop) {
  const name  = business?.businessName || business?.name || (isBarbershop ? 'Barbershop' : 'Salon');
  const emoji = isBarbershop ? '✂️' : '💇';

  if (!items.length) {
    return {
      type:    'buttons',
      body:    `${emoji} *${name}*\n\nOur product range is being updated. Please check back soon!`,
      buttons: [{ id: 'BOOK', title: '📅 Book Appointment' }, { id: 'SUPPORT', title: '💬 Contact Us' }],
    };
  }

  const rows = items.slice(0, 10).map((item, i) => ({
    id:          String(i + 1),
    title:       item.name.slice(0, 24),
    description: [
      item.description?.slice(0, 40),
      item.price ? `${item.currency || 'D'}${item.price}` : null,
    ].filter(Boolean).join(' — ').slice(0, 72) || undefined,
  }));

  return {
    type:   'list',
    header: `${emoji} *${name}*`,
    body:   isBarbershop
      ? 'Our grooming products — tap to select:'
      : 'Our hair & beauty products — tap to select:',
    button: 'View Products',
    rows,
    footer: items.length > 10 ? `Showing ${rows.length} of ${items.length} products` : undefined,
  };
}
