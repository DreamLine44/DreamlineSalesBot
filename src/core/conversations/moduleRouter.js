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
 */

import { startFlow, cancelFlow } from './flowEngine.js';
import { updateSession }         from '../sessions/sessionService.js';
import { generateGreeting }      from '../ai/providers/aiRouter.js';
import { dispatchText }          from '../whatsapp/dispatcher.js';
import logger from '../../config/logger.js';

const ACTION_REGISTRY = new Map();

export function registerAction(action, handler) {
  ACTION_REGISTRY.set(action.toUpperCase(), handler);
}

export async function route({ action, intent, session, message, business, tenant, isInteractive, suggestion }) {
  const upper = (action || 'FALLBACK').toUpperCase();
  const mode  = (business?.businessMode || 'RETAIL').toUpperCase();

  logger.debug('[Router] Routing', { action: upper, mode, step: session?.step });

  switch (upper) {

    case 'GREET': {
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

      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, data: {},
        postFlowAck: null, menuViewed: false, upsellSent: false,
        customerName: existingName,
      });

      // [FIX-BUG1] cfg.messages not cfg.labels — module configs use .messages
      // Also honour customMessages.welcomeMessage when set by the operator
      const customWelcome = business?.customMessages?.welcomeMessage;
      const body = greetMsg
        || customWelcome
        || cfg.messages?.welcome
        || '👋 Welcome! How can I help?';

      return { type: 'buttons', body, buttons: cfg.ui?.welcomeButtons || [] };
    }

    case 'SHOW_MENU': {
      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);
      await updateSession(session.customerPhone, session.tenantId, {
        currentFlow: null, step: null, postFlowAck: null,
      });
      // [FIX] SHOW_MENU ≠ GREET. When a customer taps "Start Over" mid-session
      // they should NOT see the full welcome greeting (business description, etc.)
      // again — that's jarring and feels like the bot forgot the conversation.
      // SHOW_MENU shows a short "what else can I help with?" prompt + action buttons.
      // GREET (first message / fresh start) shows the full branded welcome.
      return {
        type:    'buttons',
        body:    '👇 What would you like to do?',
        buttons: cfg.ui?.welcomeButtons || [],
      };
    }

    case 'CANCEL': {
      return cancelFlow(session, business);
    }

    case 'SUPPORT': {
      const adminPhone = business?.adminPhone || tenant?.adminPhone || null;

      // [FIX-BUG8] Set humanModeNotified=true so second message doesn't re-alert admin
      await updateSession(session.customerPhone, session.tenantId, {
        humanMode: true, humanModeNotified: true, currentFlow: null, step: null,
      });

      if (adminPhone && tenant && !session.humanModeNotified) {
        const nameStr = session.customerName ? ` (${session.customerName})` : '';
        const alert   =
          `🚨 *Support escalation*\n\n` +
          `Customer *${session.customerPhone}*${nameStr} needs help.\n` +
          `Message: "${message || '(no message)'}"\n\n` +
          `Bot is now *silent* for this customer.\n\n` +
          `Reply directly to them on WhatsApp, then type:\n` +
          `✅ \`RESUME BOT ${session.customerPhone}\``;
        dispatchText(adminPhone, alert, tenant).catch(() => {});
      }

      const body = adminPhone
        ? `🆘 *Support Request*\n\nI've flagged this to our team.\n\n📞 You can also reach us directly at *${adminPhone}*`
        : `🆘 *Support Request*\n\nI've flagged this to our team. Someone will contact you shortly.`;

      return {
        type:    'buttons',
        body,
        buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }

    case 'TRACK_ORDER': {
      const handler = ACTION_REGISTRY.get('TRACK_ORDER');
      if (handler) return handler({ session, message, business, tenant });
      const phone = business?.adminPhone || null;
      const { getModeConfig } = await import('../../config/modes.js');
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
      const { getAIReply }    = await import('../ai/providers/aiRouter.js');
      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);

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

    case 'DONE': {
      // [FIX-BUG10] Return welcome buttons instead of dead-end plain text
      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);
      return {
        type:    'buttons',
        body:    '✅ Thank you! Is there anything else we can help with?',
        buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }
  }

  // ── Module-registered actions ─────────────────────────────────────────────
  const handler = ACTION_REGISTRY.get(upper);
  if (handler) {
    return handler({ session, message, business, tenant, intent, isInteractive, suggestion });
  }

  if (upper === 'START_ORDER')   return startFlow({ flowName: 'ORDER',   session, business, tenant });
  if (upper === 'START_BOOKING') return startFlow({ flowName: 'BOOKING', session, business, tenant });

  logger.warn('[Router] Unknown action', { action: upper, mode });
  const { getModeConfig: getMC } = await import('../../config/modes.js');
  const cfg2 = getMC(business);
  return {
    type:    'buttons',
    // [FIX-BUG1] cfg.messages not cfg.labels
    body:    cfg2.messages?.fallback || 'How can I help you today?',
    buttons: cfg2.ui?.welcomeButtons || [],
  };
}
