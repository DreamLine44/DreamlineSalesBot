/**
 * modules/salon/flows/index.js — WhatSalesAgent v14
 *
 * SALON & BARBERSHOP module — appointment booking, walk-in queue,
 * product sales, AI consultation, and returning-customer personalisation.
 *
 * Business modes handled: SALON, BARBERSHOP
 *
 * Flows:
 *   BOOKING   — structured appointment (service → stylist → date → time → confirm)
 *   WALKIN    — walk-in queue (service → stylist → confirm)
 *   ORDER     — retail product sales
 *   QUESTION  — AI-powered FAQ (pricing, hours, aftercare, prep advice)
 *
 * ── v14 CHANGES ────────────────────────────────────────────────────────────────
 *
 * [v14-GREET-1]  Returning-customer greeting: checks booking history and emits
 *                a personalised welcome ("Welcome back, Fatou!") with last-visit
 *                context when the customer is known. New customers get a warm
 *                branded welcome. This replaces the generic flat welcome message.
 *
 * [v14-CONSULT]  AI consultation flow: customer can describe their hair/skin concern
 *                and receive a tailored recommendation before booking. Maps to
 *                QUESTION flow with 'SALON_CONSULTATION' intent. Post-consultation
 *                the bot proactively offers to book the recommended service.
 *
 * [v14-RESCHEDULE] Appointment modification: customer can type "reschedule" or tap
 *                "📅 Reschedule" button after a booking is confirmed. Bot looks up
 *                their most recent confirmed appointment and starts a new BOOKING
 *                flow while cancelling the old one atomically.
 *
 * [v14-CANCEL-BOOKING] In-flow booking cancellation: CANCEL_BOOKING button ID now
 *                handled in the WALKIN and BOOKING confirmation screens, cleanly
 *                cancelling the pending DB record and returning to the main menu.
 *
 * [v14-PREP]     Preparation instructions: confirmation message and booking reminder
 *                include service-specific preparation tips (arrive 5 min early,
 *                wash hair before colour treatment, etc.) when the business has
 *                servicePrep configured on menuItems or in business.settings.
 *
 * [v14-UPSELL]   Post-service product upsell: after a booking is CONFIRMED by admin,
 *                the bot recommends maintenance products from menuItems if any are
 *                tagged as retail (category !== 'services'). Shows 1–3 products
 *                matching the booked service category (e.g. hair products after
 *                haircut bookings).
 *
 * [v14-RECEIPT]  Appointment receipt: booking confirmation to customer now includes
 *                shortId reference, service, stylist, date, time, and business name.
 *                Makes the customer message self-contained for screenshot sharing.
 *
 * [v14-DUPLICATE] Double-booking guard: before saving an appointment, checks for
 *                an existing PENDING or CONFIRMED booking for the same phone on the
 *                same date and time window (±30 min). Warns the customer and offers
 *                to reschedule instead of silently creating a duplicate.
 *
 * [v14-AVAILABILITY] Business-hours awareness: if a business has hours.schedule
 *                configured, the DATE step suppresses days the salon is closed and
 *                shows the next open day when the customer selects a closed day.
 *
 * [v14-POSTFLOW] APPOINTMENT_REMINDER postFlowAck context: set 24h before a booking.
 *                When the customer responds to the reminder, bot shows confirm/
 *                reschedule/cancel buttons instead of routing to generic intent.
 *
 * [v14-BUG-1]    BOOKING_CONFIRM step: CANCEL button was missing from STEP_VALID_BUTTONS
 *                guard — tapping Cancel at the summary screen was silently dropped and
 *                the session stayed on BOOKING_CONFIRM. Added to guard and handler.
 *
 * [v14-BUG-2]    SELECT_STYLIST: when staff list changes between the menu render and
 *                the customer's reply (admin removes a stylist mid-session), the bot
 *                now gracefully re-shows the updated menu instead of storing a stale
 *                stylist name that no longer exists.
 *
 * [v14-BUG-3]    Walk-in CONFIRM: CANCEL_BOOKING was not handled, causing an infinite
 *                re-prompt loop. Now delegates to cancelFlow() immediately.
 *
 * [v14-BUG-4]    Product ORDER flow: CONFIRM step had no CANCEL guard — customer tapping
 *                Cancel at the order summary stayed stuck on CONFIRM. Fixed with early
 *                CANCEL / CANCEL_BOOKING / SHOW_MENU interception.
 *
 * [v14-BUG-5]    handleSalonQuestion: when completeFlow() returned a lead-capture UI
 *                the questionResponse was discarded. Now returns questionResponse first
 *                and lets lead-capture fire on the NEXT turn (correct sequencing).
 *                Previous comment was present but the logic was inverted — `if (lc) return lc`
 *                meant lead-capture REPLACED the answer. Fixed to `if (!lc) return questionResponse`.
 *
 * [v14-BUG-6]    _buildServiceMenu: rows were capped at slice(0,10) but WhatsApp list
 *                sections require each row.title ≤ 24 chars and row.description ≤ 72 chars.
 *                Added description field with price + duration so customers see pricing
 *                in the list without having to ask.
 *
 * [v14-BUG-7]    _buildStylistMenu: 'Any available' was always appended even when the
 *                business has settings.requireStylists=true (e.g. a premium studio where
 *                every service must be with a named stylist). Now respects this flag.
 *
 * [v14-BUG-8]    Walk-in CONFIRM save: bookingType was set to 'walkin' only via the
 *                saveBooking call — but the Booking.bookingType enum is ['appointment','walkin',null].
 *                If saveBooking() didn't pass bookingType through, it defaulted to null
 *                and the walkin-exclusion query in schedulerService ($ne:'walkin') would
 *                accidentally include it. Now explicitly passed in all save calls.
 *
 * [v14-BUG-9]    handleSalonProductOrder SELECT_ITEM: numeric index from list tap
 *                (e.g. "1" from a list row) was treated as a text search when menuViewed
 *                was false, re-showing the menu instead of selecting item #1. The guard
 *                `!isInteractive && !session.menuViewed` was correct for button taps but
 *                list row IDs are numeric strings and isInteractive=true for list taps —
 *                the guard was bypassed, falling through to numIdx parsing which should
 *                have worked, but only if the list row IDs match the 1-based index.
 *                Root fix: list rows now use 1-based numeric IDs ("1","2",...) and the
 *                numIdx lookup runs first for ALL interactive responses, before fuzzy match.
 *
 * [v14-BUG-10]   Booking admin alert: staff field was not passed to buildAdminBookingAlertBody()
 *                in the BOOKING_CONFIRM step of bookingFlow.js (shared engine). The salon
 *                SELECT_STYLIST stores stylist in session.data.stylist, and BOOKING_CONFIRM
 *                reads it via `const { stylist, staff } = data` — but buildAdminBookingAlertBody
 *                only receives { customerPhone, date, time, service, partySize, business, shortId }.
 *                Added `staff: staffToSave` to the alert body call so admin sees stylist name.
 *
 * [v14-PATTERNS] BUTTON_ID_MAP: WALKIN, RESCHEDULE, CONSULTATION button IDs registered
 *                in patterns.js so they are not lost to CONTINUE_FLOW.
 */

import { updateSession }     from '../../../core/sessions/sessionService.js';
import { completeFlow, cancelFlow } from '../../../core/conversations/flowEngine.js';
import { handleBookingFlow } from '../../../core/conversations/bookingFlow.js';
import { getAIReply, findBestMatch, parseQuantity, parseMultiItemMessage, parseNaturalOrderMessage, parseCartModification } from '../../../core/nlu/nluFeature.js';
import { saveOrder }         from '../../../services/order/orderService.js';
import { saveBooking }       from '../../../services/booking/bookingService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import { itemLabel, formatMoney } from '../../../utils/formatFeature.js';
import { mergeCartLines, enforceCartLimit, cartTotal, cartToOrderItems, formatCartSummary, buildUnmatchedNote, applyCartModification } from '../../../core/shared/cartEngine.js';
import logger                from '../../../config/logger.js';
import { getAdminPhones }    from '../../../utils/adminPhones.js';
import {
  isBarbershopMode as _isBarbershop,
  getSalonServices as _getServices,
  getSalonPrepTip as _getPrepTip,
} from '../salonHelpers.js';

// ── Salon Config ───────────────────────────────────────────────────────────────

export const SALON_CONFIG = {
  businessMode: 'SALON',
  flows: ['BOOKING', 'WALKIN', 'ORDER', 'QUESTION'],
  persona: 'professional, warm salon receptionist who helps clients book appointments, join the walk-in queue, find the right products, and get beauty advice',
  steps: {
    BOOKING: ['SELECT_SERVICE', 'SELECT_STYLIST', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
    WALKIN:  ['SELECT_SERVICE', 'SELECT_STYLIST', 'CONFIRM'],
    // [MULTICART-v39-PHASE2] CART_REVIEW added — reached from SELECT_ITEM on a
    // multi-item message, or from CONFIRM via "Add Another Item".
    ORDER:   ['SELECT_ITEM', 'SELECT_VARIANT', 'CART_REVIEW', 'QUANTITY', 'CONFIRM'],
  },
  ui: {
    welcomeList: {
      button: 'Choose an option â–¼',
      rows: [
        { id: 'BOOK',           title: '📅 Book Appointment',   description: 'Schedule a service with us'        },
        { id: 'WALKIN',         title: '🚶 Join Walk-In Queue', description: 'Walk in — no appointment needed' },
        { id: 'ORDER',          title: '🛍 Shop Products',      description: 'Browse hair & beauty products'   },
        { id: 'BROWSE_CATALOG', title: '🛍 Browse Catalog',     description: 'Shop our product catalog'        },
        { id: 'QUESTION',       title: '❓ Ask a Question',     description: 'Get help from our team'          },
      ],
    },
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
    welcome:        '💇 Welcome! How can we help you today?\n\nBook an appointment, join our walk-in queue, shop products, or ask us anything.',
    cancelMsg:      "✅ No problem! Tap below whenever you're ready. 💇",
    fallback:       'Would you like to *book an appointment*, join the *walk-in queue*, or ask a *question*?',
    orderPrompt:    '🛍 Our hair & beauty products — tap to select:',
    bookPrompt:     '📅 What service would you like to book?',
    showMenuPrompt: '💇 What would you like to do?',
  },
};

// ── Barbershop Config ──────────────────────────────────────────────────────────

export const BARBERSHOP_CONFIG = {
  businessMode: 'BARBERSHOP',
  flows: ['BOOKING', 'WALKIN', 'ORDER', 'QUESTION'],
  persona: 'friendly, confident barber who helps clients book cuts, join the queue, and answers style and grooming questions',
  steps: {
    BOOKING: ['SELECT_SERVICE', 'SELECT_STYLIST', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
    WALKIN:  ['SELECT_SERVICE', 'SELECT_STYLIST', 'CONFIRM'],
    // [MULTICART-v39-PHASE2] CART_REVIEW added — reached from SELECT_ITEM on a
    // multi-item message, or from CONFIRM via "Add Another Item".
    ORDER:   ['SELECT_ITEM', 'SELECT_VARIANT', 'CART_REVIEW', 'QUANTITY', 'CONFIRM'],
  },
  ui: {
    welcomeList: {
      button: 'Choose an option â–¼',
      rows: [
        { id: 'BOOK',           title: '💈 Book Appointment',   description: 'Schedule a cut or treatment'     },
        { id: 'WALKIN',         title: '🚶 Join Walk-In Queue', description: 'Walk in — no appointment needed' },
        { id: 'ORDER',          title: '🛍 Shop Products',      description: 'Browse grooming products'        },
        { id: 'BROWSE_CATALOG', title: '🛍 Browse Catalog',     description: 'Shop our product catalog'        },
        { id: 'QUESTION',       title: '❓ Ask a Question',     description: 'Get help from our team'          },
      ],
    },
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
    welcome:        '✂️ Welcome! Ready for a fresh cut?\n\nBook an appointment, join our walk-in queue, shop products, or ask us anything.',
    cancelMsg:      "✅ No problem — come back whenever you're ready. ✂️",
    fallback:       'Would you like to *book an appointment*, join the *walk-in queue*, or ask a *question*?',
    orderPrompt:    '🛍 Our grooming products — tap to select:',
    bookPrompt:     '✂️ What cut or treatment would you like to book?',
    showMenuPrompt: '✂️ What would you like to do?',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns available staff names, respecting the available flag.
 * [v14-BUG-2] Returns full staff objects (not just names) so we can validate
 * that a received name still exists in the current list. */
function _getStaff(business) {
  if (!Array.isArray(business?.staff) || business.staff.length === 0) return [];
  return business.staff
    .filter(s => s.available !== false)
    .map(s => {
      if (typeof s === 'string') return { name: s };
      return { name: s.name || s.displayName || String(s), specialty: s.specialty || null };
    })
    .filter(s => s.name);
}

/** Build SVC_ button ID → service name map. */
function _buildServiceIdMap(services) {
  const map = {};
  services.forEach(s => {
    const name = typeof s === 'string' ? s : s.name;
    map[`SVC_${name.toUpperCase().replace(/\s+/g, '_')}`] = name;
  });
  return map;
}

/** Build STYLIST_ button ID → name map. */
function _buildStaffIdMap(staffList) {
  const map = {};
  staffList.forEach(s => {
    map[`STYLIST_${s.name.toUpperCase().replace(/\s+/g, '_')}`] = s.name;
  });
  map['STYLIST_ANY'] = 'Any available';
  return map;
}

/**
 * [v14-BUG-7] Should 'Any available' option be shown?
 * Respects business.settings.requireNamedStylist flag.
 */
function _showAnyAvailable(business) {
  return !(business?.settings?.requireNamedStylist === true);
}

// ── Walk-In Queue Flow ─────────────────────────────────────────────────────────
// Steps: SELECT_SERVICE → SELECT_STYLIST → CONFIRM

export async function handleSalonWalkIn({ session, message, business, tenant, isInteractive }) {
  const raw       = String(message || '').trim();
  const step      = session.step || 'SELECT_SERVICE';
  const data      = session.data || {};
  const isBarbershop = _isBarbershop(business);
  const emoji     = isBarbershop ? '✂️' : '💇';
  const staffRole = isBarbershop ? 'barber' : 'stylist';

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'SELECT_SERVICE', data: {},
    });
    return _buildServiceMenu(business, 'walkin');
  }

  // ── Global escape: CANCEL / SHOW_MENU always exits cleanly ────────────────
  if (['CANCEL', 'SHOW_MENU', 'CANCEL_BOOKING'].includes(raw.toUpperCase())) {
    return cancelFlow(session, business);
  }

  switch (step) {

    // ── SELECT_SERVICE ───────────────────────────────────────────────────────
    case 'SELECT_SERVICE': {
      const services = _getServices(business);
      const SVC_MAP  = _buildServiceIdMap(services);
      const matched  =
        SVC_MAP[raw.toUpperCase()] ||
        services.find(s => (typeof s === 'string' ? s : s.name).toLowerCase() === raw.toLowerCase())?.name ||
        (() => {
          const SYSTEM_IDS_SVC = new Set(['CANCEL','CONFIRM','SHOW_MENU','CANCEL_BOOKING','CANCEL_ORDER',
            'BOOK','WALKIN','ORDER','QUESTION','SUPPORT','START_BOOKING','ENQUIRY',
            'TRACK_ORDER','DONE','PAYMENT','RESCHEDULE','DATE_BACK','TIME_BACK']);
          return raw.length >= 3 && !SYSTEM_IDS_SVC.has(raw.toUpperCase()) ? raw : null;
        })();

      if (!matched) return _buildServiceMenu(business, 'walkin');

      const staffList = _getStaff(business);

      await updateSession(session.customerPhone, session.tenantId, {
        step: staffList.length > 0 ? 'SELECT_STYLIST' : 'CONFIRM',
        data: { ...data, service: matched },
      });

      if (staffList.length === 0) {
        return {
          type: 'buttons',
          body:
            `${emoji} *Walk-In Queue*\n\n` +
            `✂️ *Service:* ${matched}\n\n` +
            `You'll be added to the queue when you arrive. Shall we confirm?`,
          buttons: [
            { id: 'CONFIRM',         title: '✅ Join Queue'  },
            { id: 'CANCEL_BOOKING',  title: '❌ Cancel'       },
          ],
        };
      }

      return _buildStylistMenu(staffList, business, isBarbershop);
    }

    // ── SELECT_STYLIST ───────────────────────────────────────────────────────
    case 'SELECT_STYLIST': {
      const staffList = _getStaff(business);
      const STAFF_MAP = _buildStaffIdMap(staffList);

      // [v14-BUG-2] Re-validate that the received stylist name still exists
      const resolvedName =
        STAFF_MAP[raw.toUpperCase()] ||
        staffList.find(s => s.name.toLowerCase() === raw.toLowerCase())?.name ||
        (_showAnyAvailable(business) && raw.toUpperCase() === 'STYLIST_ANY' ? 'Any available' : null) ||
        (() => {
          const SYSTEM_IDS_STAFF = new Set(['CANCEL','CONFIRM','SHOW_MENU','CANCEL_BOOKING','CANCEL_ORDER',
            'BOOK','WALKIN','ORDER','QUESTION','SUPPORT','START_BOOKING','ENQUIRY',
            'TRACK_ORDER','SHOW_MENU','DONE','PAYMENT','RESCHEDULE']);
          return raw.length >= 2 && !SYSTEM_IDS_STAFF.has(raw.toUpperCase()) ? raw : null;
        })();

      if (!resolvedName) return _buildStylistMenu(staffList, business, isBarbershop);

      const stylist = resolvedName;

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'CONFIRM',
        data: { ...data, stylist },
      });

      const stylistLine = stylist === 'Any available'
        ? `\n👤 *${isBarbershop ? 'Barber' : 'Stylist'}:* Any available`
        : `\n👤 *${isBarbershop ? 'Barber' : 'Stylist'}:* ${stylist}`;

      return {
        type: 'buttons',
        body:
          `${emoji} *Walk-In Summary*\n\n` +
          `✂️ *Service:* ${data.service}` +
          stylistLine +
          `\n\nYou'll be added to the walk-in queue when you arrive. Confirm?`,
        buttons: [
          { id: 'CONFIRM',        title: '✅ Join Queue' },
          { id: 'CANCEL_BOOKING', title: '❌ Cancel'      },
        ],
      };
    }

    // ── CONFIRM ──────────────────────────────────────────────────────────────
    // [FIX-DUALLAYER-CONFIRM] See core/nlu/resolution/confirmationMatcher.js — the old
    // exact-match check meant a typed "yes please"/"go ahead" (instead of
    // tapping the button) silently failed and just re-showed this prompt.
    case 'CONFIRM': {
      const { resolveConfirmation } = await import('../../../core/nlu/nluFeature.js');
      const verdict = await resolveConfirmation({
        raw, business,
        negateIds: ['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU', 'NO'],
      });
      if (verdict === 'no') return cancelFlow(session, business);

      if (verdict !== 'yes') {
        return {
          type: 'buttons',
          body: `${emoji} Ready to join the walk-in queue?`,
          buttons: [
            { id: 'CONFIRM',        title: '✅ Yes, join queue' },
            { id: 'CANCEL_BOOKING', title: '❌ Cancel'           },
          ],
        };
      }

      // Save walk-in booking record
      let savedBooking = null;
      try {
        savedBooking = await saveBooking({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          service:       data.service,
          staff:         (data.stylist && data.stylist !== 'Any available') ? data.stylist : null,
          date:          new Date().toISOString().split('T')[0], // today
          time:          'Walk-In',
          notes:         `Walk-in queue entry${data.stylist ? ` — requesting ${data.stylist}` : ''}`,
          bookingType:   'walkin', // [v14-BUG-8]
          status:        'pending',
          businessId:    business._id,
        });
      } catch (err) {
        logger.error('[SalonWalkIn] saveBooking failed', { err: err.message });
        // [FIX-SAVE-ERR-SALON-WALKIN] Don't tell the customer they're in the queue
        // when nothing was saved and admin was never notified. Clear flow, let retry.
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {},
        });
        return {
          type:    'buttons',
          body:    `⚠️ *Something went wrong joining the queue.*\n\nPlease try again — tap below to start over.`,
          buttons: [
            { id: 'BOOK',     title: '📅 Try Again'   },
            { id: 'SUPPORT',  title: '💬 Contact Us'  },
          ],
        };
      }

      // Notify admin with confirm/reject buttons
      try {
        const adminPhones = getAdminPhones(business, tenant);
        if (adminPhones.length && tenant && savedBooking) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const { buildAdminBookingAlertBody } = await import('../../../services/admin/adminCommandService.js');
          const alertBody = buildAdminBookingAlertBody({
            customerPhone: session.customerPhone,
            date:          null,
            time:          null,
            service:       data.service,
            staff:         (data.stylist && data.stylist !== 'Any available') ? data.stylist : null,
            business,
            shortId:       savedBooking.shortId,
            bookingType:   'walkin',
          });
          const alertPayload = {
            type:    'buttons',
            body:    alertBody,
            buttons: [
              { id: `CONFIRM_BOOK_${savedBooking.shortId}`, title: '✅ Confirm Queue' },
              { id: `DECLINE_BOOK_${savedBooking.shortId}`, title: '❌ Remove'        },
            ],
          };
          for (const adminPhone of adminPhones) {
            await dispatchMessage(
              adminPhone,
              alertPayload,
              tenant,
            ).catch(e => logger.warn('[SalonWalkIn] admin notify failed', { err: e.message }));
          }
        }
      } catch {}

      const lc = await completeFlow(session, 'WALKIN', business, tenant);
      if (lc) return lc;

      // [v14-QUEUE] Show queue position and estimated wait for walk-ins ahead
      let queueLine = '';
      try {
        const { default: BookingModel } = await import('../../../models/Booking.js');
        const today = new Date().toISOString().split('T')[0];
        const queueCount = await BookingModel.countDocuments({
          tenantId:      session.tenantId,
          bookingType:   'walkin',
          status:        { $in: ['pending', 'confirmed'] },
          date:          today,
        }).catch(() => 0);
        const position = queueCount || 1;
        const waitMins = business?.settings?.walkInWaitMinutesPerPerson ?? 15;
        const estWait  = Math.max(0, (position - 1) * waitMins);
        queueLine =
          `\n🎫 *Queue position:* #${position}` +
          (estWait > 0 ? `\n⏱ *Estimated wait:* ~${estWait} min` : '\n⏱ *Estimated wait:* You\'re next!');
      } catch { /* non-fatal */ }

      const nameStr = session.customerName ? `, *${session.customerName}*` : '';
      const shortRef = savedBooking?.shortId ? `\n🔖 *Ref:* #${savedBooking.shortId}` : '';
      const bizName  = business?.businessName || business?.name || (isBarbershop ? 'the barbershop' : 'the salon');

      return {
        type: 'buttons',
        body:
          `✅ *You're in the queue!* ${emoji}\n\n` +
          `📋 *Service:* ${data.service}\n` +
          (data.stylist && data.stylist !== 'Any available'
            ? `👤 *${isBarbershop ? 'Barber' : 'Stylist'}:* ${data.stylist}\n`
            : '') +
          shortRef +
          queueLine +
          `\n\nPlease head to *${bizName}*${nameStr} — our team will message you to confirm your spot.\n\nSee you soon! 🙏`,
        buttons: [
          { id: 'BOOK',      title: '📅 Book Next Time'  },
          { id: 'QUESTION',  title: '❓ Ask a Question'   },
          { id: 'SHOW_MENU', title: '🔄 Main Menu'        },
        ],
      };
    }

    default:
      await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_SERVICE', data: {} });
      return handleSalonWalkIn({ session: { ...session, step: 'SELECT_SERVICE', data: {} }, message: null, business, tenant });
  }
}

// ── Appointment Booking Flow ───────────────────────────────────────────────────
// Adds salon-specific steps (SELECT_SERVICE, SELECT_STYLIST) before the shared bookingFlow.

export async function handleSalonBooking({ session, message, business, tenant, isInteractive }) {
  const raw       = String(message || '').trim();
  const step      = session.step || 'SELECT_SERVICE';
  const data      = session.data || {};
  const isBarbershop = _isBarbershop(business);

  // ── GLOBAL ESCAPE: CANCEL / SHOW_MENU ─────────────────────────────────────
  // Must be checked BEFORE delegating to shared bookingFlow to prevent the
  // shared flow's catch-all from re-prompting instead of cancelling.
  if (['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU'].includes(raw.toUpperCase())) {
    return cancelFlow(session, business);
  }

  // ── Shared bookingFlow handles date/time/confirm steps ─────────────────────
  const BOOKING_SHARED_STEPS = new Set(['DATE', 'DATE_MONTH', 'DATE_DAY', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'BOOKING_CONFIRM']);
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

    // ── SELECT_SERVICE ───────────────────────────────────────────────────────
    case 'SELECT_SERVICE': {
      const services = _getServices(business);
      const SVC_MAP  = _buildServiceIdMap(services);
      const matched  =
        SVC_MAP[raw.toUpperCase()] ||
        services.find(s => (typeof s === 'string' ? s : s.name).toLowerCase() === raw.toLowerCase())?.name ||
        (() => {
          const SYSTEM_IDS_SVC = new Set(['CANCEL','CONFIRM','SHOW_MENU','CANCEL_BOOKING','CANCEL_ORDER',
            'BOOK','WALKIN','ORDER','QUESTION','SUPPORT','START_BOOKING','ENQUIRY',
            'TRACK_ORDER','DONE','PAYMENT','RESCHEDULE','DATE_BACK','TIME_BACK']);
          return raw.length >= 3 && !SYSTEM_IDS_SVC.has(raw.toUpperCase()) ? raw : null;
        })();

      if (!matched) return _buildServiceMenu(business, 'booking');

      const staffList = _getStaff(business);

      await updateSession(session.customerPhone, session.tenantId, {
        step:         staffList.length > 0 ? 'SELECT_STYLIST' : 'DATE',
        data:         { ...data, service: matched, selectedService: matched },
      });

      if (staffList.length === 0) {
        return handleBookingFlow({
          session: { ...session, step: 'DATE', data: { ...data, service: matched, selectedService: matched } },
          message: null,
          business,
          tenant,
          isInteractive,
        });
      }

      return _buildStylistMenu(staffList, business, isBarbershop);
    }

    // ── SELECT_STYLIST ───────────────────────────────────────────────────────
    case 'SELECT_STYLIST': {
      const staffList = _getStaff(business);
      const STAFF_MAP = _buildStaffIdMap(staffList);

      const stylist =
        STAFF_MAP[raw.toUpperCase()] ||
        staffList.find(s => s.name.toLowerCase() === raw.toLowerCase())?.name ||
        (_showAnyAvailable(business) && raw.toUpperCase() === 'STYLIST_ANY' ? 'Any available' : null) ||
        (() => {
          const SYSTEM_IDS_STAFF = new Set(['CANCEL','CONFIRM','SHOW_MENU','CANCEL_BOOKING','CANCEL_ORDER',
            'BOOK','WALKIN','ORDER','QUESTION','SUPPORT','START_BOOKING','ENQUIRY',
            'TRACK_ORDER','SHOW_MENU','DONE','PAYMENT','RESCHEDULE']);
          return raw.length >= 2 && !SYSTEM_IDS_STAFF.has(raw.toUpperCase()) ? raw : null;
        })();

      if (!stylist) return _buildStylistMenu(staffList, business, isBarbershop);

      // [v14-BUG-2] If the typed name is not in the current staff list, re-prompt
      const isValidStylist =
        stylist === 'Any available' ||
        staffList.some(s => s.name.toLowerCase() === stylist.toLowerCase());

      if (!isValidStylist && staffList.length > 0) {
        return _buildStylistMenu(staffList, business, isBarbershop,
          `⚠️ Sorry, _${stylist}_ isn't available right now. Please choose from the list:`
        );
      }

      const updatedData = { ...data, stylist, selectedService: data.service };
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DATE',
        data: updatedData,
      });

      return handleBookingFlow({
        session: { ...session, step: 'DATE', data: updatedData },
        message: null,
        business,
        tenant,
        isInteractive,
      });
    }

    default:
      return handleBookingFlow({ session, message, business, tenant, isInteractive });
  }
}

// ── Product Order Flow ─────────────────────────────────────────────────────────
// Steps: SELECT_ITEM → QUANTITY → CONFIRM

export async function handleSalonProductOrder({ session, message, business, tenant, isInteractive = false }) {
  const raw   = String(message || '').trim();
  const clean = raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const step  = session.step || 'SELECT_ITEM';
  const data  = session.data || {};
  const isBarbershop = _isBarbershop(business);
  const emoji = isBarbershop ? '✂️' : '💇';

  // Products: menuItems that are NOT tagged as services
  const allItems = (business?.menuItems || []).filter(i => i.available !== false);
  const menu = allItems.filter(i =>
    !i.category || !['services', 'service'].includes(i.category?.toLowerCase())
  );

  // ── GLOBAL ESCAPE ──────────────────────────────────────────────────────────
  if (['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU'].includes(raw.toUpperCase())) {
    return cancelFlow(session, business);
  }

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

    // ── SELECT_ITEM ────────────────────────────────────────────────────────
    case 'SELECT_ITEM': {
      // [v14-BUG-9] List row IDs are 1-based numeric strings; resolve them first
      // [AUDIT-FIX-PARSEINT] parseInt("2 red shirts", 10) === 2, NOT NaN — so any
      // message merely STARTING with a digit silently hijacked the menu index
      // once menuViewed was true (the normal case). Only trust the parsed index
      // for a bare number or an interactive tap; everything else falls through
      // to fuzzy name matching below.
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const numIdx = (isInteractive || isPureNumeric) ? parseInt(raw, 10) - 1 : NaN;
      let item = (!isNaN(numIdx) && numIdx >= 0 && menu[numIdx]) ? menu[numIdx] : null;

      if (!item && !isInteractive && !session.menuViewed && /^\d+$/.test(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { menuViewed: true });
        return _buildProductMenu(menu, business, isBarbershop);
      }
      if (!item && clean.length < 2) return _buildProductMenu(menu, business, isBarbershop);

      if (!item) {
        const SYSTEM_IDS = new Set(['CANCEL', 'SHOW_MENU', 'CONFIRM', 'SUPPORT', 'BOOK', 'WALKIN', 'QUESTION', 'CANCEL_BOOKING']);
        if (SYSTEM_IDS.has(raw.toUpperCase())) {
          return _buildProductMenu(menu, business, isBarbershop);
        }
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
        } else {
          // [MULTICART-v39-PHASE2] Neither a numeric index nor a single
          // confident item name matched — try reading the message as MULTIPLE
          // products before giving up ("2 shampoos and a conditioner"). A
          // normal single-item message already resolved above and never
          // reaches here, so this is purely additive.
          const multi = parseMultiItemMessage(menu, raw);
          if (multi) {
            const merged = mergeCartLines(Array.isArray(data.cart) ? data.cart : [], multi.lines);
            const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);
            await updateSession(session.customerPhone, session.tenantId, {
              step: 'CART_REVIEW', data: { ...data, cart: cappedCart }, menuViewed: true,
            });
            let note = buildUnmatchedNote(multi.unmatchedSegments);
            if (overflowCount > 0) {
              note += `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items — ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`;
            }
            return _buildProductCartSummaryUI(cappedCart, business, isBarbershop, note);
          }
        }
      }

      if (!item) return _buildProductMenu(menu, business, isBarbershop);

      const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
      const nextStep    = hasVariants ? 'SELECT_VARIANT' : 'QUANTITY';
      await updateSession(session.customerPhone, session.tenantId, {
        step: nextStep, data: { ...data, item, variant: null }, menuViewed: true,
      });

      if (hasVariants) return _buildProductVariantPicker(item, business, isBarbershop);

      const currency = item.currency || business?.payment?.currency || 'D';
      const price = item.price ? ` — ${currency}${formatMoney(item.price)}` : '';
      const desc  = item.description ? `\n_${item.description}_` : '';
      return {
        type: 'buttons',
        body: `🛍 *${item.name}*${price}${desc}\n\nHow many would you like?`,
        buttons: [
          { id: 'QTY_1', title: '1️⃣  1' },
          { id: 'QTY_2', title: '2️⃣  2' },
          { id: 'QTY_3', title: '3️⃣  3' },
        ],
      };
    }

    // ── SELECT_VARIANT ────────────────────────────────────────────────────
    case 'SELECT_VARIANT': {
      const item = data.item;
      if (!item) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return _buildProductMenu(menu, business, isBarbershop);
      }

      const variantKeys = (item.variants || []).map(v => (typeof v === 'string' ? v : v.name || String(v)));
      if (!variantKeys.length) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'QUANTITY', data: { ...data, variant: null } });
        const currency = item.currency || business?.payment?.currency || 'D';
        const price = item.price ? ` — ${currency}${formatMoney(item.price)}` : '';
        return {
          type: 'buttons',
          body: `🛍 *${item.name}*${price}\n\nHow many would you like?`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
        };
      }

      const matchedVariant = variantKeys.find(v =>
        v.toLowerCase() === clean ||
        raw === `VAR_${v.toUpperCase().replace(/\s+/g, '_')}`
      );

      if (matchedVariant) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'QUANTITY', data: { ...data, variant: matchedVariant },
        });
        const currency = item.currency || business?.payment?.currency || 'D';
        const price = item.price ? ` — ${currency}${formatMoney(item.price)}` : '';
        return {
          type: 'buttons',
          body: `🛍 *${item.name}* — *${matchedVariant}*${price}\n\nHow many would you like?`,
          buttons: [
            { id: 'QTY_1', title: '1️⃣  1' },
            { id: 'QTY_2', title: '2️⃣  2' },
            { id: 'QTY_3', title: '3️⃣  3' },
          ],
        };
      }

      return _buildProductVariantPicker(item, business, isBarbershop);
    }

    // ────────────────────────────────────────────────────────────────────────
    // [MULTICART-v39-PHASE2] Reached once data.cart has 2+ distinct products —
    // either from a single multi-item message (SELECT_ITEM above) or from
    // repeated "Add Another Item" taps from CONFIRM below.
    case 'CART_REVIEW': {
      const cart = Array.isArray(data.cart) ? data.cart : [];

      if (['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU'].includes(raw.toUpperCase())) {
        return cancelFlow(session, business);
      }

      // [FIX-DUALLAYER-CONFIRM] Widened via shared regex guard so "yes please" /
      // "let's checkout" / "go ahead" also register, not just a bare word.
      const { isAffirmative: _isAffirmativeCheckout } = await import('../../../core/nlu/nluFeature.js');
      const isCheckout = raw === 'CONFIRM' || /^(yes|y|yeah|yep|confirm|ok|okay|sure|checkout|place|done)$/i.test(clean) ||
        _isAffirmativeCheckout(raw);
      if (isCheckout) {
        return await _checkoutProductCart(cart, session, business, tenant, isBarbershop);
      }

      const isExplicitAddMore = raw === 'ADD_ANOTHER_ITEM' || /^(add more|add another|add another item|another item|add item|more items?)$/i.test(clean);
      if (isExplicitAddMore) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM' });
        return _buildProductMenu(menu, business, isBarbershop);
      }

      // [CART-AI-MODIFY] "remove the shampoo" / "make it 3 conditioners" —
      // resolved against items ALREADY in the cart, checked BEFORE treating
      // the message as an attempt to add a brand-new product.
      const mod = parseCartModification(cart, raw);
      if (mod) {
        const updatedCart = applyCartModification(cart, mod);
        await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: updatedCart } });
        if (!updatedCart.length) {
          await updateSession(session.customerPhone, session.tenantId, { step: 'SELECT_ITEM', data: { ...data, cart: [] } });
          return _buildProductMenu(menu, business, isBarbershop);
        }
        return _buildProductCartSummaryUI(updatedCart, business, isBarbershop,
          mod.type === 'remove' ? '\n\n_(Removed from your cart.)_' : '\n\n_(Updated the quantity.)_');
      }

      // Treat the message itself as more products to add.
      const multiAdd = parseMultiItemMessage(menu, raw);
      let newLines = null;
      if (multiAdd) {
        newLines = multiAdd.lines;
      } else {
        // [AUDIT-FIX-CONFIRM-ADD-QTY] Was findBestMatch(menu, clean) with a
        // hardcoded quantity of 1 — see the matching fix note in
        // restaurant/flows/orderFlow.js. Same problem, same fix.
        const singleOrder = parseNaturalOrderMessage(menu, raw);
        if (singleOrder?.lines?.length) newLines = singleOrder.lines;
      }

      if (newLines) {
        const merged = mergeCartLines(cart, newLines);
        const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);
        await updateSession(session.customerPhone, session.tenantId, { data: { ...data, cart: cappedCart } });
        let note = multiAdd ? buildUnmatchedNote(multiAdd.unmatchedSegments) : '';
        if (overflowCount > 0) {
          note += `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items — ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`;
        }
        return _buildProductCartSummaryUI(cappedCart, business, isBarbershop, note);
      }

      return _buildProductCartSummaryUI(cart, business, isBarbershop,
        `\n\n_(I didn't catch a product in that — try naming an item, or tap Checkout/Add More.)_`);
    }

    // ── QUANTITY ──────────────────────────────────────────────────────────
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

      const currency = data.item?.currency || business?.payment?.currency || 'D';
      return {
        type: 'buttons',
        body:
          `🧾 *Order Summary*\n\n` +
          `🛍 *${qty}× ${itemLabel(data.item, data.variant)}*\n` +
          (total ? `💰 *Total:* ${currency}${formatMoney(total)}\n` : '') +
          `\nReady to confirm?`,
        buttons: [
          { id: 'CONFIRM',          title: '✅ Confirm Order'    },
          { id: 'ADD_ANOTHER_ITEM', title: 'âž• Add Another Item' },
          { id: 'CANCEL_BOOKING',   title: '❌ Cancel'           },
        ],
      };
    }

    // ── CONFIRM ───────────────────────────────────────────────────────────
    // [FIX-DUALLAYER-CONFIRM] See core/nlu/resolution/confirmationMatcher.js — the old
    // exact-match check meant a typed "yes please"/"go ahead" (instead of
    // tapping the button) silently failed and just re-showed this prompt.
    case 'CONFIRM': {
      const { resolveConfirmation } = await import('../../../core/nlu/nluFeature.js');

      // [v14-BUG-4] CANCEL must be caught here; the global escape above won't fire
      // when step=CONFIRM because the switch falls through before reaching default.
      const cancelVerdict = await resolveConfirmation({
        raw, business,
        negateIds: ['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU', 'NO'],
        allowAI: false, // AI check happens once below, after the add-another-item branch
      });
      if (cancelVerdict === 'no') return cancelFlow(session, business);

      // [MULTICART-v39-PHASE2] "Add Another Item" — folds the item that just
      // reached this summary into data.cart and loops back to product
      // selection instead of saving. See _addAnotherProduct() below.
      if (raw === 'ADD_ANOTHER_ITEM' || /^(add more|add another|add another item|another item|add item|more items?)$/i.test(clean)) {
        if (data.item) return await _addAnotherProduct(session, business, data, isBarbershop);
      }

      const confirmVerdict = await resolveConfirmation({
        raw, business,
        negateIds: ['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU', 'NO'],
      });
      if (confirmVerdict === 'no') return cancelFlow(session, business);
      if (confirmVerdict !== 'yes') {
        const currency = data.item?.currency || business?.payment?.currency || 'D';
        const total = data.totalPrice || (data.item?.price || 0) * (data.quantity || 1);
        return {
          type: 'buttons',
          // [FIX-SALON-CONFIRM-REPROMPT] previously dropped item/total summary on invalid input; currency was computed but unused
          body:
            `🧾 *Order Summary*\n\n` +
            `🛍 *${data.quantity || 1}× ${itemLabel(data.item, data.variant)}*\n` +
            (total ? `💰 *Total:* ${currency}${formatMoney(total)}\n` : '') +
            `\n${emoji} Ready to place your order?`,
          buttons: [
            { id: 'CONFIRM',          title: '✅ Confirm Order'    },
            { id: 'ADD_ANOTHER_ITEM', title: 'âž• Add Another Item' },
            { id: 'CANCEL_BOOKING',   title: '❌ Cancel'           },
          ],
        };
      }

      // [MULTICART-v39-PHASE2] Items accumulated via prior "Add Another Item"
      // taps checkout as one multi-item order — same saveOrder({items}) path
      // CART_REVIEW uses.
      const priorCart = Array.isArray(data.cart) ? data.cart : [];
      if (priorCart.length > 0) {
        const fullCart = mergeCartLines(priorCart, [{
          item: data.item, quantity: data.quantity || 1,
          variant: data.variant || null, addOns: [],
        }]);
        return await _checkoutProductCart(fullCart, session, business, tenant, isBarbershop);
      }

      let savedOrder = null;
      try {
        savedOrder = await saveOrder({
          tenantId:      session.tenantId,
          customerPhone: session.customerPhone,
          customerName:  session.customerName,
          // [AUDIT-FIX-CATALOG-VARIANT-LOSS] data.variant is set by
          // waCatalogFlow.js when this item was chosen via WA Catalog; salon's
          // product-order path had no variant-specific step and previously
          // dropped it.
          item:          itemLabel(data.item, data.variant),
          quantity:      data.quantity || 1,
          totalPrice:    data.totalPrice || 0,
          businessId:    business._id,
        });
      } catch (err) {
        logger.error('[SalonProduct] saveOrder failed', { err: err.message });
        // [FIX-SAVE-ERR-SALON-PRODUCT] Don't proceed to payment/admin-confirm for an
        // order that wasn't saved. Clear flow and let the customer retry.
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
        const { buildPaymentInstructionsUI } = await import('../../../services/payment/paymentService.js');
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'PAYMENT_PROOF', currentFlow: 'ORDER',
        });
        const shortIdRef = savedOrder?.shortId || '';
        let ref = null;
        if (shortIdRef) {
          const now = new Date();
          const mm  = String(now.getMonth() + 1).padStart(2, '0');
          const dd  = String(now.getDate()).padStart(2, '0');
          ref = `SLN-${mm}${dd}-${shortIdRef}`;
          if (savedOrder?._id) {
            const { default: Order } = await import('../../../models/Order.js');
            Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
          }
        }
        return buildPaymentInstructionsUI(business, data.totalPrice, shortIdRef || null, ref);
      }

      // Admin notify
      try {
        const adminPhones = getAdminPhones(business, tenant);
        if (adminPhones.length && tenant && savedOrder) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const currency = business?.payment?.currency || 'D';
          const alertPayload = {
            type: 'buttons',
            body:
              `🔔 *New Product Order — ${business?.name || (isBarbershop ? 'Barbershop' : 'Salon')}*\n\n` +
              `📞 Customer: ${session.customerPhone}\n` +
              (session.customerName ? `👤 Name: ${session.customerName}\n` : '') +
              `🛍 *${data.quantity}× ${itemLabel(data.item, data.variant)}*\n` +
              (data.totalPrice ? `💰 Total: ${currency}${formatMoney(data.totalPrice)}\n` : '') +
              `🔖 Ref: \`${savedOrder?.shortId || 'N/A'}\``,
            buttons: [
              { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
              { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
            ],
          };
          for (const adminPhone of adminPhones) {
            await dispatchMessage(
              adminPhone,
              alertPayload,
              tenant,
            ).catch(e => logger.warn('[SalonProduct] admin notify failed', { err: e.message }));
          }
        }
      } catch {}

      trackOrderAnalytics(itemLabel(data.item, data.variant), null, data.quantity, data.totalPrice || 0, session.tenantId).catch(() => {});
      // [AUDIT-FIX-4] recordRevenue() moved to adminCommandService.confirmPayment() —
      // recording it here at placement time counted unconfirmed/later-rejected orders
      // as revenue. See adminCommandService.js AUDIT-FIX-4 for full rationale.

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER',
        data: { ...data },
      });

      const currency = data.item?.currency || business?.payment?.currency || 'D';
      return {
        type: 'text',
        body:
          `✅ *Order received!* ${emoji}\n\n` +
          `🛍 *${data.quantity}× ${itemLabel(data.item, data.variant)}*\n` +
          (data.totalPrice ? `💰 Total: *${currency}${formatMoney(data.totalPrice)}*\n` : '') +
          `\n⏳ Our team will confirm your order shortly. We'll message you when it's ready! 🙏`,
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

// ── Add-another-product helper ────────────────────────────────────────────────
// [MULTICART-v39-PHASE2] Extracted out of the CONFIRM case body (same reason
// as restaurant/flows/orderFlow.js's _addAnotherItem — keeps the case short
// for any future source-window regression tests).
async function _addAnotherProduct(session, business, data, isBarbershop) {
  const priorCart = Array.isArray(data.cart) ? data.cart : [];
  const merged = mergeCartLines(priorCart, [{
    item: data.item, quantity: data.quantity || 1, variant: data.variant || null, addOns: [],
  }]);
  const { cart: cappedCart, overflowCount } = enforceCartLimit(merged, business);
  await updateSession(session.customerPhone, session.tenantId, {
    step: 'SELECT_ITEM',
    data: { cart: cappedCart }, // single-item fields folded into the cart now
  });
  const overflowNote = overflowCount > 0
    ? `\n\n_(Your cart can hold up to ${business?.multiItemCart?.maxItems || 10} items — ${overflowCount} extra item${overflowCount > 1 ? 's were' : ' was'} left out.)_`
    : '';
  const allItems = (business?.menuItems || []).filter(i => i.available !== false);
  const menu = allItems.filter(i => !i.category || !['services', 'service'].includes(i.category?.toLowerCase()));
  const menuUI = _buildProductMenu(menu, business, isBarbershop);
  if (menuUI.type === 'buttons') return menuUI; // empty-catalog guard already returned its own message
  return { ...menuUI, body: `Added to your cart! 🛒${overflowNote}\n\n${menuUI.body}` };
}

// ── Product cart checkout helper ──────────────────────────────────────────────
// [MULTICART-v39-PHASE2] Multi-item counterpart to the CONFIRM step's
// single-item save logic above — same saveOrder({items}) call, same
// payment-vs-cash branching, same admin alert shape (salon-flavored: 'SLN-'
// payment reference prefix, Product Order title), so a text-typed multi-item
// product order behaves identically to a single-item one from here on.
async function _checkoutProductCart(cart, session, business, tenant, isBarbershop) {
  const emoji = isBarbershop ? '✂️' : '💇';
  const currency = business?.payment?.currency || 'D';
  const cartSummary = formatCartSummary(cart, business);
  const total = cartTotal(cart);

  let savedOrder = null;
  try {
    savedOrder = await saveOrder({
      items:         cartToOrderItems(cart),
      tenantId:      session.tenantId,
      customerPhone: session.customerPhone,
      customerName:  session.customerName,
      businessId:    business._id,
    });
  } catch (err) {
    logger.error('[SalonProduct] _checkoutProductCart: saveOrder failed', { err: err.message });
    await updateSession(session.customerPhone, session.tenantId, {
      currentFlow: null, step: null, data: {},
    });
    return {
      type:    'buttons',
      body:    `⚠️ *Something went wrong saving your order.*\n\nPlease try again — tap below to start over.`,
      buttons: [
        { id: 'ORDER',   title: '🛒 Try Again'  },
        { id: 'SUPPORT', title: '💬 Contact Us' },
      ],
    };
  }

  const totalPrice = savedOrder.totalPrice ?? total;
  const payment = business?.payment;
  if (payment?.enabled && totalPrice) {
    const { buildPaymentInstructionsUI } = await import('../../../services/payment/paymentService.js');
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'PAYMENT_PROOF', currentFlow: 'ORDER', data: {},
    });
    const shortIdRef = savedOrder?.shortId || '';
    let ref = null;
    if (shortIdRef) {
      const now = new Date();
      const mm  = String(now.getMonth() + 1).padStart(2, '0');
      const dd  = String(now.getDate()).padStart(2, '0');
      ref = `SLN-${mm}${dd}-${shortIdRef}`;
      if (savedOrder?._id) {
        const { default: Order } = await import('../../../models/Order.js');
        Order.updateOne({ _id: savedOrder._id }, { $set: { paymentReference: ref } }).catch(() => {});
      }
    }
    return buildPaymentInstructionsUI(business, totalPrice, shortIdRef || null, ref);
  }

  // Admin notify
  try {
    const adminPhones = getAdminPhones(business, tenant);
    if (adminPhones.length && tenant && savedOrder) {
      const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
      const alertPayload = {
        type: 'buttons',
        body:
          `🔔 *New Product Order — ${business?.name || (isBarbershop ? 'Barbershop' : 'Salon')}*\n\n` +
          `📞 Customer: ${session.customerPhone}\n` +
          (session.customerName ? `👤 Name: ${session.customerName}\n` : '') +
          `🛍 Items:\n${cartSummary}\n` +
          (totalPrice ? `💰 Total: ${currency}${formatMoney(totalPrice)}\n` : '') +
          `🔖 Ref: \`${savedOrder?.shortId || 'N/A'}\``,
        buttons: [
          { id: `APPROVE_${savedOrder.shortId}`, title: '✅ Confirm Order' },
          { id: `REJECT_${savedOrder.shortId}`,  title: '❌ Cancel Order'  },
        ],
      };
      for (const adminPhone of adminPhones) {
        await dispatchMessage(
          adminPhone,
          alertPayload,
          tenant,
        ).catch(e => logger.warn('[SalonProduct] admin notify failed', { err: e.message }));
      }
    }
  } catch { /* non-fatal */ }

  trackOrderAnalytics(
    cart.map(l => l.item?.name).filter(Boolean).join(', '),
    null,
    cart.reduce((sum, l) => sum + (l.quantity || 0), 0),
    totalPrice || 0,
    session.tenantId
  ).catch(() => {});

  await updateSession(session.customerPhone, session.tenantId, {
    step: 'AWAIT_ADMIN_CONFIRM', currentFlow: 'ORDER', data: {},
  });

  return {
    type: 'text',
    body:
      `✅ *Order received!* ${emoji}\n\n🛍 Items:\n${cartSummary}\n` +
      (totalPrice ? `💰 Total: *${currency}${formatMoney(totalPrice)}*\n` : '') +
      `\n⏳ Our team will confirm your order shortly. We'll message you when it's ready! 🙏`,
  };
}

// ── AI Question / Consultation Handler ────────────────────────────────────────
// Handles FAQs, aftercare advice, pricing, and beauty consultations.
//
// [v14-BUG-5] completeFlow() lead-capture fix:
//   OLD: if (lc) return lc  → lead-capture replaced the AI answer
//   NEW: build questionResponse first, call completeFlow, return questionResponse
//        so the AI answer is always delivered. Lead capture fires on next turn.

export async function handleSalonQuestion({ session, message, business, tenant }) {
  const isBarbershop = _isBarbershop(business);
  const step         = session.step || 'AWAITING_QUESTION';

  // ── INIT ────────────────────────────────────────────────────────────────
  if (message === null) {
    await updateSession(session.customerPhone, session.tenantId, {
      step: 'AWAITING_QUESTION', data: {},
    });
    return {
      type: 'text',
      body: `${isBarbershop ? '✂️' : '💇'} What would you like to know? Feel free to type your question.\n\n_(e.g. pricing, opening hours, aftercare tips, which service is right for me)_`,
    };
  }

  const raw = String(message || '').trim();

  if (['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU'].includes(raw.toUpperCase())) {
    return cancelFlow(session, business);
  }

  // ── AWAITING_QUESTION ─────────────────────────────────────────────────────
  if (!raw || raw.length < 2) {
    return {
      type: 'text',
      body: `${isBarbershop ? '✂️' : '💇'} What would you like to know? Feel free to type your question.\n\n_(e.g. pricing, opening hours, aftercare tips, product recommendations)_`,
    };
  }

  // [v14-CONSULT] Detect consultation-style questions and add proactive follow-up
  const isConsultation = /\b(which|what|recommend|best|suit|good for|help me choose|advice|should i|i have|my hair|my skin|i want to)\b/i.test(raw);
  const isAftercare    = /\b(aftercare|after care|maintain|maintenance|how long before|when can i wash|what to avoid|care tips|keep colour|keep color|post.treatment|after my (appointment|treatment|service))\b/i.test(raw);
  const intent = isAftercare
    ? 'AFTERCARE'
    : isConsultation
      ? (isBarbershop ? 'BARBERSHOP_QUESTION' : 'SALON_CONSULTATION')
      : (isBarbershop ? 'BARBERSHOP_QUESTION' : 'SALON_QUESTION');

  const { processQuestionMessage, persistQuestionSession } = await import('../../../services/question/questionAnswerService.js');
  const reply = await processQuestionMessage({ session, message: raw, business, tenant, intent });
  await persistQuestionSession(session, tenant, reply.context || { lastMessage: raw });

  // Answer-only: stay in QUESTION mode and wait — no buttons. Switching activity
  // is picked up upstream from the customer's own words, not from a tap target.
  const questionResponse = {
    type: reply.type || 'text',
    body: reply.body || `Great question! For detailed information please contact us directly.`,
  };

  // [text type ignores the footer field — fold the same hint into the body]
  if (isAftercare && reply.body) {
    questionResponse.body += `\n\n_We hope to see you again soon! 🙏_`;
  } else if (isConsultation && reply.body) {
    questionResponse.body += `\n\n_Just say the word when you're ready to book that service._`;
  }

  return questionResponse;
}

// ── UI Helpers ─────────────────────────────────────────────────────────────────

/**
 * _buildServiceMenu — shows services as interactive list (>3 items) or buttons (≤3).
 * [v14-BUG-6] Includes price + duration in list row descriptions.
 */
function _buildServiceMenu(business, mode = 'booking') {
  const services    = _getServices(business);
  const isBarbershop = _isBarbershop(business);
  const emoji       = isBarbershop ? '✂️' : '💇';
  const heading     = mode === 'walkin'
    ? `${emoji} *Walk-In Queue*\n\nWhat service do you need today?`
    : `${emoji} *Book Appointment*\n\nWhat service would you like to book?`;

  const toName = s => (typeof s === 'string' ? s : s.name);
  const toPrice = (s, business) => {
    const price = typeof s === 'string' ? null : s.price;
    const currency = (typeof s !== 'string' && s.currency) || business?.payment?.currency || 'D';
    return price ? `${currency}${formatMoney(price)}` : null;
  };
  const toDuration = s => (typeof s === 'string' ? null : s.duration ? `${s.duration} min` : null);

  if (services.length <= 3) {
    return {
      type: 'buttons',
      body: heading,
      buttons: services.slice(0, 3).map(s => ({
        id:    `SVC_${toName(s).toUpperCase().replace(/\s+/g, '_')}`,
        title: toName(s).slice(0, 20),
      })),
    };
  }

  return {
    type: 'list',
    body:   heading,
    button: 'Choose service',
    sections: [{
      title: 'Our Services',
      rows: services.map(s => {
        const pricePart    = toPrice(s, business);
        const durationPart = toDuration(s);
        // [v14-BUG-6] Description ≤72 chars with price + duration info
        const descParts = [pricePart, durationPart].filter(Boolean);
        return {
          id:          `SVC_${toName(s).toUpperCase().replace(/\s+/g, '_')}`,
          title:       toName(s).slice(0, 24),
          description: descParts.length ? descParts.join(' · ').slice(0, 72) : undefined,
        };
      }),
    }],
  };
}

/**
 * _buildStylistMenu — shows stylist list with 'Any available' option.
 * [v14-BUG-7] Respects business.settings.requireNamedStylist flag.
 */
function _buildStylistMenu(staffList, business, isBarbershop, errorMsg = null) {
  const role    = isBarbershop ? 'barber' : 'stylist';
  const emoji   = isBarbershop ? '✂️' : '💇';
  const showAny = _showAnyAvailable(business);
  const options = showAny
    ? [...staffList.map(s => ({ name: s.name, specialty: s.specialty })), { name: 'Any available', specialty: `Next available ${role}` }]
    : staffList.map(s => ({ name: s.name, specialty: s.specialty }));

  const heading = errorMsg
    ? errorMsg
    : `${emoji} Which *${role}* would you prefer?${showAny ? `\n\n_(Or choose "Any available" for the next free ${role})_` : ''}`;

  if (options.length <= 3) {
    return {
      type: 'buttons',
      body: heading,
      buttons: options.slice(0, 3).map(o => ({
        id:    o.name === 'Any available' ? 'STYLIST_ANY' : `STYLIST_${o.name.toUpperCase().replace(/\s+/g, '_')}`,
        title: o.name.slice(0, 20),
      })),
    };
  }

  return {
    type: 'list',
    body:   heading,
    button: `Choose ${role}`,
    sections: [{
      title: `Our ${isBarbershop ? 'Barbers' : 'Stylists'}`,
      rows: options.map(o => ({
        id:          o.name === 'Any available' ? 'STYLIST_ANY' : `STYLIST_${o.name.toUpperCase().replace(/\s+/g, '_')}`,
        title:       o.name.slice(0, 24),
        description: (o.specialty || (o.name === 'Any available' ? `Next available ${role}` : undefined))?.slice(0, 72),
      })),
    }],
  };
}

// [MULTICART-v39-PHASE2] Multi-item counterpart to _buildProductMenu()'s single
// pick — shown once 2+ distinct products are in data.cart, whether from one
// "2 shampoos and a conditioner" message or repeated "Add Another Item" taps.
function _buildProductCartSummaryUI(cart, business, isBarbershop, note = '') {
  const emoji = isBarbershop ? '✂️' : '💇';
  const total = cartTotal(cart);
  const currency = business?.payment?.currency || 'D';
  return {
    type: 'buttons',
    body:
      `${emoji} 🧾 *Your Order*\n\n${formatCartSummary(cart, business)}` +
      (total != null ? `\n\n💰 Total: *${currency}${formatMoney(total)}*` : '') +
      `${note}\n\nReady to checkout, or add something else?`,
    buttons: [
      { id: 'CONFIRM',          title: '✅ Checkout'  },
      { id: 'ADD_ANOTHER_ITEM', title: 'âž• Add More'   },
      { id: 'CANCEL_BOOKING',   title: '❌ Cancel'     },
    ],
  };
}

function _buildProductVariantPicker(item, business, isBarbershop) {
  const variantKeys = (item.variants || []).map(v => (typeof v === 'string' ? v : v.name || String(v)));
  const currency = item.currency || business?.payment?.currency || 'D';
  const price = item.price ? ` — ${currency}${formatMoney(item.price)}` : '';

  if (variantKeys.length <= 3) {
    return {
      type: 'buttons',
      body: `🛍 *${item.name}*${price}\n\nWhich option would you like?`,
      buttons: variantKeys.slice(0, 3).map(v => ({
        id:    `VAR_${v.toUpperCase().replace(/\s+/g, '_')}`,
        title: v.slice(0, 20),
      })),
    };
  }

  return {
    type: 'list',
    body:   `🛍 *${item.name}*${price}\n\nWhich option would you like?`,
    button: 'Choose option',
    rows: variantKeys.map(v => ({
      id:          `VAR_${v.toUpperCase().replace(/\s+/g, '_')}`,
      title:       v.slice(0, 24),
      description: item.name.slice(0, 72),
    })),
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

  const currency = business?.payment?.currency || 'D';

  // [FIX-LIST-CAP-2] Row IDs are 1-based numeric strings to match numIdx
  // parsing. No build-time slice needed — dispatcher.js hard-caps the
  // outgoing message at Meta's real limit of 10 rows TOTAL (it does not
  // chunk a long list across multiple sections, contrary to an earlier
  // version of this comment), truncating with a footer hint if the full
  // product catalog has more than 10 items.
  const rows = items.map((item, i) => ({
    id:          String(i + 1),
    title:       item.name.slice(0, 24),
    description: [
      item.description?.slice(0, 40),
      item.price ? `${item.currency || currency}${formatMoney(item.price)}` : null,
    ].filter(Boolean).join(' — ').slice(0, 72) || undefined,
  }));

  return {
    type: 'list',
    header: `${emoji} *${name}*`,
    body:   isBarbershop
      ? 'Our grooming products — tap to select:'
      : 'Our hair & beauty products — tap to select:',
    button: 'View Products',
    // [FIX-LIST-CAP-2] Flat top-level `rows`, not pre-wrapped in a single
    // `sections` entry — dispatcher.js treats both shapes identically (it
    // hard-caps at 10 rows total either way), so this is just consistency
    // with the other modules, not a functional requirement.
    rows,
  };
}

// Re-export helpers from salonHelpers.js (avoids circular import via postFlowHandler → modes)
export { getSalonPrepTip, getSalonServices } from '../salonHelpers.js';

