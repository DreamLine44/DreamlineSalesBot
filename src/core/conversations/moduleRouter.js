/**
 * core/conversations/moduleRouter.js
 *
 * Routes a detected intent to the correct business module handler.
 *
 * Flow:
 *   intentEngine.detectIntent() → moduleRouter.route() → module handler
 *
 * Each business module registers its action handlers here.
 * Adding a new module = add its handlers, zero core code changes.
 */

import { startFlow, cancelFlow, completeFlow } from './flowEngine.js';
import { updateSession }   from '../sessions/sessionService.js';
import { generateGreeting } from '../ai/providers/aiRouter.js';
import { dispatchText }    from '../whatsapp/dispatcher.js';
import logger from '../../config/logger.js';

// ── Action handlers registry ──────────────────────────────────────────────────
// Key: action string (e.g. 'START_ORDER')
// Value: async ({ session, message, business, tenant, intent }) => UIResponse
const ACTION_REGISTRY = new Map();

export function registerAction(action, handler) {
  ACTION_REGISTRY.set(action.toUpperCase(), handler);
}

/**
 * route({ action, intent, session, message, business, tenant, isInteractive })
 * Returns UIResponse
 */
export async function route({ action, intent, session, message, business, tenant, isInteractive, suggestion }) {
  const upper = (action || 'FALLBACK').toUpperCase();
  const mode  = (business?.businessMode || 'RETAIL').toUpperCase();

  logger.debug('[Router] Routing', { action: upper, mode, step: session?.step });

  // ── Built-in actions (no module needed) ───────────────────────────────────
  switch (upper) {

    case 'GREET': {
      // Fix: preserve customerName across greet — don't wipe it
      const existingName = session?.customerName || null;
      const lastOrder    = session?.data?.lastItem || null;

      let greetMsg = null;
      if (existingName) {
        try {
          const g = await generateGreeting({ business, customerName: existingName, lastOrder });
          greetMsg = g;
        } catch { /* non-fatal */ }
      }

      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);

      // Reset session but preserve customerName
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow:  null, step: null, data: {},
        postFlowAck:  null, menuViewed: false, upsellSent: false,
        customerName: existingName,  // preserve — do NOT wipe
      });

      if (greetMsg) {
        return { type: 'buttons', body: greetMsg, buttons: cfg.ui?.welcomeButtons || [] };
      }
      return { type: 'buttons', body: cfg.labels?.welcome || '👋 Welcome! How can I help?', buttons: cfg.ui?.welcomeButtons || [] };
    }

    case 'SHOW_MENU': {
      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, postFlowAck: null,
      });
      return { type: 'buttons', body: cfg.labels?.welcome || '👋 What would you like to do?', buttons: cfg.ui?.welcomeButtons || [] };
    }

    case 'CANCEL': {
      return cancelFlow(session, business);
    }

    case 'SUPPORT': {
      const adminPhone = business?.adminPhone || tenant?.adminPhone || null;
      const customerPhone = session?.customerPhone || 'unknown';

      // ── Set human mode & suppress bot ────────────────────────────────────
      await updateSession(customerPhone, session.tenantId, {
        humanMode: true, humanModeNotified: true, currentFlow: null, step: null,
      });

      // ── Notify admin on WhatsApp (only if not already notified this session) ──
      if (adminPhone && tenant && !session.humanModeNotified) {
        const escalationAlert =
          `🚨 *Support escalation*\n\n` +
          `Customer *${customerPhone}* needs help.\n` +
          `Message: "${message || '(no message)'}"\n\n` +
          `Bot is now *silent* for this customer.\n\n` +
          `Reply directly to the customer on WhatsApp, then send:\n` +
          `✅ \`RESUME BOT ${customerPhone}\``;
        dispatchText(adminPhone, escalationAlert, tenant).catch(() => {});
      }

      const body = adminPhone
        ? `🆘 *Support Request*\n\nI've passed this to our team. Someone will contact you shortly.`
        : `🆘 *Support Request*\n\nI've flagged this to our team. Someone will contact you shortly.`;
      return { type: 'text', body };
    }

    case 'TRACK_ORDER': {
      const handler = ACTION_REGISTRY.get('TRACK_ORDER');
      if (handler) return handler({ session, message, business, tenant });
      const phone = business?.adminPhone || null;
      return {
        type: 'text',
        body: `📦 *Order Tracking*\n\nFor updates on your order, please contact us directly.` +
              (phone ? `\n\n📞 *${phone}*` : ''),
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
      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);

      const aiText = await getAIReply({ customerMessage: message, business, session, intent });
      const body   = aiText || cfg.labels?.fallback || 'How can I help you? 😊';

      return {
        type:    'buttons',
        body,
        buttons: cfg.ui?.fallbackButtons || [{ id: 'SHOW_MENU', title: '🏠 Menu' }],
      };
    }

    case 'DONE': {
      return { type: 'text', body: '✅ Thank you! We\'ll be in touch shortly.' };
    }

    // FIX #1: CONTINUE_FLOW — received when customer sends a number/short text with no active flow.
    // Just show the menu silently (no "unknown action" warning).
    case 'CONTINUE_FLOW': {
      const { getModeConfig: getMC2 } = await import('../../config/modes.js');
      const cfg3 = getMC2(business);
      return {
        type:    'buttons',
        body:    cfg3.labels?.welcome || cfg3.messages?.welcome || '👋 What would you like to do?',
        buttons: cfg3.ui?.welcomeButtons || [],
      };
    }

    // FIX #2: PAYMENT — customer tapped a payment button or typed "pay" outside an active flow.
    case 'PAYMENT': {
      const payment = business?.payment;
      if (!payment?.enabled) {
        return { type: 'text', body: `💳 Payment is handled at checkout when you place an order. Type *Order* to get started!` };
      }
      const waveNo  = payment.wavePhone || payment.phone || '—';
      const currency = payment.currency || 'D';
      return {
        type:    'buttons',
        body:    `💳 *Payment Info*\n\nSend payment via *Wave* to: *${waveNo}*\n\nOnce you've paid, send us your *screenshot* and we'll confirm your order.`,
        buttons: [{ id: 'ORDER', title: '🛍 Place an Order' }, { id: 'SHOW_MENU', title: '🏠 Main Menu' }],
      };
    }

    // FIX #3: SWITCH_YES / SWITCH_NO — customer tapping a flow-switch confirmation button.
    // These appear in active-flow contexts. If we reach the router it means there's no active flow
    // — treat SWITCH_YES as starting the ORDER flow, SWITCH_NO as returning to menu.
    case 'SWITCH_YES': {
      return startFlow({ flowName: 'ORDER', session, business, tenant });
    }
    case 'SWITCH_NO': {
      const { getModeConfig: getMC3 } = await import('../../config/modes.js');
      const cfg4 = getMC3(business);
      await updateSession(session.customerPhone, session.tenantId, { currentFlow: null, step: null });
      return { type: 'buttons', body: cfg4.messages?.welcome || '👋 What would you like to do?', buttons: cfg4.ui?.welcomeButtons || [] };
    }

    // FIX #4: REJECTION_* buttons — sent after payment rejection. By the time they reach the
    // router it means the session flow was cleared. Route to the appropriate recovery action.
    case 'REJECTION_RESEND': {
      return startFlow({ flowName: 'ORDER', session, business, tenant });
    }
    case 'REJECTION_SUPPORT': {
      // Re-use the SUPPORT case logic
      return route({ action: 'SUPPORT', intent, session, message, business, tenant, isInteractive, suggestion });
    }
    case 'REJECTION_CANCEL': {
      const { getModeConfig: getMC4 } = await import('../../config/modes.js');
      const cfg5 = getMC4(business);
      await updateSession(session.customerPhone, session.tenantId, { currentFlow: null, step: null, data: {} });
      return { type: 'buttons', body: cfg5.messages?.welcome || '👋 What else can we help with?', buttons: cfg5.ui?.welcomeButtons || [] };
    }
  }

  // ── Module-registered actions ─────────────────────────────────────────────
  const handler = ACTION_REGISTRY.get(upper);
  if (handler) {
    return handler({ session, message, business, tenant, intent, isInteractive, suggestion });
  }

  // ── Start flow actions ────────────────────────────────────────────────────
  if (upper === 'START_ORDER') {
    return startFlow({ flowName: 'ORDER', session, business, tenant });
  }
  if (upper === 'START_BOOKING') {
    return startFlow({ flowName: 'BOOKING', session, business, tenant });
  }

  // Unknown action
  logger.warn('[Router] Unknown action', { action: upper, mode });
  const { getModeConfig: getMC } = await import('../../config/modes.js');
  const cfg2 = getMC(business);
  return {
    type:    'buttons',
    body:    cfg2.labels?.fallback || 'How can I help you today?',
    buttons: cfg2.ui?.fallbackButtons || [],
  };
}
