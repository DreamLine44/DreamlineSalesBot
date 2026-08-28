/**
 * core/conversations/flowEngine.js
 *
 * REUSABLE FLOW STATE MACHINE
 *
 * Replaces the monolithic flowService.js switch-case.
 * Each business module registers its own flow handlers.
 * The engine routes step-by-step, handles cancellations, and enforces guards.
 *
 * Architecture:
 *   webhookController → moduleRouter → flowEngine.advance()
 *                                           ↓
 *                               module flow handlers (per step)
 *                                           ↓
 *                                    session update + response
 */

import { updateSession, getSession } from '../sessions/sessionService.js';
import logger from '../../config/logger.js';
import { EXPRESSION_TURN_BUDGET } from '../../services/postFlowHandler.js';
import { suppressLegacyMenuOption } from '../../modules/catalog/waCatalogConfig.js';

// ── Registered flow handlers ──────────────────────────────────────────────────
// Key: `${businessMode}:${flowName}` e.g. 'RESTAURANT:ORDER'
// Value: async (session, message, business, tenant, meta) => UIResponse
const FLOW_REGISTRY = new Map();

/**
 * registerFlow(businessMode, flowName, handler)
 * Called by each module to register its flow handler.
 *
 * handler = async ({ session, message, business, tenant, isInteractive }) => UIResponse
 */
export function registerFlow(businessMode, flowName, handler) {
  const key = `${businessMode.toUpperCase()}:${flowName.toUpperCase()}`;
  FLOW_REGISTRY.set(key, handler);
  logger.debug(`[FlowEngine] Registered ${key}`);
}

// ── Generic order/booking shared flows (registered by shared modules) ─────────
const GENERIC_REGISTRY = new Map(); // flowName → handler

export function registerGenericFlow(flowName, handler) {
  GENERIC_REGISTRY.set(flowName.toUpperCase(), handler);
}

/**
 * hasFlow(mode, flowName)
 *
 * [FIX-STARTFLOW-FALLBACK] Lets a caller check whether a flow actually has a
 * registered handler for a given business mode BEFORE calling startFlow() —
 * so it can fall back to something more helpful than the "not available"
 * dead end (see the comment on that branch in startFlow() below for the
 * bug class this closes). Mirrors the exact lookup startFlow() itself uses.
 */
export function hasFlow(mode, flowName) {
  const key = `${String(mode || '').toUpperCase()}:${String(flowName || '').toUpperCase()}`;
  return FLOW_REGISTRY.has(key) || GENERIC_REGISTRY.has(String(flowName || '').toUpperCase());
}

/**
 * advance({ session, message, business, tenant, isInteractive })
 *
 * Advance the active flow by one step.
 * Returns a UIResponse object for dispatch.
 */
export async function advance({ session, message, business, tenant, isInteractive = false, flowReply = null }) {
  if (!session?.currentFlow) {
    return {
      type:    'buttons',
      body:    '⚠️ No active session. Please tap below to get started.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  }

  const flow      = session.currentFlow.toUpperCase();
  const mode      = (business?.businessMode || 'RETAIL').toUpperCase();
  const specificKey = `${mode}:${flow}`;
  const genericKey  = flow;

  // Try mode-specific handler first, then generic
  const handler = FLOW_REGISTRY.get(specificKey) || GENERIC_REGISTRY.get(genericKey);

  if (!handler) {
    logger.warn(`[FlowEngine] No handler for ${specificKey}`);
    return {
      type:    'buttons',
      body:    '⚠️ This option is not available right now.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  }

  try {
    const response = await handler({ session, message, business, tenant, isInteractive, flowReply });
    // null = handler already dispatched outbound UI (e.g. WA Catalog re-open)
    if (response === null) return null;
    return suppressLegacyMenuOption(response || {
      type:    'buttons',
      body:    '⚠️ Something went wrong. Please try again.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    }, business);
  } catch (err) {
    logger.error('[FlowEngine] Handler threw', { flow: specificKey, err: err.message });
    return {
      type:    'buttons',
      body:    '⚠️ Something went wrong. Please try again.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  }
}

/**
 * startFlow({ flowName, session, business, tenant, message })
 * Initialises a flow and returns the first-step UI.
 *
 * [FIX-QSTART-MSG] `message` is optional and defaults to null, preserving every
 * existing call site's behaviour (a genuine button tap has no real question yet,
 * so the handler's INIT branch should run and show first-step UI). Callers that
 * DO have real customer text to answer immediately — e.g. a typed question that
 * intent detection classified as QUESTION, arriving here instead of a button
 * tap — can now pass it through so it reaches the handler on this very call
 * instead of being discarded and replaced with a generic prompt.
 */
export async function startFlow({ flowName, session, business, tenant, message = null }) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const key  = `${mode}:${flowName.toUpperCase()}`;

  // Reset session to fresh flow state.
  // [FIX-STARTFLOW-DOUBLE-READ] updateSession() uses findOneAndUpdate(..., { new: true })
  // and already returns the freshly-written document — the getSession() call that used
  // to follow this was a second, entirely redundant DB round trip reading back exactly
  // what was just written. Removing it shaves a full Mongo round trip off every flow
  // start (Order Food, View Menu, Book a Table, etc.), directly on the tap-to-reply path.
  const flowUpper = flowName.toUpperCase();
  // [AUDIT-FIX-QMODE-2] Also preserve an in-progress cart when starting the QUESTION
  // flow, not just ORDER. A customer mid-ORDER who asks a question and then taps
  // "❓ Ask Another" (or any other path that calls startFlow('QUESTION', ...) while
  // a cart already exists) was having their cart silently wiped here, because this
  // condition only ever recognised flowUpper === 'ORDER'. The cart sits unused while
  // in Question Mode and is picked back up correctly once the customer switches back
  // to ORDER (that branch already handles restoring it) — so preserving it here now
  // costs nothing and just stops it from being lost outright.
  const existingCart = (flowUpper === 'ORDER' || flowUpper === 'QUESTION')
    && Array.isArray(session?.data?.cart) && session.data.cart.length
    ? session.data.cart
    : null;
  const orderViaCatalog = session?.data?.orderViaCatalog === true;

  const sessionPatch = {
    currentFlow: flowUpper,
    step:        null,
    data:        existingCart
      ? { cart: existingCart, ...(orderViaCatalog ? { orderViaCatalog: true } : {}) }
      : (orderViaCatalog ? { orderViaCatalog: true } : {}),
    upsellSent:  false,
    menuViewed:  false,
    lastAorInterceptAt: null,  // [FIX-AOR-5] Reset throttle so next order confirms show fresh card
    postFlowAck:  null,
    postFlowData: null,
  };
  if (flowUpper === 'ORDER') {
    sessionPatch.orderChannel = session?.orderChannel === 'catalog' || orderViaCatalog
      ? 'catalog'
      : 'menu';
  }
  if (flowUpper === 'BOOKING') {
    const hasServices = (business?.services || []).length > 0;
    const isRestaurant = (business?.businessMode || '').toUpperCase() === 'RESTAURANT';
    if (!hasServices && isRestaurant) {
      sessionPatch.step = 'PARTY_SIZE';
    } else if (!hasServices) {
      sessionPatch.step = 'DATE';
    }
  }

  const updated = await updateSession(session.customerPhone, session.tenantId, sessionPatch);
  // Do not render the first flow prompt from an in-memory snapshot when the
  // transition write returned no document. A vanished/expired session must be
  // recreated before the customer can answer the prompt.
  const persisted = updated || await createSession(session.customerPhone, session.tenantId, {
    ...sessionPatch,
    phoneNumberId: session.phoneNumberId || null,
    customerName: session.customerName || null,
  });

  const handler = FLOW_REGISTRY.get(key) || GENERIC_REGISTRY.get(flowName.toUpperCase());
  if (!handler) {
    logger.warn(`[FlowEngine] No handler to start ${key}`);
    return {
      type:    'buttons',
      body:    '⚠️ This option is not available. Please choose another action.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
  }

  // Call handler with the forwarded message (null for a genuine fresh-tap start,
  // to trigger first-step UI; the customer's real text when one was passed in,
  // so it gets answered on this call instead of being thrown away).
  const freshSession = persisted || session;
  const response = await handler({ session: freshSession, message, business, tenant, isInteractive: false });
  return suppressLegacyMenuOption(response, business);
}

/**
 * cancelFlow(session, business)
 * Cleanly cancels the active flow.
 *
 * [FIX-CANCEL-3] Previously this function only cleared the in-memory session
 * (currentFlow/step/data) and never touched the actual Booking document in
 * MongoDB. That meant a customer tapping "Cancel Booking" got a friendly
 * "No problem!" reply, but the Booking record stayed status:'confirmed' (or
 * 'pending') in the DB. The very next message ("hi") would re-trigger the
 * active-booking lookup in moduleRouter.js, find that still-confirmed
 * booking, and show it to the customer again as if nothing happened.
 *
 * A fix for this (FIX-CANCEL-2) was previously written directly in
 * webhookController.js's global-escape CANCEL_BOOKING branch, but a botched
 * edit merged that branch's guarding `if (...)  {` into a comment via a
 * literal "\n" instead of a real newline, so the fix never actually ran.
 *
 * Moving the DB-cancel here means every caller of cancelFlow() — the global
 * escape handler in webhookController.js, and the CANCEL_BOOKING branches in
 * postFlowHandler.js's handleBookingConfirmed() and handleWalkInQueueAck() —
 * gets the real cancellation for free, instead of each call site needing to
 * remember to do it themselves.
 */
export async function cancelFlow(session, business) {
  // [FIX-CANCEL-3] Cancel the customer's most recent active Booking (if any)
  // before clearing the session. Scoped to pending/confirmed so completed or
  // already-cancelled bookings are left untouched. Non-fatal: a booking-cancel
  // failure should never block the session reset / reply to the customer.
  try {
    const { default: Booking } = await import('../../models/Booking.js');
    const { buildActiveBookingFilter } = await import('../../services/activityLifecycleService.js');
    await Booking.findOneAndUpdate(
      buildActiveBookingFilter(session.customerPhone, session.tenantId),
      { $set: { status: 'cancelled', cancelledBy: 'customer', cancelledAt: new Date() } },
      { sort: { createdAt: -1 } }
    );
  } catch (err) {
    logger.debug('[FlowEngine] cancelFlow: booking cancel skipped (non-fatal)', { err: err.message });
  }

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: null, step: null, data: {}, postFlowAck: null,
  });

  // Build cancel response — use buttons, never type-a-keyword instructions
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const CANCEL_MSGS = {
    RESTAURANT:  '✅ No problem! What would you like to do?',
    BAKERY:      '✅ No problem! What would you like to do?',
    SALON:       "✅ No problem — just tap below whenever you're ready. ✂️",
    BARBERSHOP:  "✅ No problem — just tap below whenever you're ready. 💈",
    FASHION:     '✅ No problem! Browse our collection anytime. 👗',
    COSMETICS:   '✅ No problem! Browse our products anytime. 💄',
    ELECTRONICS: '✅ No problem! Browse our range anytime. 📱',
  };
  // [FIX] Return mode-appropriate welcome buttons so the customer has somewhere to go
  // without needing to type anything.
  const { getModeConfig } = await import('../../config/modes.js');
  const { buildOptionsReply } = await import('../shared/uiOptionsHelper.js');
  const cfg = getModeConfig(business);
  return buildOptionsReply(cfg, CANCEL_MSGS[mode] || '✅ Cancelled.');
}

/**
 * completeFlow(session, completedFlow, business?, tenant?)
 * Marks flow complete — writes postFlowAck so the next "Thanks/Ok"
 * gets a warm reply instead of the full welcome menu.
 * When business is provided, checks if lead capture should fire.
 */
export async function completeFlow(session, completedFlow, business = null, tenant = null, { postFlowSnapshot = null } = {}) {
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow:  null,
    step:         null,
    data:         {},
    postFlowAck:  completedFlow.toUpperCase(),
    postFlowData: {
      ...(postFlowSnapshot || {}),
      _exprTurnsLeft: EXPRESSION_TURN_BUDGET,
    },
  });

  // Lead capture trigger — fire after ORDER or BOOKING if configured.
  // [AUDIT-FIX-LEADCAP-1] Previously used an "else" catch-all: only
  // 'BOOKING'/'WALKIN' mapped to AFTER_BOOKING, and EVERYTHING ELSE
  // (QUESTION, ENQUIRY, ABOUT, SPEC_REQUEST, WARRANTY, SKINCARE_ADVICE,
  // QUOTE_FOLLOW — none of which are an order being placed) silently mapped
  // to AFTER_ORDER. A business configured with leadCapture.triggerOn=
  // 'AFTER_ORDER' would get a "what's your name?" prompt injected after
  // simply answering an FAQ. Explicit allowlists force a conscious decision
  // for any new completedFlow value instead of defaulting it into AFTER_ORDER.
  const ORDER_COMPLETING_FLOWS   = new Set(['ORDER']);
  const BOOKING_COMPLETING_FLOWS = new Set(['BOOKING', 'WALKIN']);

  if (business) {
    try {
      const completedUpper = completedFlow.toUpperCase();
      let trigger = null;
      if (ORDER_COMPLETING_FLOWS.has(completedUpper)) {
        trigger = 'AFTER_ORDER';
      } else if (BOOKING_COMPLETING_FLOWS.has(completedUpper)) {
        trigger = 'AFTER_BOOKING';
      }
      if (trigger) {
        const { shouldCaptureLead, startLeadCapture } = await import('../../services/leadCaptureService.js');
        const freshSession = (await getSession(session.customerPhone, session.tenantId)) || session;
        if (await shouldCaptureLead(business, freshSession, trigger)) {
          return await startLeadCapture(freshSession, business);
        }
      }
    } catch (err) {
      logger.debug('[FlowEngine] Lead capture check failed (non-fatal)', { err: err.message });
    }
  }
  return null;
}
