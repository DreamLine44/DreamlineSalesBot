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
import { generateGreeting }      from '../ai/providers/aiRouter.js';
import { dispatchText }          from '../whatsapp/dispatcher.js';
import { getModeConfig }         from '../../config/modes.js';
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
      const existingName = session?.customerName || null;
      const lastOrder    = session?.data?.lastItem || null;

      let greetMsg = null;
      if (existingName) {
        try {
          const g = await generateGreeting({ business, customerName: existingName, lastOrder });
          greetMsg = g;
        } catch { /* non-fatal */ }
      }

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
          `Reply directly to them on WhatsApp, then type:\n` +
          `✅ \`RESUME BOT ${session.customerPhone}\``;
        // [FIX-RTR-4] Log dispatch failures — if this silently fails the admin is
        // never notified of the escalation and there is no trace in logs to diagnose it.
        // Consistent with adminCommandService which logs all customer dispatch failures.
        dispatchText(adminPhone, alert, tenant).catch(err =>
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
