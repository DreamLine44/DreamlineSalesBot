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
 * advance({ session, message, business, tenant, isInteractive })
 *
 * Advance the active flow by one step.
 * Returns a UIResponse object for dispatch.
 */
export async function advance({ session, message, business, tenant, isInteractive = false }) {
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
    const response = await handler({ session, message, business, tenant, isInteractive });
    return response || {
      type:    'buttons',
      body:    '⚠️ Something went wrong. Please try again.',
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    };
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
 * startFlow({ flowName, session, business, tenant })
 * Initialises a flow and returns the first-step UI.
 */
export async function startFlow({ flowName, session, business, tenant }) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const key  = `${mode}:${flowName.toUpperCase()}`;

  // Reset session to fresh flow state
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: flowName.toUpperCase(),
    step:        null,
    data:        {},
    upsellSent:  false,
    menuViewed:  false,
    lastAorInterceptAt: null,  // [FIX-AOR-5] Reset throttle so next order confirms show fresh card
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

  // Call handler with null message to trigger first-step UI
  const freshSession = (await getSession(session.customerPhone, session.tenantId)) || session;
  return handler({ session: freshSession, message: null, business, tenant, isInteractive: false });
}

/**
 * cancelFlow(session, business)
 * Cleanly cancels the active flow.
 */
export async function cancelFlow(session, business) {
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
  const cfg = getModeConfig(business);
  return {
    type:    'buttons',
    body:    CANCEL_MSGS[mode] || '✅ Cancelled.',
    buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
  };
}

/**
 * completeFlow(session, completedFlow, business?, tenant?)
 * Marks flow complete — writes postFlowAck so the next "Thanks/Ok"
 * gets a warm reply instead of the full welcome menu.
 * When business is provided, checks if lead capture should fire.
 */
export async function completeFlow(session, completedFlow, business = null, tenant = null) {
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: null,
    step:        null,
    data:        {},
    postFlowAck: completedFlow.toUpperCase(),
  });

  // Lead capture trigger — fire after ORDER or BOOKING if configured.
  // [FIX-SALON-15] WALKIN uses saveBooking() just like BOOKING, so it should
  // also trigger AFTER_BOOKING lead capture. Previously 'WALKIN' fell to the
  // AFTER_ORDER branch (wrong trigger type) meaning any FIRST_MESSAGE-style
  // lead-capture config would still work, but AFTER_BOOKING-only configs would
  // never fire for walk-in customers.
  if (business) {
    try {
      const completedUpper = completedFlow.toUpperCase();
      const trigger = (completedUpper === 'BOOKING' || completedUpper === 'WALKIN')
        ? 'AFTER_BOOKING'
        : 'AFTER_ORDER';
      const { shouldCaptureLead, startLeadCapture } = await import('../../services/leadCaptureService.js');
      const freshSession = (await getSession(session.customerPhone, session.tenantId)) || session;
      if (await shouldCaptureLead(business, freshSession, trigger)) {
        return await startLeadCapture(freshSession, business);
      }
    } catch (err) {
      logger.debug('[FlowEngine] Lead capture check failed (non-fatal)', { err: err.message });
    }
  }
  return null;
}
