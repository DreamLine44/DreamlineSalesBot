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
      // Preserve customerName — do NOT wipe on greet
      const existingName = session?.customerName || null;
      const lastOrder    = session?.data?.lastItem || null;

      // ── FIRST_MESSAGE lead capture ──────────────────────────────────────────
      // Only fires on first-ever message (messageCount 0 or 1 after increment)
      if ((session.messageCount || 0) <= 1 && business?.leadCapture?.triggerOn === 'FIRST_MESSAGE') {
        try {
          const { shouldCaptureLead, startLeadCapture } = await import('../../services/leadCaptureService.js');
          const freshSession = await import('../sessions/sessionService.js')
            .then(m => m.getSession(session.customerPhone, session.tenantId)) || session;
          if (await shouldCaptureLead(business, freshSession, 'FIRST_MESSAGE')) {
            return startLeadCapture(freshSession, business);
          }
        } catch (err) {
          logger.debug('[Router] FIRST_MESSAGE lead capture failed (non-fatal)', { err: err.message });
        }
      }

      // ── Personalised greeting using customer context ────────────────────────
      let greetMsg = null;
      try {
        const { getCustomerContext } = await import('../memory/customerMemory.js');
        const ctx = await getCustomerContext(session.customerPhone, session.tenantId);
        const name = existingName || ctx.name;
        if (name || ctx.topItem) {
          const g = await generateGreeting({
            business,
            customerName: name,
            lastOrder: ctx.topItem || lastOrder,
          });
          greetMsg = g;
          // Persist discovered name to session if not already stored
          if (ctx.name && !existingName) {
            updateSession(session.customerPhone, session.tenantId, { customerName: ctx.name }).catch(() => {});
          }
        }
      } catch { /* non-fatal */ }

      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);

      // Reset flow state but preserve customerName
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow:  null, step: null, data: {},
        postFlowAck:  null, menuViewed: false, upsellSent: false,
        customerName: existingName,
      });

      if (greetMsg) {
        return { type: 'buttons', body: greetMsg, buttons: cfg.ui?.welcomeButtons || [] };
      }
      return { type: 'buttons', body: cfg.messages?.welcome || '👋 Welcome! How can I help?', buttons: cfg.ui?.welcomeButtons || [] };
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

    case 'PAYMENT': {
      // Customer asking about payment / how to pay
      const payment = business?.payment;
      if (!payment?.enabled) {
        return {
          type: 'buttons',
          body: '💳 Payment is handled at delivery or collection. Our team will contact you with details.',
          buttons: [{ id: 'SHOW_MENU', title: '🏠 Main Menu' }],
        };
      }
      const waveNo   = payment.wavePhone || payment.phone || 'N/A';
      const currency = payment.currency  || 'D';
      return {
        type: 'buttons',
        body: `💳 *Payment Details*\n\nSend payment via *Wave* to: *${waveNo}*\n\nAfter paying, send your *screenshot* here. 📸`,
        buttons: [
          { id: 'ORDER',    title: '🛍 Place Order'  },
          { id: 'SHOW_MENU', title: '🏠 Main Menu'  },
        ],
      };
    }

    case 'SWITCH_YES': {
      // Customer confirmed switching flow mid-session
      const { getModeConfig: getSwCfg } = await import('../../config/modes.js');
      const swCfg = getSwCfg(business);
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, data: {}, postFlowAck: null,
      });
      return {
        type:    'buttons',
        body:    swCfg.messages?.welcome || '👋 What would you like to do?',
        buttons: swCfg.ui?.welcomeButtons || [],
      };
    }

    case 'SWITCH_NO': {
      // Customer wants to stay in current flow — re-send last bot message or show menu
      const lastMsg = session?.lastBotMessage;
      if (lastMsg) {
        return { type: 'text', body: lastMsg };
      }
      const { getModeConfig: getSnCfg } = await import('../../config/modes.js');
      const snCfg = getSnCfg(business);
      return {
        type:    'buttons',
        body:    snCfg.messages?.welcome || '👋 What would you like to do?',
        buttons: snCfg.ui?.welcomeButtons || [],
      };
    }

    case 'REJECTION_RESEND': {
      // Customer wants to resend payment proof after rejection
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: 'ORDER', step: 'PAYMENT_PROOF',
      });
      return { type: 'text', body: '📸 Please send your new payment screenshot now.' };
    }

    case 'REJECTION_SUPPORT': {
      // Customer wants human help after payment rejection
      const adminPhone = business?.adminPhone || tenant?.adminPhone || null;
      await updateSession(session.customerPhone, session.tenantId, {
        humanMode: true, humanModeNotified: true, currentFlow: null, step: null,
      });
      if (adminPhone && tenant && !session.humanModeNotified) {
        dispatchText(adminPhone,
          `🚨 *Support escalation*\n\nCustomer *${session.customerPhone}* needs help with a rejected payment.\n\nBot is now silent.\n\`RESUME BOT ${session.customerPhone}\``,
          tenant).catch(() => {});
      }
      return {
        type: 'text',
        body: '🆘 I\'ve notified our team. Someone will contact you shortly to help resolve your payment.',
      };
    }

    case 'REJECTION_CANCEL': {
      // Customer cancels after payment rejection
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, data: {},
      });
      const { getModeConfig: getRcCfg } = await import('../../config/modes.js');
      const rcCfg = getRcCfg(business);
      return {
        type:    'buttons',
        body:    '✅ No problem. Feel free to order again whenever you\'re ready.',
        buttons: rcCfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🏠 Main Menu' }],
      };
    }

  } // ← closes switch

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