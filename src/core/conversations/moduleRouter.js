/**
 * core/conversations/moduleRouter.js
 *
 * Routes a detected intent to the correct business module handler.
 *
 * [FIX-BUG1]  cfg.labels → cfg.messages — ALL module configs export .messages,
 *             not .labels. Using .labels returned undefined everywhere, causing
 *             blank bot responses on GREET / SHOW_MENU / FALLBACK / CLARIFY.
 *
 * [FIX #2]    PAYMENT case added. Previously the intent was detected but had no
 *             handler, silently falling through to the Unknown-action logger.
 *             If an unpaid pending order exists, re-opens the PAYMENT_PROOF step.
 *             Otherwise shows generic Wave payment info from the business config.
 *
 * [FIX #3]    CONTINUE_FLOW returns null (no reply) instead of falling through to
 *             the Unknown-action handler and sending a spurious menu.
 *
 * [FIX-BUG8]  SUPPORT sets humanModeNotified=true so a 2nd message from the same
 *             customer doesn't trigger a duplicate admin escalation alert.
 *
 * [FIX-BUG10] DONE action returns mode-appropriate welcome buttons, not a dead-end.
 *
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

      // [FIX-BUG1] cfg.messages not cfg.labels; also honour operator customMessages
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
      // SHOW_MENU ≠ GREET — short "what next?" prompt, not the full branded greeting
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

      // [FIX-BUG8] humanModeNotified=true prevents duplicate admin alerts
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
      // [FIX-BUG10] Return welcome buttons — not a dead-end plain text response
      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);
      return {
        type:    'buttons',
        body:    '✅ Thank you! Is there anything else we can help with?',
        buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }

    // [FIX #3] CONTINUE_FLOW: pure-digit / very-short input with no active flow context.
    // Nothing to continue — return null so the webhook sends nothing.
    case 'CONTINUE_FLOW': {
      return null;
    }

    // [FIX #2] PAYMENT: detected but previously had no handler — fell through to
    // the Unknown-action logger and returned a generic fallback to a customer
    // asking how to pay.
    //
    // If there is an unpaid pending order, re-open the PAYMENT_PROOF step so the
    // customer can send their screenshot without restarting the order flow.
    // Otherwise show generic Wave payment instructions from the business config.
    case 'PAYMENT': {
      const handler = ACTION_REGISTRY.get('PAYMENT');
      if (handler) return handler({ session, message, business, tenant, intent, isInteractive, suggestion });

      // Try to find an existing unpaid order for this session
      let unpaidOrder = null;
      try {
        const { default: OrderModel } = await import('../../models/Order.js');
        unpaidOrder = await OrderModel.findOne({
          customerPhone: session.customerPhone,
          tenantId:      session.tenantId,
          paymentStatus: 'unpaid',
          status:        'pending',
        }).sort({ createdAt: -1 }).lean();
      } catch { /* non-fatal — fall through to generic info */ }

      if (unpaidOrder) {
        // Re-open the payment proof step for the existing order
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: 'ORDER',
          step:        'PAYMENT_PROOF',
          data:        { ...(session.data || {}), shortId: unpaidOrder.shortId },
        });

        const { buildPaymentInstructionsUI } = await import('../../services/paymentService.js');
        return buildPaymentInstructionsUI(
          business,
          unpaidOrder.totalPrice,
          unpaidOrder.shortId,
          unpaidOrder.paymentReference,  // use stored ref — avoids day-boundary mismatch
        );
      }

      // No pending order — show generic payment info
      const payment  = business?.payment || {};
      const waveNo   = payment.wavePhone || payment.phone || null;
      const currency = payment.currency || 'D';

      const body = waveNo
        ? `💳 *Payment Information*\n\nWe accept payment via *Wave*.\n\n📱 Send to: *${waveNo}*\n\nPlease place an order first, then send your payment screenshot here.`
        : `💳 *Payment*\n\nPlease complete your order first and we'll send you full payment instructions.`;

      const { getModeConfig } = await import('../../config/modes.js');
      const cfg = getModeConfig(business);
      return {
        type:    'buttons',
        body,
        buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }

  } // end switch

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
