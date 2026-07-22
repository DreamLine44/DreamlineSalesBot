/**
 * core/conversations/moduleRouter.js
 *
 * Routes a detected intent to the correct business module handler.
 *
 * [FIX-BUG1]  cfg.labels → cfg.messages — ALL module configs export .messages,
 *             not .labels. Using .labels returned undefined everywhere, causing
 *             blank bot responses on GREET / SHOW_MENU / FALLBACK / CLARIFY.
 * [FIX-BUG8]  SUPPORT sets humanModeNotified=true so a 2nd message from the same
 *             customer doesn't trigger a duplicate admin escalation alert.
 * [FIX-BUG10] DONE action returns mode-appropriate welcome buttons, not a dead-end.
 * [FIX-BUG12] TRACK_ORDER returns follow-up buttons (New Order, Start Over).
 * [FIX-RTR-1] SUPPORT action: shouldNotifyAdmin guard now evaluated BEFORE the
 *             updateSession call so it reads the true pre-transition state of
 *             humanModeNotified, eliminating a race condition on the stale local
 *             session object.
 * [FIX-RTR-2] SUPPORT action: warns when tenant is missing so silent alert
 *             failures surface in logs.
 * [FIX-RTR-5] QUOTE_FOLLOW case now delegates to ACTION_REGISTRY first. The previous
 *             hardcoded startFlow({ flowName: 'ENQUIRY' }) always ran before the registry
 *             lookup, shadowing the SERVICES-mode QUOTE_FOLLOW handler registered by
 *             moduleRegistry. SERVICES tenants never reached their dedicated quote-follow
 *             flow — they always landed in the generic ENQUIRY path instead.
 * [FIX-RTR-6] ABOUT case now delegates to ACTION_REGISTRY first. Same shadowing pattern:
 *             the inline ABOUT response ran before the registry lookup, so GENERAL mode's
 *             handleAbout flow (registered in moduleRegistry) was never reachable.
 * [FIX-RTR-4] SUPPORT action: admin alert dispatch failure is now logged instead of
 *             silently swallowed. Previously .catch(()=>{}) meant a failed WhatsApp
 *             send to the admin produced no log entry and no indication the escalation
 *             was lost. Consistent with adminCommandService dispatch failure logging.
 * [FIX-X2]   getModeConfig moved to a static top-level import. Previously it was
 *             dynamically imported inside every case branch that needed it (GREET,
 *             SHOW_MENU, TRACK_ORDER, FALLBACK/CLARIFY, DONE, unknown-action fallback)
 *             — 6 separate `await import` expressions on hot paths. modes.js is pure
 *             config with no circular dependencies so there is no reason for lazy loading.
 */

import { startFlow, cancelFlow } from './flowEngine.js';
import { updateSession }         from '../sessions/sessionService.js';
import { dispatchText, dispatchMessage }          from '../whatsapp/dispatcher.js';
import { getModeConfig }         from '../../config/modes.js';
import { withCatalogWelcomeOption } from '../../modules/catalog/waCatalogConfig.js';
import logger from '../../config/logger.js';

const ACTION_REGISTRY = new Map();

export function registerAction(action, handler) {
  ACTION_REGISTRY.set(action.toUpperCase(), handler);
}

/**
 * buildWelcomeSequence(business, cfg)
 * [NAV-META3] Meta-compliant main-navigation upgrade.
 *
 * Single source of truth for the two-step welcome experience: a plain text
 * greeting sent first, followed by a separate interactive reply-button
 * message (max 3 buttons — dispatcher.js already hard-caps at 3, and every
 * module's welcomeButtons config already fits within that limit).
 *
 * Previously GREET returned one 'buttons' message with the branded welcome
 * copy embedded directly in the interactive body. Splitting it into two
 * messages reads as a more natural conversational greeting and gives the
 * text message room to stand on its own. Both GREET (fresh conversation)
 * and the new MAIN_MENU action (explicit "🏠 Main Menu" tap from the More
 * submenu) render this exact sequence — reused here rather than duplicated.
 *
 * Returns an array of two UI payloads; callers dispatch each in order
 * (webhookController.js's top-level route() call site already dispatches
 * array replies sequentially — see [FIX-IMG-URL] in restaurant/flows/orderFlow.js
 * for the same established pattern).
 */
export function buildWelcomeSequence(business, cfg) {
  const customWelcome = business?.customMessages?.welcomeMessage;
  const greeting = customWelcome || cfg.messages?.welcome || '👋 Welcome! How can I help you today?';
  const promptBody = cfg.messages?.chooseOptionPrompt || 'Choose an option below to get started.';

  // [AUDIT-FIX-CATALOG-WELCOME] waCatalogConfig.js's shouldShowCatalogButton() /
  // withCatalogWelcomeOption() were fully implemented (see [CATALOG-UX-BUTTON])
  // but nothing in production code ever actually called withCatalogWelcomeOption
  // — the exact same "implemented but unwired" bug class NAV-META3 already fixed
  // once for the BROWSE_CATALOG BUTTON_ID_MAP entry. A tenant on any mode other
  // than RESTAURANT could enable WA Catalog, configure a catalogId, and have
  // sellable products, and STILL never see a "🛍 Browse Catalog" option anywhere
  // — MANUAL_ONLY mode in particular can never fire for them at all, since its
  // only trigger is this exact button.
  //
  // [LIST-NAV-1] Single Interactive List navigation — supersedes the 3-button
  // + "⋯ More" submenu (NAV-META3) for any mode config that opts in via
  // cfg.ui.welcomeList. One "Choose an option ▼" list button opens all
  // primary options with descriptions in a single tap, instead of splitting
  // them across a primary screen + a secondary "More" screen.
  //
  // Deliberately checked FIRST and returns early: this is purely additive.
  // Row ids in welcomeList (ORDER/BOOK/BROWSE_CATALOG/QUESTION, etc.) are the
  // SAME ids the existing buttons already used — BUTTON_ID_MAP,
  // ACTION_REGISTRY, and every downstream flow/case (case 'BROWSE_CATALOG',
  // ACTION_REGISTRY 'QUESTION'/'START_ORDER'/'START_BOOKING') are reused
  // completely unchanged; only the outbound message SHAPE changes here, not
  // routing, business logic, state, or any handler. Modes that don't define
  // cfg.ui.welcomeList (every module except restaurant, for now) fall straight
  // through to the moreMenuButtons/withCatalogWelcomeOption logic below,
  // completely untouched.
  if (cfg.ui?.welcomeList) {
    return [
      { type: 'text', body: greeting },
      {
        type:   'list',
        body:   promptBody,
        button: cfg.ui.welcomeList.button || 'Choose an option',
        rows:   cfg.ui.welcomeList.rows || [],
      },
    ];
  }

  // RESTAURANT is left untouched here: it already surfaces Browse Catalog via
  // its own static moreMenuButtons submenu (see modules/restaurant/configs/index.js
  // and moduleRouter.js case 'MORE_MENU'/'BROWSE_CATALOG'). Merging it into the
  // primary welcomeButtons there too would push its intentional 3-button
  // Order/Book/⋯More set to 4, which withCatalogWelcomeOption would then have to
  // silently flip into a 'list' message — duplicating access to the same feature
  // and breaking the deliberate NAV-META3 button layout for no benefit.
  let buttonsMessage;
  if (cfg.ui?.moreMenuButtons) {
    buttonsMessage = {
      type:    'buttons',
      body:    promptBody,
      buttons: cfg.ui?.welcomeButtons || [],
    };
  } else {
    const merged = withCatalogWelcomeOption(cfg.ui?.welcomeButtons || [], business);
    buttonsMessage = merged.rows
      ? { type: 'list', body: promptBody, button: 'Choose option', rows: merged.rows }
      : { type: 'buttons', body: promptBody, buttons: merged.buttons };
  }

  return [
    { type: 'text', body: greeting },
    buttonsMessage,
  ];
}

export async function route({ action, intent, session, message, business, tenant, isInteractive, suggestion }) {
  const upper = (action || 'FALLBACK').toUpperCase();
  const mode  = (business?.businessMode || 'RETAIL').toUpperCase();

  logger.debug('[Router] Routing', { action: upper, mode, step: session?.step });

  switch (upper) {

    case 'ACKNOWLEDGE': {
      // [SPEC-PART7] Filler/reaction message with no active flow and no postFlowAck context.
      // Check for an active order first — if one exists, show order context.
      // [FIX-ACK-THROTTLE] If we already sent an order-status acknowledgement recently
      // (within 5 minutes), do NOT repeat the same text — it creates a loop where every
      // reaction emoji or acknowledgement word (Ahh, Ok) spams the same status message.
      // Instead show a soft "what would you like to do?" with contextual buttons.
      try {
        const { default: _AckOrder } = await import('../../models/Order.js');
        const ackOrder = await _AckOrder.findOne({
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          status:        { $in: ['confirmed', 'pending', 'ready'] },
          paymentStatus: { $nin: ['cancelled', 'rejected'] },
        }).select('item quantity shortId status').sort({ createdAt: -1 }).lean().catch(() => null);

        if (ackOrder) {
          // Throttle: only send the status text once per 5-minute window.
          // After the first status reply, subsequent acknowledgements show buttons instead.
          const lastAckSent = session.lastOrderStatusAckAt ? new Date(session.lastOrderStatusAckAt) : null;
          const throttleMs  = 5 * 60 * 1000; // 5 minutes
          const throttled   = lastAckSent && (Date.now() - lastAckSent.getTime()) < throttleMs;

          if (!throttled) {
            // First time (or throttle window expired) — send status text and record timestamp
            await updateSession(session.customerPhone, session.tenantId, {
              lastOrderStatusAckAt: new Date().toISOString(),
            }).catch(() => {});

            const statusLine = {
              confirmed: `🍳 Being prepared`,
              pending:   `⏳ Awaiting confirmation`,
              ready:     `🍽️ Ready for collection!`,
            }[ackOrder.status] || `⏳ Being processed`;
            return {
              type: 'text',
              body: `😊 ${statusLine} — we'll let you know when there's an update on *#${ackOrder.shortId}*!`,
            };
          } else {
            // Throttled — show a quiet contextual menu with order actions
            // [FIX-ACK-THROTTLE-2] Use mode-appropriate welcome buttons so the throttled
            // menu matches the business mode (e.g. Book a Table for restaurants, Browse
            // Products for retail) rather than hardcoded QUESTION/CANCEL which may not
            // be relevant. Always append CANCEL as a contextual action since the customer
            // has an active order.
            const cfgAck = getModeConfig(business);
            // [FIX-ACK-THROTTLE-2-COMPLETE] cfgAck was computed but never applied — the buttons
            // stayed hardcoded to QUESTION/CANCEL, contradicting the comment above. Now uses the
            // mode's welcome buttons (e.g. "Book a Table" / "Browse Products") plus CANCEL.
            const modeButtons = (cfgAck.ui?.welcomeButtons || []).filter(b => b.id !== 'CANCEL');
            const throttledBtns = [
              ...(modeButtons.length ? modeButtons.slice(0, 2) : [{ id: 'QUESTION', title: '❓ Ask a Question' }]),
              { id: 'CANCEL', title: '❌ Cancel Order' },
            ];
            return {
              type:    'buttons',
              body:    `😊 Your order *#${ackOrder.shortId}* is still being processed. What would you like to do?`,
              buttons: throttledBtns,
            };
          }
        }
      } catch { /* non-fatal */ }

      // No active order — soft welcome menu, no branded greeting
      const cfg = getModeConfig(business);
      return {
        type:    'buttons',
        body:    '😊 What would you like to do?',
        buttons: cfg.ui?.welcomeButtons || [],
      };
    }

    case 'CONTINUE_FLOW': {
      // CONTINUE_FLOW arrives when the customer sends a numeric, single-char, or unmapped
      // interactive message while there is NO active flow (the flow engine handles it when
      // a flow IS active, before reaching detectIntent). Without this case the router falls
      // through to the unknown-action logger and returns the generic fallback, which is
      // jarring for a customer who typed "5" from the main menu. Show the welcome menu instead.
      const cfg = getModeConfig(business);
      return {
        type:    'buttons',
        body:    business?.customMessages?.welcomeMessage || cfg.messages?.welcome || '👋 How can I help you today?',
        buttons: cfg.ui?.welcomeButtons || [],
      };
    }

    case 'GREET': {
      // ── [SPEC-RULE-1] GREETING GATE — runs on EVERY message, not just first ──────
      // Before sending any greeting, check for active order or booking context.
      // An active order → show order status, skip all greetings entirely.
      // An active booking → show booking status, skip greeting.
      // Neither → proceed to normal welcome.
      //
      // This is the fix for the production bug where "Ahhh" from a paying customer
      // triggered "Hello! Welcome to DreamLine Restaurant" — because GREET ran with
      // no awareness that the customer had just paid for an order.
      try {
        const { default: _Order }   = await import('../../models/Order.js');
        const { default: _Booking } = await import('../../models/Booking.js');

        const activeOrder = await _Order.findOne({
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          status:        { $in: ['confirmed', 'pending'] },
          paymentStatus: { $nin: ['cancelled', 'rejected'] },
        }).select('item quantity shortId paymentStatus status').sort({ createdAt: -1 }).lean().catch(() => null);

        if (activeOrder) {
          const statusLine = {
            confirmed:      `🍳 Being prepared`,
            pending:        `⏳ Awaiting confirmation`,
          }[activeOrder.status] || `⏳ Being processed`;
          return {
            type:    'buttons',
            body:
              `Hi there 😊\n\n` +
              `Your order *#${activeOrder.shortId}* — *${activeOrder.item}* × ${activeOrder.quantity} — is still being processed.\n\n` +
              `${statusLine}. We'll message you the moment it's ready!`,
            buttons: [
              { id: 'QUESTION', title: '❓ Ask a Question' },
              { id: 'CANCEL',   title: '❌ Cancel Order'   },
            ],
          };
        }

        const activeBooking = await _Booking.findOne({
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          status:        { $in: ['pending', 'confirmed'] },
        }).select('shortId date time partySize status service staff bookingType').sort({ createdAt: -1 }).lean().catch(() => null);

        if (activeBooking) {
          const greetMode       = (business?.businessMode || '').toUpperCase();
          const isSalonGreet    = greetMode === 'SALON' || greetMode === 'BARBERSHOP';
          const isWalkInGreet   = activeBooking.bookingType === 'walkin';

          const statusLine = activeBooking.status === 'confirmed'
            ? `✅ Confirmed`
            : `⏳ Awaiting confirmation`;

          let bookingBody;

          if (isSalonGreet) {
            // [FIX-SALON-13] Salon/barbershop: show service + stylist instead of partySize.
            // "You have a table booking for ? guests" was nonsensical for hair appointments.
            const serviceGreetStr = activeBooking.service ? `*${activeBooking.service}*` : 'your appointment';
            const staffGreetStr   = activeBooking.staff   ? ` with *${activeBooking.staff}*` : '';
            const staffLabel      = greetMode === 'BARBERSHOP' ? 'barber' : 'stylist';

            if (isWalkInGreet) {
              bookingBody =
                `Hi there 😊\n\n` +
                `You're in the walk-in queue for ${serviceGreetStr}${staffGreetStr}.\n\n` +
                `Status: ${statusLine}. We'll message you when ready!`;
            } else {
              const whenStrSalon = activeBooking.date
                ? ` on *${activeBooking.date}${activeBooking.time ? ` at ${activeBooking.time}` : ''}*`
                : '';
              bookingBody =
                `Hi there 😊\n\n` +
                `You have an appointment for ${serviceGreetStr}${staffGreetStr}${whenStrSalon}.\n\n` +
                `Status: ${statusLine}. If anything changes, just let us know!`;
            }
          } else {
            // Restaurant / all other modes: show party size + date/time
            const whenStr = activeBooking.date
              ? ` on *${activeBooking.date}${activeBooking.time ? ` at ${activeBooking.time}` : ''}*`
              : '';
            bookingBody =
              `Hi there 😊\n\n` +
              `You have a table booking${whenStr} for *${activeBooking.partySize || '?'} guests*.\n\n` +
              `Status: ${statusLine}. If anything changes, just let us know!`;
          }

          // [FIX-SALON-13] Salon/barbershop: include RESCHEDULE alongside CANCEL_BOOKING.
          // Showing Reschedule instead of just Cancel improves retention (customer has a choice).
          // Walk-in customers get BOOK NEXT TIME instead of RESCHEDULE (no appointment to reschedule).
          // Non-salon modes (restaurant) only show QUESTION + CANCEL_BOOKING.
          const greetBookingBtns = isSalonGreet
            ? isWalkInGreet
              ? [
                  { id: 'QUESTION',       title: '❓ Ask a Question'  },
                  { id: 'BOOK',           title: '📅 Book Next Time'  },
                  { id: 'CANCEL_BOOKING', title: '❌ Leave Queue'      },
                ]
              : [
                  { id: 'QUESTION',       title: '❓ Ask a Question'   },
                  { id: 'RESCHEDULE',     title: '📅 Reschedule'       },
                  { id: 'CANCEL_BOOKING', title: '❌ Cancel Booking'    },
                ]
            : [
                { id: 'QUESTION',       title: '❓ Ask a Question'  },
                { id: 'CANCEL_BOOKING', title: '❌ Cancel Booking'  },
              ];

          return {
            type:    'buttons',
            body:    bookingBody,
            buttons: greetBookingBtns,
          };
        }
      } catch (_gateErr) {
        // Non-fatal — greeting gate failure falls through to normal welcome
        logger.debug('[Router] Greeting gate check failed (non-fatal)', { err: _gateErr.message });
      }
      // ── No active order/booking — proceed to normal welcome ──────────────
      //
      // ╔═══════════════════════════════════════════════════════════════════╗
      // ║ [NO-MEMORY-1] — PERMANENT PROJECT RULE — DO NOT REVERT            ║
      // ║                                                                     ║
      // ║ The GREET welcome message must NEVER reference the customer's      ║
      // ║ order/booking history (no "last time you ordered X", no "shall we  ║
      // ║ do that again", no favourite-item nudges) and must NOT use the     ║
      // ║ customer's name, for now. This applies regardless of what other    ║
      // ║ branches this file gets merged from — a merge that brings back a   ║
      // ║ memory-based/personalised greeting (e.g. via customerMemory.js /   ║
      // ║ getCustomerContext / generateGreeting) violates this rule and must ║
      // ║ be stripped back out, not treated as a legitimate feature to keep. ║
      // ║ Any AI or developer editing this file, at any time, must preserve  ║
      // ║ this rule. If genuinely unsure whether a change here re-introduces ║
      // ║ memory-based greeting content, ask before merging it in.           ║
      // ╚═══════════════════════════════════════════════════════════════════╝
      //
      // Greeting is intentionally the same generic branded welcome for every
      // customer, new or returning — no DB lookups, no name, no history.
      const cfg = getModeConfig(business);

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow:  null, step: null, data: {},
        postFlowAck:  null, menuViewed: false, upsellSent: false,
      });

      // [NAV-META3] Two-step welcome: greeting text first, interactive menu
      // second — see buildWelcomeSequence() above.
      return buildWelcomeSequence(business, cfg);
    }

    // [AUDIT-FIX-VIEWMENU] VIEW_MENU is distinct from SHOW_MENU (see patterns.js).
    // Previously "View Menu" buttons/typed phrases were mapped to the SHOW_MENU
    // action below, which only resets the session and re-shows the generic
    // welcome buttons — never the actual menu. Routing through startFlow('ORDER')
    // reuses each module's existing ORDER-flow INIT step (message === null),
    // which already builds and returns the real menu/product list for that
    // business (restaurant, delivery, retail, bakery, etc.) — no per-module
    // menu-rendering duplication needed here.
    case 'VIEW_MENU':
      return startFlow({ flowName: 'ORDER', session, business, tenant });

    case 'SHOW_MENU': {
      const cfg = getModeConfig(business);
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, data: {}, postFlowAck: null, postFlowData: null,
      });
      // [FIX] SHOW_MENU ≠ GREET. When a customer taps "Start Over" mid-session
      // they should NOT see the full welcome greeting (business description, etc.)
      // again — that's jarring and feels like the bot forgot the conversation.
      // SHOW_MENU shows a short "what else can I help with?" prompt + action buttons.
      // GREET (first message / fresh start) shows the full branded welcome.
      return {
        type:    'buttons',
        body:    cfg.messages?.showMenuPrompt || '👇 What would you like to do?',
        buttons: cfg.ui?.welcomeButtons || [],
      };
    }

    // [NAV-META3] Secondary "⋯ More" screen — reached from the primary welcome
    // menu when a mode's welcomeButtons config includes a MORE_MENU button
    // (currently RESTAURANT only; see modules/restaurant/configs/index.js).
    // Keeps the primary welcome menu at exactly 3 buttons (Meta's hard limit)
    // while still surfacing catalog browsing, Q&A, and a way back to the
    // welcome screen without any of them competing for one of the 3 primary
    // slots.
    case 'MORE_MENU': {
      const cfg = getModeConfig(business);
      return {
        type:    'buttons',
        body:    cfg.messages?.moreMenuPrompt || 'What else would you like to do?',
        buttons: cfg.ui?.moreMenuButtons || [
          { id: 'QUESTION',  title: '❓ Ask a Question' },
          { id: 'MAIN_MENU', title: '🏠 Main Menu'      },
        ],
      };
    }

    // [NAV-META3] "🏠 Main Menu" — always returns to the full two-step welcome
    // experience (same sequence GREET sends on a fresh conversation), reusing
    // buildWelcomeSequence() rather than duplicating the welcome text/buttons
    // construction. Distinct from SHOW_MENU (the short "Start Over" reset
    // prompt used mid-session elsewhere) — this is an explicit customer request
    // to go "home", so the full branded greeting is appropriate here, not a
    // jarring re-send mid-flow.
    case 'MAIN_MENU': {
      const cfg = getModeConfig(business);
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, data: {}, postFlowAck: null, postFlowData: null,
      });
      return buildWelcomeSequence(business, cfg);
    }

    // [NAV-META3] [AUDIT-FIX] "🛍 Browse Catalog" — browseCatalogExplicit() and
    // its supporting config (waCatalogConfig.js shouldShowCatalogButton/
    // withCatalogWelcomeOption) were already fully implemented but had no
    // BUTTON_ID_MAP entry and no case here, so a tap on this button ID was
    // completely unreachable (detectIntent() fell back to CONTINUE_FLOW,
    // silently re-showing the welcome menu). Now wired to the existing
    // implementation — no new catalog logic added. browseCatalogExplicit()
    // already handles its own graceful fallback to the module's normal ORDER
    // flow when WA Catalog isn't configured/enabled for the tenant.
    case 'BROWSE_CATALOG': {
      const { browseCatalogExplicit } = await import('../../modules/catalog/waCatalogFlow.js');
      return browseCatalogExplicit({ session, business, tenant });
    }

    // [AUDIT-FLOWS-RESCHEDULE] The "📅 Reschedule" button (shown from GREET for a
    // customer with an active booking) previously aliased straight to START_BOOKING
    // via patterns.js's BUTTON_ID_MAP — that reset the session and started a brand
    // new booking WITHOUT ever cancelling the existing pending/confirmed appointment,
    // silently duplicating it. This mirrors postFlowHandler.js's existing RESCHEDULE
    // handling: cancel the most recent active, non-walk-in booking, then land the
    // customer on step 'DATE' with the previous service/stylist carried over.
    case 'RESCHEDULE': {
      let _previousBooking = null;
      try {
        const { default: _ReschBooking } = await import('../../models/Booking.js');
        _previousBooking = await _ReschBooking.findOneAndUpdate(
          {
            customerPhone: session.customerPhone,
            tenantId:      session.tenantId,
            status:        { $in: ['pending', 'confirmed'] },
            // Never touch a walk-in queue entry — only a real dated appointment.
            bookingType:   { $ne: 'walkin' },
          },
          {
            $set: {
              status:      'cancelled',
              cancelledBy: 'customer',
              cancelledAt: new Date(),
            },
          },
          { sort: { createdAt: -1 } }
        ).catch(() => null);
      } catch (_) { /* non-fatal */ }

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'BOOKING', step: 'DATE', postFlowAck: null,
        data: {
          service:         _previousBooking?.service || null,
          selectedService: _previousBooking?.service || null,
          stylist:         _previousBooking?.staff    || null,
        },
      });

      return {
        type: 'text',
        body: `📅 *Reschedule Appointment*\n\nNo problem! Let's find a new time${_previousBooking?.service ? ` for your *${_previousBooking.service}*` : ''}.\n\nWhat date works best for you?`,
      };
    }

    case 'CANCEL': {
      // [FIX-CANCEL-1] CANCEL_BOOKING button maps here via patterns.js BUTTON_ID_MAP.
      // cancelFlow() only clears the session — it never updates the Booking or Order
      // document in the DB. This meant:
      //   - Customer taps "❌ Cancel Booking" → session cleared, booking still 'pending'
      //   - Next message → activeOrderResolver/BOOKING_CONFIRMED ack shows booking AGAIN
      //   - Customer tap "❌ Cancel Order" → same issue for orders at non-flow states
      // Fix: before calling cancelFlow(), cancel any active Booking and/or pending Order
      // for this customer. Only cancel 'pending' bookings (not already confirmed ones
      // which the admin controls), and only 'pending'/'confirmed' orders that haven't
      // been paid and prepared yet.
      let _bookingCancelled = false;
      let _orderCancelled   = false;

      try {
        const { default: _CancelBooking } = await import('../../models/Booking.js');
        const _bookingResult = await _CancelBooking.findOneAndUpdate(
          {
            customerPhone: session.customerPhone,
            tenantId:      session.tenantId,
            status:        { $in: ['pending', 'confirmed'] },
          },
          {
            $set: {
              status:      'cancelled',
              cancelledBy: 'customer',
              cancelledAt: new Date(),
            },
          },
          { sort: { createdAt: -1 } }
        ).catch(() => null);
        _bookingCancelled = !!_bookingResult;
      } catch (_) { /* non-fatal */ }

      // [FIX-CANCEL-FALSE-POSITIVE] Both findOneAndUpdate results below were
      // previously discarded (.catch(() => {}) with no success check), and
      // cancelFlow() ran unconditionally afterwards — always replying "✅ No
      // problem!" regardless of whether anything was actually cancelled.
      // The Order query intentionally excludes paymentStatus 'confirmed'/'paid'
      // (protecting orders the customer has already paid for from accidental
      // self-cancellation), but a customer can still reach this case by TYPING
      // "cancel my order" / "cancel it" (patterns.js CANCEL_ORDER) even when
      // their order is already paid and in 'preparing'/'ready' status — no
      // CANCEL button is ever shown for those states, but typed cancel phrases
      // aren't gated by what buttons are visible. The result: the order stays
      // active in the kitchen while the customer is falsely told it was
      // cancelled. Track whether the write actually matched a document so we
      // can give an honest reply instead.
      let _uncancellableOrder = null;
      try {
        const { default: _CancelOrder } = await import('../../models/Order.js');
        const _orderResult = await _CancelOrder.findOneAndUpdate(
          {
            customerPhone: session.customerPhone,
            tenantId:      session.tenantId,
            // [AUDIT-FIX-CANCEL-CONFIRMED-GUARD] status:'confirmed' is the
            // authoritative "order accepted" signal in this codebase (see
            // activeOrderResolver's [AUDIT-AOR-CONFIRMED]) — dashboardController's
            // updateOrderStatus() and the cash-order AWAIT_ADMIN_CONFIRM path both
            // set status:'confirmed' WITHOUT ever touching paymentStatus, so relying
            // on paymentStatus alone let an already-accepted order slip through and
            // be self-cancelled by the customer. Only truly 'pending' orders — never
            // accepted by an admin — are self-cancellable here.
            status:        'pending',
            // [FIX-CANCEL-REJECTED] 'rejected' was previously in this $nin exclusion list,
            // meaning a customer whose payment was rejected — the EXACT scenario where
            // activeOrderResolver shows a "Payment Not Approved" card with a CANCEL button —
            // could never actually cancel that order via this query. cancelFlow() would still
            // reply "No problem!" (the DB write silently matched nothing), so the Order stayed
            // status:'pending'/paymentStatus:'rejected' forever and activeOrderResolver kept
            // re-intercepting every subsequent message with the same rejected-payment card.
            // A rejected payment is precisely the state that SHOULD be cancellable — only
            // already-confirmed/paid payments need protecting from accidental cancellation.
            paymentStatus: { $nin: ['cancelled', 'confirmed', 'paid'] },
          },
          {
            $set: {
              status:        'cancelled',
              paymentStatus: 'cancelled',
              cancelledAt:   new Date(),
              cancelledBy:   'customer',
            },
          },
          { sort: { createdAt: -1 } }
        ).catch(() => null);
        _orderCancelled = !!_orderResult;

        // [FIX-CANCEL-FALSE-POSITIVE] Nothing was cancelled above — check whether
        // there's an active order that simply couldn't be self-cancelled (already
        // paid/confirmed/preparing/ready) so we can tell the customer the truth
        // instead of a blanket "No problem!".
        if (!_orderCancelled) {
          _uncancellableOrder = await _CancelOrder.findOne({
            customerPhone: session.customerPhone,
            tenantId:      session.tenantId,
            status:        { $nin: ['cancelled', 'completed', 'rejected'] },
          }).sort({ createdAt: -1 }).select('shortId status paymentStatus').lean().catch(() => null);
        }
      } catch (_) { /* non-fatal */ }

      if (!_bookingCancelled && !_orderCancelled && _uncancellableOrder) {
        return {
          type: 'buttons',
          body:
            `⚠️ Order *#${_uncancellableOrder.shortId}* has already been confirmed and is being prepared, ` +
            `so it can't be self-cancelled at this stage.\n\n` +
            `Please contact us directly if you still need to cancel.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Contact Support' }],
        };
      }

      return cancelFlow(session, business);
    }

    case 'CANCEL_ALL': {
      // [FIX-CANCEL-ALL] Bulk-cancel all pending/confirmed orders for this customer.
      // Triggered when the customer types "cancel all", "cancel all of them", etc.
      // while in the MULTIPLE_ACTIVE_ORDERS context (or any time they want a clean slate).
      try {
        const { default: _CancelAllOrder } = await import('../../models/Order.js');
        const cancelResult = await _CancelAllOrder.updateMany(
          {
            customerPhone: session.customerPhone,
            tenantId:      session.tenantId,
            // [AUDIT-FIX-CANCEL-ALL-CONFIRMED-GUARD] Same guard as the single-order
            // CANCEL case above — status:'confirmed'/'preparing' orders are already
            // accepted by an admin and must not be bulk-cancellable by the customer.
            status:        'pending',
            // [FIX-CANCEL-REJECTED] Same fix as the single-order CANCEL case above —
            // 'rejected' must not be excluded, or rejected-payment orders can never be
            // bulk-cancelled either and keep re-appearing in the MULTIPLE_ACTIVE_ORDERS list.
            // [AUDIT-FIX-CANCEL-ALL-CONFIRMED-GUARD] 'confirmed'/'paid' added — the old
            // list only excluded 'cancelled'/'refunded', so an already-paid order could
            // still be bulk-cancelled with a single "cancel all".
            paymentStatus: { $nin: ['cancelled', 'refunded', 'confirmed', 'paid'] },
          },
          {
            $set: {
              status:        'cancelled',
              paymentStatus: 'cancelled',
              cancelledAt:   new Date(),
              cancelledBy:   'customer',
            },
          }
        );
        const count = cancelResult.modifiedCount || 0;
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {}, postFlowAck: null,
        });
        const cfgCancelAll = getModeConfig(business);
        return {
          type:    'buttons',
          body:    count > 0
            ? `✅ Done — *${count} order${count !== 1 ? 's' : ''}* ${count !== 1 ? 'have' : 'has'} been cancelled. Sorry to see you go! 🙏`
            : `ℹ️ No active orders found to cancel.`,
          buttons: cfgCancelAll.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
        };
      } catch (err) {
        logger.error('[Router] CANCEL_ALL failed', { err: err.message });
        const cfgCancelAllErr = getModeConfig(business);
        return {
          type:    'buttons',
          body:    '⚠️ Something went wrong cancelling your orders. Please contact support.',
          buttons: [{ id: 'SUPPORT', title: '💬 Contact Support' }],
        };
      }
    }

    case 'SUPPORT': {
      const adminPhone = business?.adminPhone || tenant?.adminPhone || null;

      // [FIX-RTR-2] Warn early when tenant is missing — without it the admin can
      // never be notified, so a silent failure here is hard to diagnose.
      if (!tenant) {
        logger.warn('[Router] SUPPORT action called without a tenantDoc — admin alert cannot be dispatched', {
          customerPhone: session.customerPhone,
        });
      }

      // [FIX-RTR-1] Evaluate the alert guard BEFORE the updateSession call.
      // Previously the check ran AFTER updateSession, reading the stale local
      // session object (humanModeNotified was already true in the DB but the local
      // variable still reflected the pre-update value). Evaluating first ensures
      // the condition is based on the actual pre-transition state and eliminates
      // the race window between the DB write and the guard check.
      const shouldNotifyAdmin = adminPhone && tenant && !session.humanModeNotified;

      // [FIX-BUG8] Set humanModeNotified=true so second message doesn't re-alert admin
      // [FIX-HM-5] humanMode TTL is now 24h (set in sessionService) so the session
      // won't expire and accidentally re-enable the bot between admin replies.
      await updateSession(session.customerPhone, session.tenantId, {
        humanMode: true, humanModeNotified: true, currentFlow: null, step: null,
      });

      if (shouldNotifyAdmin) {
        const nameStr = session.customerName ? ` (${session.customerName})` : '';
        const alert   =
          `🚨 *Support escalation*\n\n` +
          `Customer *${session.customerPhone}*${nameStr} needs help.\n` +
          `Message: "${message || '(no message)'}"\n\n` +
          `Bot is now *silent* for this customer.\n\n` +
          `Reply directly to them on WhatsApp, then tap the button below (or send \`RESUME BOT ${session.customerPhone}\` to your bot number) to re-enable the bot.`;
        // [FIX-RESUME-BTN] Send RESUME_BOT_ as an interactive button alongside the alert.
        // Previously the admin received plain text with a copy-paste command —
        // "type RESUME BOT <phone>". Most admins missed the instruction or typed it wrong.
        // The button (RESUME_BOT_<phone>) is handled by adminCommandService.handleAdminButtonReply
        // and the webhookController admin button guard (FIX-RESUME-BTN-GATE). One tap resumes
        // the bot; the text command is kept as a fallback for admins on desktop clients.
        const safePhone = session.customerPhone.replace(/[^0-9+]/g, '');
        const resumeBtnId = `RESUME_BOT_${safePhone}`;
        const alertPayload = {
          type:    'buttons',
          body:    alert,
          buttons: [{ id: resumeBtnId, title: '▶️ Resume Bot' }],
        };
        // [FIX-RTR-4] Log dispatch failures — if this silently fails the admin is
        // never notified of the escalation and there is no trace in logs to diagnose it.
        // Consistent with adminCommandService which logs all customer dispatch failures.
        dispatchMessage(adminPhone, alertPayload, tenant).catch(err =>
          logger.warn('[Router] SUPPORT: admin alert dispatch failed', {
            adminPhone, customerPhone: session.customerPhone, err: err.message,
          })
        );
      }

      // [FIX-HM-6] No "Start Over" button after support escalation.
      // Previously the customer could tap "Start Over" (SHOW_MENU) and in edge cases
      // (e.g. session TTL expiry) the bot would respond again. Now the message is
      // plain text with no buttons — customer must wait for the human to reply.
      const body = adminPhone
        ? `🆘 *Support Request*\n\nI've flagged this to our team.\n\n📞 You can also reach us directly at *${adminPhone}*\n\n_Please wait — a team member will reply to you shortly._`
        : `🆘 *Support Request*\n\nI've flagged this to our team. Someone will contact you shortly.\n\n_Please wait — a team member will reply to you shortly._`;

      return { type: 'text', body };
    }

    case 'TRACK_ORDER': {
      const handler = ACTION_REGISTRY.get('TRACK_ORDER');
      if (handler) return handler({ session, message, business, tenant });
      const phone = business?.adminPhone || null;
      const cfg = getModeConfig(business);
      const canOrder = cfg.flows?.includes('ORDER');
      // [FIX-BUG12] Return follow-up buttons
      return {
        type: 'buttons',
        body: `📦 *Order Tracking*\n\nFor live updates on your order, please contact us directly.` +
              (phone ? `\n\n📞 *${phone}*` : ''),
        buttons: [
          canOrder ? { id: 'ORDER', title: '🛍 New Order' } : null,
          { id: 'SHOW_MENU', title: '🔄 Start Over' },
        ].filter(Boolean),
      };
    }

    case 'REPEAT_ORDER': {
      const handler = ACTION_REGISTRY.get('REPEAT_ORDER');
      if (handler) return handler({ session, message, business, tenant });
      return startFlow({ flowName: 'ORDER', session, business, tenant });
    }

    case 'FALLBACK':
    case 'CLARIFY': {
      const { getAIReply } = await import('../ai/providers/aiRouter.js');
      const cfg = getModeConfig(business);

      // [FIX-FALLBACK-1] Off-topic gate: detect and reject messages that have
      // clearly nothing to do with this business before calling the AI.
      // The AI would otherwise respond to "what's the weather?", "who is the president",
      // random complaints about other businesses, etc. — making the bot seem unreliable.
      // Gate: if the message is very short gibberish OR matches an off-topic pattern,
      // show the main menu without an AI call.
      const cleanMsg = (message || '').toLowerCase().trim();
      const OFF_TOPIC_RE = /^(hi+|hey+|hello+|yo+|ok+|sure|test|ping|bye|haha+|lol+|hmm+|wow|yay|phew|aight|nah|meh)$/i;
      const GIBBERISH_RE = /^([a-z]{1,3})\1{2,}$/i;  // aaaa, hihihi, lolol
      const SPAM_RE = /^[^aeiou\s]{5,}$/i;             // consonant-only spam
      const isOffTopic = OFF_TOPIC_RE.test(cleanMsg) || GIBBERISH_RE.test(cleanMsg) || SPAM_RE.test(cleanMsg);

      if (isOffTopic) {
        return {
          type:    'buttons',
          body:    cfg.messages?.welcome || '👋 How can I help you today?',
          buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
        };
      }

      const aiText = await getAIReply({ customerMessage: message, business, session, intent });
      // [FIX-BUG1] cfg.messages.fallback not cfg.labels.fallback
      const fallbackMsg = business?.customMessages?.fallback || cfg.messages?.fallback;
      const body = aiText || fallbackMsg || 'How can I help you? 😊';

      return {
        type:    'buttons',
        body,
        buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }

    case 'ABOUT': {
      // [FIX-RTR-6] Delegate to ACTION_REGISTRY when a handler is registered (e.g. GENERAL
      // mode registers handleAbout which builds a richer flow-backed response). The previous
      // inline implementation always ran regardless of mode, shadowing the registered handler.
      // [FIX-8] The ABOUT action handler now returns null for non-GENERAL modes so the
      // inline fallback below runs. A non-null return means GENERAL handled it via startFlow.
      const aboutHandler = ACTION_REGISTRY.get('ABOUT');
      if (aboutHandler) {
        const aboutResult = await aboutHandler({ session, message, business, tenant, intent, isInteractive, suggestion });
        if (aboutResult) return aboutResult;
      }
      // Generic fallback for modes without a dedicated ABOUT handler
      const bizName = business?.businessName || business?.name || 'us';
      const desc    = business?.description  || null;
      const address = business?.address      || null;
      const hours   = business?.hours?.enabled
        ? 'Please check our operating hours below or contact us directly.'
        : null;
      const lines = [`ℹ️ *About ${bizName}*\n`];
      if (desc)    lines.push(desc);
      if (address) lines.push(`\n📍 *Location:* ${address}`);
      if (hours)   lines.push(`\n🕐 *Hours:* ${hours}`);
      lines.push('\n_Tap below to continue:_');
      const cfgAbout = getModeConfig(business);
      return {
        type:    'buttons',
        body:    lines.join(''),
        buttons: (cfgAbout.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }]).slice(0, 3),
      };
    }

    case 'QUOTE_FOLLOW': {
      // [FIX-RTR-5] For SERVICES mode, use the registered QUOTE_FOLLOW flow handler
      // (which starts the dedicated quote-follow-up flow). The switch-case previously
      // always started ENQUIRY, bypassing the ACTION_REGISTRY.get('QUOTE_FOLLOW')
      // handler that moduleRegistry registers for SERVICES — that handler is never
      // reachable because switch-cases run before the ACTION_REGISTRY lookup below.
      // Fix: delegate to ACTION_REGISTRY first when a handler is registered for this
      // mode, fall back to the generic ENQUIRY redirect only when none is registered.
      const qfHandler = ACTION_REGISTRY.get('QUOTE_FOLLOW');
      if (qfHandler) return qfHandler({ session, message, business, tenant, intent, isInteractive, suggestion });
      // Generic fallback for modes without a dedicated QUOTE_FOLLOW flow
      return startFlow({ flowName: 'ENQUIRY', session, business, tenant });
    }

    case 'DONE': {
      // [FIX-BUG10] Return welcome buttons instead of dead-end plain text
      const cfg = getModeConfig(business);
      return {
        type:    'buttons',
        body:    '✅ Thank you! Is there anything else we can help with?',
        buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }

    case 'PAYMENT': {
      // [FIX-RTR-PAY] PAYMENT intent (e.g. customer types "I paid", "payment sent",
      // "I've made the transfer") with no active flow — they may have sent payment
      // outside the normal flow, or the session expired after they paid.
      // Check for an order awaiting proof first; if found, restore the PAYMENT_PROOF step.
      // Otherwise show a gentle prompt to start a new order.
      try {
        const { default: _PayOrder } = await import('../../models/Order.js');
        const pendingPay = await _PayOrder.findOne({
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          paymentStatus: { $in: ['unpaid'] },
          status:        { $nin: ['cancelled', 'completed'] },
        }).select('_id item quantity totalPrice shortId').sort({ createdAt: -1 }).lean().catch(() => null);

        if (pendingPay) {
          // Restore the payment proof step so the customer can send their screenshot
          const { updateSession: _us } = await import('../sessions/sessionService.js');
          await _us(session.customerPhone, session.tenantId, {
            currentFlow: 'ORDER', step: 'PAYMENT_PROOF',
          });
          const cfg = getModeConfig(business);
          const currency = business?.payment?.currency || 'D';
          return {
            type:    'buttons',
            body:
              `📸 *Please send your payment screenshot*\n\n` +
              `Order *#${pendingPay.shortId}* — *${pendingPay.item}* × ${pendingPay.quantity}\n` +
              `💰 Amount: *${currency}${pendingPay.totalPrice || '—'}*\n\n` +
              `Send a clear screenshot of your successful payment transfer here.`,
            buttons: [
              { id: 'SUPPORT', title: '❓ Need Help'    },
              { id: 'CANCEL',  title: '❌ Cancel Order' },
            ],
          };
        }
      } catch { /* non-fatal — fall through to welcome */ }

      // No pending payment found — show welcome menu
      const cfgPay = getModeConfig(business);
      return {
        type:    'buttons',
        body:    `😊 We couldn't find a pending order for your payment. Would you like to place a new order?`,
        buttons: cfgPay.ui?.welcomeButtons || [{ id: 'ORDER', title: '🛒 Place an Order' }],
      };
    }

    case 'ENQUIRY': {
      // [FIX-ENQ-ROUTE] Generic ENQUIRY fallback for modes without a dedicated ENQUIRY flow
      // registered in ACTION_REGISTRY (e.g. RESTAURANT, BAKERY, SALON, RETAIL, etc.).
      // SERVICES and GENERAL have dedicated flows registered via moduleRegistry which are
      // reached through ACTION_REGISTRY BEFORE this switch case runs — so this fallback
      // only fires for modes that have no registered ENQUIRY handler.
      //
      // Previously this was handled by an inline handler in webhookController before
      // route() was ever called, which blocked SERVICES/GENERAL from reaching their flows.
      const enquiryHandler = ACTION_REGISTRY.get('ENQUIRY');
      if (enquiryHandler) return enquiryHandler({ session, message, business, tenant, intent, isInteractive, suggestion });
      // Generic fallback: set the ENQUIRY flow state and prompt
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ENQUIRY', step: 'AWAITING_QUESTION',
      });
      return {
        type:    'buttons',
        body:    '❓ What would you like to know? Type your question below.',
        buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }

    case 'QUESTION': {
      // [FIX-BTN-Q] Generic QUESTION fallback for modes without a dedicated QUESTION flow.
      // SERVICES → handleServicesQuestion, GENERAL → handleGeneralQuestion are reached via
      // ACTION_REGISTRY before this case runs. All other modes fall through here.
      const questionHandler = ACTION_REGISTRY.get('QUESTION');
      if (questionHandler) return questionHandler({ session, message, business, tenant, intent, isInteractive, suggestion });
      // Generic fallback: same as ENQUIRY — start the generic question-capture flow
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ENQUIRY', step: 'AWAITING_QUESTION',
      });
      return {
        type:    'buttons',
        body:    '❓ What would you like to know? Type your question below.',
        buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }
  }

  // ── Module-registered actions ─────────────────────────────────────────────
  const handler = ACTION_REGISTRY.get(upper);
  if (handler) {
    return handler({ session, message, business, tenant, intent, isInteractive, suggestion });
  }

  // [FIX-RTR-3] NOTE: START_ORDER and START_BOOKING are intentionally handled here
  // AFTER the ACTION_REGISTRY lookup above. This means they CAN be overridden by
  // calling registerAction('START_ORDER', handler) — the registry check runs first
  // and returns early if a custom handler is registered. These fallbacks only fire
  // when no custom handler has been registered.
  if (upper === 'START_ORDER')   return startFlow({ flowName: 'ORDER',   session, business, tenant });
  if (upper === 'START_BOOKING') return startFlow({ flowName: 'BOOKING', session, business, tenant });

  logger.warn('[Router] Unknown action', { action: upper, mode });
  const cfg2 = getModeConfig(business);
  return {
    type:    'buttons',
    // [FIX-BUG1] cfg.messages not cfg.labels
    body:    cfg2.messages?.fallback || 'How can I help you today?',
    buttons: cfg2.ui?.welcomeButtons || [],
  };
}
