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
    return { type: 'text', body: '⚠️ No active flow. Type *Hi* to start.' };
  }

  const flow      = session.currentFlow.toUpperCase();
  const mode      = (business?.businessMode || 'RETAIL').toUpperCase();
  const specificKey = `${mode}:${flow}`;
  const genericKey  = flow;

  // Try mode-specific handler first, then generic
  const handler = FLOW_REGISTRY.get(specificKey) || GENERIC_REGISTRY.get(genericKey);

  if (!handler) {
    logger.warn(`[FlowEngine] No handler for ${specificKey}`);
    return { type: 'text', body: '⚠️ Flow unavailable. Type *0* to return to menu.' };
  }

  try {
    const response = await handler({ session, message, business, tenant, isInteractive });
    return response || { type: 'text', body: '⚠️ Something went wrong. Type *0* to return to menu.' };
  } catch (err) {
    logger.error('[FlowEngine] Handler threw', { flow: specificKey, err: err.message });
    return { type: 'text', body: '⚠️ Something went wrong. Please try again or type *0*.' };
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
  });

  const handler = FLOW_REGISTRY.get(key) || GENERIC_REGISTRY.get(flowName.toUpperCase());
  if (!handler) {
    logger.warn(`[FlowEngine] No handler to start ${key}`);
    return { type: 'text', body: '⚠️ This option is not available. Type *0* to return to menu.' };
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

  // Build cancel response without importing modes (avoids circular chain)
  // Caller (webhookController) handles the response if needed
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();
  const CANCEL_MSGS = {
    RESTAURANT:  '✅ Cancelled! Type *Order* to order food or *Book* to reserve a table.',
    BAKERY:      '✅ Cancelled! Type *Order* to place a bakery order.',
    SALON:       '✅ Cancelled! Type *Book* whenever you\'re ready. ✂️',
    BARBERSHOP:  '✅ Cancelled! Type *Book* whenever you\'re ready. 💈',
    FASHION:     '✅ Cancelled! Type *Shop* to browse our collection. 👗',
    COSMETICS:   '✅ Cancelled! Type *Shop* to browse products. 💄',
    ELECTRONICS: '✅ Cancelled! Type *Browse* to see our products. 📱',
  };
  return {
    type:    'buttons',
    body:    CANCEL_MSGS[mode] || '✅ Cancelled! Type *0* to return to the main menu.',
    buttons: [{ id: 'SHOW_MENU', title: '🏠 Main Menu' }],
  };
}

/**
 * completeFlow(session, completedFlow, business?, tenant?)
 * Marks flow complete. If lead capture is configured for this trigger,
 * starts the lead capture flow instead of returning to menu.
 * Returns a UIResponse if lead capture starts, otherwise undefined.
 */
export async function completeFlow(session, completedFlow, business = null, tenant = null) {
  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: null,
    step:        null,
    data:        {},
    postFlowAck: completedFlow.toUpperCase(),
  });

  // Trigger lead capture if configured
  if (business) {
    try {
      const trigger = completedFlow.toUpperCase() === 'ORDER' ? 'AFTER_ORDER' : 'AFTER_BOOKING';
      const { shouldCaptureLead, startLeadCapture } = await import('../../services/leadCaptureService.js');
      const freshSession = (await getSession(session.customerPhone, session.tenantId)) || session;
      if (await shouldCaptureLead(business, freshSession, trigger)) {
        return startLeadCapture(freshSession, business);
      }
    } catch (err) {
      logger.debug('[FlowEngine] Lead capture check failed (non-fatal)', { err: err.message });
    }
  }
  return null;
}
