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
