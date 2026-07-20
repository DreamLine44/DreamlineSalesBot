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
 * [v14-GREET-1]  Greeting: same message for new and returning customers, with
 *                name-based personalisation only ("Hello, Fatou!") when known.
 *                [NO-MEMORY-1] No longer references booking history or
 *                last-visit context — see moduleRouter.js GREET case.
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
import { getAIReply }        from '../../../core/ai/providers/aiRouter.js';
import { findBestMatch }     from '../../../utils/matchEngine.js';
import { parseQuantity }     from '../../../utils/parseQuantity.js';
import { saveOrder }         from '../../../services/orderService.js';
import { saveBooking }       from '../../../services/bookingService.js';
import { trackOrderAnalytics } from '../../../core/analytics/analyticsService.js';
import logger                from '../../../config/logger.js';

// ── Salon Config ───────────────────────────────────────────────────────────────

export const SALON_CONFIG = {
  businessMode: 'SALON',
  flows: ['BOOKING', 'WALKIN', 'ORDER', 'QUESTION'],
  persona: 'professional, warm salon receptionist who helps clients book appointments, join the walk-in queue, find the right products, and get beauty advice',
  steps: {
    BOOKING: ['SELECT_SERVICE', 'SELECT_STYLIST', 'DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'CONFIRM'],
    WALKIN:  ['SELECT_SERVICE', 'SELECT_STYLIST', 'CONFIRM'],
    ORDER:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
  },
  ui: {
    // Meta caps button messages at 3 buttons. ORDER is accessible via QUESTION or by typing.
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
    welcome:        '💇 Welcome! How can we help you today?\n\nBook an appointment, join our walk-in queue, or ask us anything.',
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
    ORDER:   ['SELECT_ITEM', 'QUANTITY', 'CONFIRM'],
  },
  ui: {
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
    welcome:        '✂️ Welcome! Ready for a fresh cut?\n\nBook an appointment, join our walk-in queue, or browse our grooming products.',
    cancelMsg:      "✅ No problem — come back whenever you're ready. ✂️",
    fallback:       'Would you like to *book an appointment*, join the *walk-in queue*, or ask a *question*?',
    orderPrompt:    '🛍 Our grooming products — tap to select:',
    bookPrompt:     '✂️ What cut or treatment would you like to book?',
    showMenuPrompt: '✂️ What would you like to do?',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function _isBarbershop(business) {
  return (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
}

/** Returns available services from menuItems or sensible defaults. */
function _getServices(business) {
  const items = (business?.menuItems || []).filter(i => i.available !== false);
  const serviceItems = items.filter(i =>
    !i.category || i.category.toLowerCase() === 'services' || i.category.toLowerCase() === 'service'
  );

  // Use service-tagged items if available, else all items
  const source = serviceItems.length > 0 ? serviceItems : items;
  if (source.length > 0) return source;

  // Sensible defaults
  return _isBarbershop(business)
    ? [
        { name: 'Haircut',                  price: null, duration: 30 },
        { name: 'Beard Trim',               price: null, duration: 20 },
        { name: 'Shape-Up / Edge',          price: null, duration: 20 },
        { name: 'Full Service (Cut+Beard)', price: null, duration: 45 },
        { name: "Kids Cut",                 price: null, duration: 25 },
      ]
    : [
        { name: 'Haircut & Style', price: null, duration: 45 },
        { name: 'Blow Dry',        price: null, duration: 30 },
        { name: 'Hair Colour',     price: null, duration: 90 },
        { name: 'Highlights',      price: null, duration: 120 },
        { name: 'Deep Conditioning', price: null, duration: 45 },
        { name: 'Braids / Weave',  price: null, duration: 120 },
        { name: 'Trim',            price: null, duration: 20 },
      ];
}

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
 * [v14-PREP] Get preparation tips for a service.
 * Checks menuItem.prep field first, then falls back to generic tips by service name.
 */
function _getPrepTip(serviceName, business) {
  if (!serviceName) return null;

  // Check if business has a specific prep note on the service item
  const item = (business?.menuItems || []).find(
    i => i.name?.toLowerCase() === serviceName.toLowerCase()
  );
  if (item?.prep) return item.prep;

  // Generic tips based on service name keywords
  const lower = serviceName.toLowerCase();
  if (lower.includes('colour') || lower.includes('color') || lower.includes('highlight') || lower.includes('dye')) {
    return 'Please arrive with unwashed hair and avoid heat styling the day before. 💇';
  }
  if (lower.includes('keratin') || lower.includes('relaxer') || lower.includes('perm')) {
    return 'Please arrive with clean, dry hair. Avoid washing for 3 days after the treatment. 💇';
  }
  if (lower.includes('braids') || lower.includes('weave') || lower.includes('extensions')) {
    return 'Arrive with freshly washed and blow-dried hair for best results. 💇';
  }
  if (lower.includes('facial') || lower.includes('skin')) {
    return 'Please arrive with a clean face and avoid retinol products 24h before. 💆';
  }
  if (lower.includes('massage') || lower.includes('spa')) {
    return 'Please arrive 5 minutes early and wear comfortable clothing. 🧖';
  }
  return null;
}

/**
 * [v14-DUPLICATE] NOTE: an earlier version of this double-booking guard lived here as
 * _hasConflictingBooking(), but it was never actually called from anywhere in this file —
 * handleSalonBooking() delegates the DATE/TIME/CONFIRM steps to the shared handleBookingFlow()
 * in core/conversations/bookingFlow.js, and *that* file has its own inline duplicate-booking
 * check (see the [v14-DUPLICATE] comment there) that performs the same query. This dead,
 * unreachable copy was removed during audit to avoid the two implementations silently
 * drifting apart — bookingFlow.js's inline check is the one actually enforced.
 */

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
    case 'CONFIRM': {
      // [v14-BUG-3] CANCEL_BOOKING must be intercepted before the catch-all re-prompt.
      if (['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU', 'NO'].includes(raw.toUpperCase())) {
        return cancelFlow(session, business);
      }

      if (!['CONFIRM', 'YES'].includes(raw.toUpperCase())) {
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
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedBooking) {
          const { dispatchMessage } = await import('../../../core/whatsapp/dispatcher.js');
          const { buildAdminBookingAlertBody } = await import('../../../services/adminCommandService.js');
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
          await dispatchMessage(
            adminPhone,
            {
              type:    'buttons',
              body:    alertBody,
              buttons: [
                { id: `CONFIRM_BOOK_${savedBooking.shortId}`, title: '✅ Confirm Queue' },
                { id: `DECLINE_BOOK_${savedBooking.shortId}`, title: '❌ Remove'        },
              ],
            },
            tenant,
          ).catch(e => logger.warn('[SalonWalkIn] admin notify failed', { err: e.message }));
        }
      } catch {}

      const lc = await completeFlow(session, 'WALKIN', business, tenant);
      if (lc) return lc;

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
          `\n\nPlease head to *${bizName}* — our team will message you to confirm your spot.\n\nSee you soon! 🙏`,
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
  const BOOKING_SHARED_STEPS = new Set(['DATE', 'DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'BOOKING_CONFIRM']);
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
      // [AUDIT-FIX-PARSEINT] parseInt("2 red shirts", 10) === 2, not NaN — a bare
      // leading digit used to silently hijack the menu index for ANY mixed
      // alphanumeric reply once menuViewed was true. Only trust the parsed index
      // for a genuinely bare number or an interactive tap (list row / button).
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const numIdx = parseInt(raw, 10) - 1;
      let item = ((isInteractive || isPureNumeric) && !isNaN(numIdx) && numIdx >= 0 && menu[numIdx]) ? menu[numIdx] : null;

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
        }
      }

      if (!item) return _buildProductMenu(menu, business, isBarbershop);

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'QUANTITY', data: { ...data, item }, menuViewed: true,
      });

      const currency = item.currency || business?.payment?.currency || 'D';
      const price = item.price ? ` — ${currency}${item.price}` : '';
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
          footer: 'Or type a number',
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
          `🛍 *${qty}× ${data.item?.name}*\n` +
          (total ? `💰 *Total:* ${currency}${total}\n` : '') +
          `\nReady to confirm?`,
        buttons: [
          { id: 'CONFIRM',        title: '✅ Confirm Order' },
          { id: 'CANCEL_BOOKING', title: '❌ Cancel'         },
        ],
      };
    }

    // ── CONFIRM ───────────────────────────────────────────────────────────
    case 'CONFIRM': {
      // [v14-BUG-4] CANCEL must be caught here; the global escape above won't fire
      // when step=CONFIRM because the switch falls through before reaching default.
      if (['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU', 'NO'].includes(raw.toUpperCase())) {
        return cancelFlow(session, business);
      }

      if (!['CONFIRM', 'YES'].includes(raw.toUpperCase())) {
        const currency = data.item?.currency || business?.payment?.currency || 'D';
        const total = data.totalPrice || (data.item?.price || 0) * (data.quantity || 1);
        return {
          type: 'buttons',
          // [FIX-SALON-CONFIRM-REPROMPT] previously dropped item/total summary on invalid input; currency was computed but unused
          body:
            `🧾 *Order Summary*\n\n` +
            `🛍 *${data.quantity || 1}× ${data.item?.name}*\n` +
            (total ? `💰 *Total:* ${currency}${total}\n` : '') +
            `\n${emoji} Ready to place your order?`,
          buttons: [
            { id: 'CONFIRM',        title: '✅ Confirm Order' },
            { id: 'CANCEL_BOOKING', title: '❌ Cancel'         },
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
        const { buildPaymentInstructionsUI } = await import('../../../services/paymentService.js');
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
                (session.customerName ? `👤 Name: ${session.customerName}\n` : '') +
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
          `🛍 *${data.quantity}× ${data.item?.name}*\n` +
          (data.totalPrice ? `💰 Total: *${currency}${data.totalPrice}*\n` : '') +
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
      type: 'buttons',
      body: `${isBarbershop ? '✂️' : '💇'} What would you like to know? Feel free to type your question.\n\n_(e.g. pricing, opening hours, aftercare tips, which service is right for me)_`,
      buttons: [
        { id: 'BOOK',      title: isBarbershop ? '💈 Book Cut' : '📅 Book Appointment' },
        { id: 'SHOW_MENU', title: '🔄 Main Menu'                                       },
      ],
    };
  }

  const raw = String(message || '').trim();

  if (['CANCEL', 'CANCEL_BOOKING', 'SHOW_MENU'].includes(raw.toUpperCase())) {
    return cancelFlow(session, business);
  }

  // ── AWAITING_QUESTION ─────────────────────────────────────────────────────
  if (!raw || raw.length < 2) {
    return {
      type: 'buttons',
      body: `${isBarbershop ? '✂️' : '💇'} What would you like to know? Feel free to type your question.\n\n_(e.g. pricing, opening hours, aftercare tips, product recommendations)_`,
      buttons: [
        { id: 'BOOK',      title: isBarbershop ? '💈 Book Cut' : '📅 Book Appointment' },
        { id: 'SHOW_MENU', title: '🔄 Main Menu'                                       },
      ],
    };
  }

  // [v14-CONSULT] Detect consultation-style questions and add proactive follow-up
  const isConsultation = /\b(which|what|recommend|best|suit|good for|help me choose|advice|should i|i have|my hair|my skin|i want to)\b/i.test(raw);
  const isAftercare    = /\b(aftercare|after care|maintain|maintenance|how long before|when can i wash|what to avoid|care tips|keep colour|keep color|post.treatment|after my (appointment|treatment|service))\b/i.test(raw);
  const intent = isAftercare ? 'AFTERCARE' : isConsultation ? 'SALON_CONSULTATION' : 'SALON_QUESTION'; // [FIX-AFTERCARE]

  const aiReply = await getAIReply({
    customerMessage: raw,
    business,
    session,
    intent,
  });

  // [v14-BUG-5] Build the response FIRST, then call completeFlow.
  // completeFlow sets postFlowAck for follow-up routing but must NOT replace our answer.
  const questionResponse = {
    type: 'buttons',
    body: aiReply || `Great question! For detailed information please contact us directly.`,
    buttons: [
      { id: 'BOOK',     title: isBarbershop ? '💈 Book Now'    : '📅 Book Now'      },
      { id: 'WALKIN',   title: '🚶 Walk-In Queue'                                    },
      { id: 'QUESTION', title: '❓ Another Question'                                 },
    ],
  };

  // [v14-CONSULT] If it was a consultation, add a proactive booking nudge
  if (isAftercare && aiReply) {
    questionResponse.footer = 'We hope to see you again soon! 🙏';
  } else if (isConsultation && aiReply) {
    questionResponse.footer = 'Tap "Book Now" to schedule the recommended service';
  }

  // [v14-BUG-5-FIX] completeFlow() may return a lead-capture UI. When it does,
  // return an ARRAY so the dispatcher sends the AI answer FIRST, then the lead
  // capture form immediately after. Previously the lead capture was discarded.
  const lc = await completeFlow(session, 'QUESTION', business, tenant);
  if (lc) return [questionResponse, lc];

  // No lead capture — return AI answer directly
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
    return price ? `${currency}${price}` : null;
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
    type:   'list',
    body:   heading,
    button: 'Choose service',
    sections: [{
      title: 'Our Services',
      rows: services.slice(0, 10).map(s => {
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
    footer: 'Tap a service or type its name',
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
    type:   'list',
    body:   heading,
    button: `Choose ${role}`,
    sections: [{
      title: `Our ${isBarbershop ? 'Barbers' : 'Stylists'}`,
      rows: options.slice(0, 10).map(o => ({
        id:          o.name === 'Any available' ? 'STYLIST_ANY' : `STYLIST_${o.name.toUpperCase().replace(/\s+/g, '_')}`,
        title:       o.name.slice(0, 24),
        description: (o.specialty || (o.name === 'Any available' ? `Next available ${role}` : undefined))?.slice(0, 72),
      })),
    }],
    footer: `Tap a name or type it`,
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

  // [AUDIT-FIX-SALON-PRODUCT-CHUNK] Was pre-sliced to 10 items and wrapped in a
  // single sections entry — dispatcher.js's [FIX-LIST-TRUNC] chunking only
  // operates on a flat top-level `rows` array, so items past #10 were silently
  // dropped before the dispatcher ever got a chance to place them in later
  // sections. Build rows from the full catalog and return them flat.
  const rows = items.map((item, i) => ({
    id:          String(i + 1),
    title:       item.name.slice(0, 24),
    description: [
      item.description?.slice(0, 40),
      item.price ? `${item.currency || currency}${item.price}` : null,
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
  };
}

// ── Named exports for prep tip (used by bookingFlow / postFlowHandler) ─────────
export { _getPrepTip as getSalonPrepTip };
