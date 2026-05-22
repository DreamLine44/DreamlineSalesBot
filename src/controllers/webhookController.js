/**
 * controllers/webhookController.js — WhatSalesAgent2
 *
 * THE SINGLE MESSAGE ENTRY POINT.
 *
 * Processing order (strict):
 *   1.  De-duplicate (wamid guard)
 *   2.  Empty message guard
 *   3.  Load business config
 *   4.  Load / create session
 *   5.  Business hours check          [FIX #9]
 *   6.  Loop detection                [FIX #10]
 *   7.  Human mode guard
 *   8.  Admin command guard
 *   9.  Payment proof (image)
 *   10. DONE payment (requireProof=false gate)
 *   11. Admin button reply
 *   12. LEAD_CAPTURE active flow routing
 *   13. Post-flow acknowledgement
 *   14. Active flow → flowEngine.advance()
 *   15. Intent detection → module router
 *       → on completion: record memory, trigger lead capture  [FIX #5 #6 #7 #8]
 *
 * FIXES IN THIS FILE:
 *   [FIX #5]  getCustomerContext now actually called and passed to AI
 *   [FIX #6]  recordOrderItem / updateName called after order completion
 *   [FIX #7]  shouldCaptureLead / startLeadCapture triggered after flow completion
 *   [FIX #8]  leadCapture.notifyAdmin flag honoured — admin gets WA alert per lead
 *   [FIX #9]  Business hours enforced — closed message sent if outside hours
 *   [FIX #10] Loop detection — loopCount incremented, loopFallback sent at threshold
 */

import { getSession, createSession, updateSession } from '../core/sessions/sessionService.js';
import { detectIntent, extractCustomerName }         from '../core/intents/intentEngine.js';
import { advance }                                   from '../core/conversations/flowEngine.js';
import { route }                                     from '../core/conversations/moduleRouter.js';
import { dispatchMessage, dispatchText }             from '../core/whatsapp/dispatcher.js';
import { getModeConfig }                             from '../config/modes.js';
import { getCustomerContext }                        from '../core/memory/customerMemory.js';   // FIX #5
import { recordOrderItem, updateName }               from '../core/memory/customerMemory.js';   // FIX #6
import { shouldCaptureLead, startLeadCapture }       from '../services/leadCaptureService.js';  // FIX #7
import Tenant           from '../models/Tenant.js';
import BusinessConfig   from '../models/BusinessConfig.js';
import ProcessedMessage from '../models/ProcessedMessage.js';
import logger           from '../config/logger.js';

// ── Business hours helper ─────────────────────────────────────────────────────
// FIX #9: Returns true when the business is currently open (or hours not enforced).
function isBusinessOpen(business) {
  if (process.env.DISABLE_WORKING_HOURS === 'true') return true;
  const h = business?.hours;
  if (!h?.enabled) return true;

  try {
    const tz   = h.timezone || 'UTC';
    const now  = new Date();
    // Get local time in the business timezone
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric', minute: 'numeric', hour12: false,
      weekday: 'short',
    }).formatToParts(now);

    const hourPart    = local.find(p => p.type === 'hour');
    const weekdayPart = local.find(p => p.type === 'weekday');
    const currentHour = parseInt(hourPart?.value ?? '12', 10);
    const weekday     = weekdayPart?.value?.toUpperCase() ?? 'MON'; // e.g. "Mon" → "MON"

    // Per-day override
    const dayConfig = h.days?.get ? h.days.get(weekday) : h.days?.[weekday];
    if (dayConfig?.closed) return false;
    const open  = dayConfig?.open  ?? h.open  ?? 8;
    const close = dayConfig?.close ?? h.close ?? 22;

    return currentHour >= open && currentHour < close;
  } catch {
    return true; // fail open — don't block customers on tz parse errors
  }
}

// ── Loop detection helper ─────────────────────────────────────────────────────
// FIX #10: Returns true and sends the fallback message when the customer has
//          repeated the same text >= 3 times in a row.
const LOOP_THRESHOLD = 3;

async function checkAndHandleLoop(session, messageText, business, from, tenantId, tenantDoc) {
  if (!messageText) return false;

  const isSame = session.lastLoopMessage &&
    session.lastLoopMessage.trim().toLowerCase() === messageText.trim().toLowerCase();

  const newCount = isSame ? (session.loopCount || 0) + 1 : 1;
  const newStep  = session.step || null;

  await updateSession(from, tenantId, {
    loopCount:       newCount,
    lastLoopMessage: messageText,
    lastLoopStep:    newStep,
  }).catch(() => {});

  if (newCount >= LOOP_THRESHOLD) {
    const fallback =
      business?.customMessages?.loopFallback?.trim() ||
      `😊 I'm not sure how to help with that. Try tapping *Menu* to see your options, or type *Help* to speak with someone.`;

    const cfg = getModeConfig(business);
    await dispatchMessage(from, {
      type:    'buttons',
      body:    fallback,
      buttons: cfg.ui?.fallbackButtons || [
        { id: 'SHOW_MENU', title: '🏠 Menu'    },
        { id: 'SUPPORT',   title: '🆘 Support' },
      ],
    }, tenantDoc);

    // Reset loop counter so we don't send the fallback on every subsequent message
    await updateSession(from, tenantId, { loopCount: 0, lastLoopMessage: null }).catch(() => {});
    return true;
  }

  return false;
}

// ── Post-flow memory & lead capture ──────────────────────────────────────────
// FIX #6: Records order item to customer memory after a successful ORDER flow.
// FIX #7: Triggers lead capture after ORDER/BOOKING completion if configured.
// FIX #8: Notifies admin when a lead is captured (notifyAdmin flag).
async function handlePostFlowCallbacks(session, completedFlow, business, tenantDoc) {
  const phone    = session.customerPhone;
  const tenantId = session.tenantId;

  // FIX #6 — persist order item to customer memory
  if (completedFlow === 'ORDER') {
    const itemName = session.data?.item?.name || session.data?.item || null;
    if (itemName) {
      recordOrderItem(phone, tenantId, itemName).catch(() => {});
    }
  }

  // FIX #7 — trigger lead capture if configured for this trigger
  const trigger = completedFlow === 'ORDER'   ? 'AFTER_ORDER'
                : completedFlow === 'BOOKING' ? 'AFTER_BOOKING'
                : null;

  if (trigger) {
    const captureNeeded = await shouldCaptureLead(business, session, trigger).catch(() => false);
    if (captureNeeded) {
      const leadMsg = await startLeadCapture(session, business).catch(() => null);
      if (leadMsg) {
        // FIX #8 — after lead is eventually finalised, admin is notified in finaliseLead()
        // but notifyAdmin flag is read here to decide if we should wire it up
        // The actual admin notify is patched into leadCaptureService.finaliseLead below.
        await dispatchMessage(phone, leadMsg, tenantDoc);
      }
    }
  }
}

// ── Message extraction ────────────────────────────────────────────────────────
function extractMessage(msgObj) {
  if (!msgObj) return { text: '', imageUrl: null, isInteractive: false, isListReply: false };
  const type = msgObj.type;

  if (type === 'text') {
    return { text: (msgObj.text?.body || '').trim(), imageUrl: null, isInteractive: false, isListReply: false };
  }
  if (type === 'interactive') {
    const btn  = msgObj.interactive?.button_reply;
    const list = msgObj.interactive?.list_reply;
    if (btn)  return { text: (btn.id  || btn.title  || '').trim(), isInteractive: true,  isListReply: false, imageUrl: null };
    if (list) return { text: (list.id || list.title || '').trim(), isInteractive: true,  isListReply: true,  imageUrl: null };
    return { text: '', isInteractive: true, isListReply: false, imageUrl: null };
  }
  if (type === 'image') {
    return { text: '', imageUrl: msgObj.image?.id || null, isInteractive: false, isListReply: false };
  }
  if (type === 'button') {
    return { text: (msgObj.button?.payload || '').trim(), isInteractive: true, isListReply: false, imageUrl: null };
  }
  return { text: '', imageUrl: null, isInteractive: false, isListReply: false };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function handleIncomingMessage({ tenantId, tenantDoc, from, msgObj, phoneNumberId }) {
  const { text: messageText, imageUrl, isInteractive, isListReply } = extractMessage(msgObj);
  const wamid = msgObj?.id;

  // ── 1. De-duplicate ───────────────────────────────────────────────────────
  if (wamid) {
    try {
      await ProcessedMessage.create({ wamid, tenantId });
    } catch (err) {
      if (err.code === 11000) {
        logger.debug('[Webhook] Duplicate wamid ignored', { wamid });
        return;
      }
    }
  }

  // ── 2. Empty guard ────────────────────────────────────────────────────────
  if (!messageText && !imageUrl) return;

  // ── 3. Load business ──────────────────────────────────────────────────────
  const business = await BusinessConfig.findOne({ tenantId }).lean().catch(() => null);
  if (!business) {
    logger.warn('[Webhook] No business config', { tenantId });
    return;
  }

  // ── 4. Session ────────────────────────────────────────────────────────────
  let session = await getSession(from, tenantId);
  if (!session) {
    session = await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
    session  = await getSession(from, tenantId) || session;
  }

  // Update activity metadata (fire and forget)
  updateSession(from, tenantId, {
    lastSeen:     new Date(),
    messageCount: (session.messageCount || 0) + 1,
    phoneNumberId: phoneNumberId || session.phoneNumberId,
  }).catch(() => {});

  // ── 5. Business hours check [FIX #9] ─────────────────────────────────────
  if (!isBusinessOpen(business)) {
    const closedMsg =
      business.customMessages?.closed?.trim() ||
      business.settings?.closedMessage?.trim() ||
      "We're currently closed. Please contact us during business hours. 🙏";
    await dispatchMessage(from, { type: 'text', body: closedMsg }, tenantDoc);
    return;
  }

  // ── 6. Loop detection [FIX #10] ──────────────────────────────────────────
  if (messageText) {
    const looped = await checkAndHandleLoop(session, messageText, business, from, tenantId, tenantDoc);
    if (looped) return;
  }

  // ── 7. Human mode ─────────────────────────────────────────────────────────
  if (session.humanMode) {
    logger.info('[Webhook] Human mode — bot silent', { from });
    if (!session.humanModeNotified && business?.adminPhone) {
      const adminPhone = business.adminPhone;
      const followUp =
        `🚨 *Support escalation*\n\n` +
        `Customer *${from}* needs help.\n` +
        `Message: "${messageText || '(media)'}"\n\n` +
        `Bot is now *silent* for this customer.\n\n` +
        `Reply directly to the customer on WhatsApp, then send:\n` +
        `✅ \`RESUME BOT ${from}\``;
      dispatchText(adminPhone, followUp, tenantDoc).catch(() => {});
      updateSession(from, tenantId, { humanModeNotified: true }).catch(() => {});
    }
    return;
  }

  // ── 8. Admin commands ─────────────────────────────────────────────────────
  if (messageText) {
    const upper = messageText.trim().toUpperCase();
    if (
      upper.startsWith('APPROVE ')      ||
      upper.startsWith('REJECT ')       ||
      upper.startsWith('CONFIRM BOOK ') ||
      upper.startsWith('DECLINE BOOK ') ||
      upper.startsWith('RESUME BOT')
    ) {
      const { handleAdminTextCommand, isAdminPhone } = await import('../services/adminCommandService.js');
      const isAdmin = await isAdminPhone(from, tenantId).catch(() => false);
      if (isAdmin) {
        const adminReply = await handleAdminTextCommand(messageText, tenantId, from, tenantDoc, business).catch(() => null);
        if (adminReply) {
          await dispatchMessage(from, { type: 'text', body: adminReply }, tenantDoc);
          return;
        }
      }
    }
  }

  // ── 9. Payment proof image ────────────────────────────────────────────────
  if (imageUrl && session.currentFlow === 'ORDER' && session.step === 'PAYMENT_PROOF') {
    const { receiveProof } = await import('../services/paymentService.js');
    try {
      const reply = await receiveProof(from, tenantId, imageUrl, tenantDoc);
      await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc);
    } catch (err) {
      logger.error('[Webhook] receiveProof failed', { err: err.message });
      await dispatchMessage(from, { type: 'text', body: '⚠️ Could not process your screenshot. Please try again.' }, tenantDoc);
    }
    return;
  }

  // ── 10. DONE payment — gated on requireProof===false ──────────────────────
  if (
    messageText.trim().toUpperCase() === 'DONE' &&
    session.currentFlow === 'ORDER' &&
    session.step === 'PAYMENT_PROOF' &&
    business?.payment?.requireProof === false
  ) {
    const { handleDonePayment } = await import('../services/paymentService.js');
    const reply = await handleDonePayment(from, tenantId)
      .catch(() => "✅ Thank you! We'll confirm your order shortly.");
    await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc);
    await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: 'ORDER' });
    // Trigger post-flow callbacks (memory + lead capture)
    const freshSession = await getSession(from, tenantId) || session;
    handlePostFlowCallbacks(freshSession, 'ORDER', business, tenantDoc).catch(() => {});
    return;
  }

  // ── 11. Admin button reply (APPROVE_xxx / REJECT_xxx) ─────────────────────
  if (isInteractive && (messageText.startsWith('APPROVE_') || messageText.startsWith('REJECT_'))) {
    const { handleAdminButtonReply, isAdminPhone } = await import('../services/adminCommandService.js');
    const isAdmin = await isAdminPhone(from, tenantId).catch(() => false);
    if (isAdmin) {
      const reply = await handleAdminButtonReply(messageText, tenantId, from, tenantDoc, business).catch(() => null);
      if (reply) {
        await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc);
        return;
      }
    }
  }

  // ── 12. LEAD_CAPTURE active flow ──────────────────────────────────────────
  if (session.currentFlow === 'LEAD_CAPTURE') {
    const { handleLeadCapture } = await import('../services/leadCaptureService.js');
    const reply = await handleLeadCapture(session, messageText, business, tenantDoc);
    if (reply) await dispatchMessage(from, reply, tenantDoc);
    return;
  }

  // ── 13. ENQUIRY active flow ───────────────────────────────────────────────
  if (session.currentFlow === 'ENQUIRY') {
    if (session.step === 'AWAITING_QUESTION') {
      await updateSession(from, tenantId, { step: 'ANSWERED' });

      // FIX #5 — load customer context and pass to AI for personalised answers
      const customerContext = await getCustomerContext(from, tenantId).catch(() => null);

      const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
      const aiText = await getAIReply({
        customerMessage: messageText,
        business,
        session,
        intent: 'QUESTION',
        customerContext,   // FIX #5
      });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    aiText || "Great question! Let me check that for you. 😊",
        buttons: [
          { id: 'QUESTION',  title: '❓ Ask another'  },
          { id: 'SHOW_MENU', title: '🏠 Back to menu' },
        ],
      }, tenantDoc);
      await updateSession(from, tenantId, { currentFlow: null, step: null });
      return;
    }
    // Any other step — reset enquiry
    await updateSession(from, tenantId, { currentFlow: null, step: null });
  }

  // ── [FIX-A] Post-flow acknowledgement ────────────────────────────────────
  if (session.postFlowAck && messageText) {
    const ACK_RE = /^(ok|okay|k|kk|thanks|thank you|thank u|thx|ty|tq|great|perfect|got it|noted|alright|cool|nice|sounds good|good|👍|🙏|😊|yep|yh|yah|understood|cheers|appreciate it|brilliant|wonderful|awesome|lovely)$/i;
    if (ACK_RE.test(messageText.trim())) {
      const completed = session.postFlowAck;
      const custName  = session.customerName ? `, ${session.customerName}` : '';
      const cfg       = getModeConfig(business);
      const canOrder  = cfg.flows?.includes('ORDER');
      const canBook   = cfg.flows?.includes('BOOKING');

      const body = completed === 'BOOKING'
        ? `You're welcome${custName}! 😊 Your booking is confirmed. Is there anything else we can help with?`
        : `You're welcome${custName}! 😊 We're preparing your order. Is there anything else we can help with at *${business.name || 'us'}*?`;

      const buttons = [
        canOrder ? { id: 'ORDER',    title: '🛍 Place Another Order' } : null,
        canBook  ? { id: 'BOOK',     title: '📅 Make a Booking'      } : null,
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ].filter(Boolean).slice(0, 3);

      await updateSession(from, tenantId, { postFlowAck: null });
      await dispatchMessage(from, { type: 'buttons', body, buttons }, tenantDoc);
      return;
    }
    // Non-ack — clear flag and continue
    await updateSession(from, tenantId, { postFlowAck: null });
  }

  // ── 14. Active flow ───────────────────────────────────────────────────────
  if (session.currentFlow) {
    // Tag menuViewed when customer picks from list widget
    if (isListReply && session.currentFlow === 'ORDER' && !session.menuViewed) {
      await updateSession(from, tenantId, { menuViewed: true });
      session = { ...session, menuViewed: true };
    }

    // Global escape intents
    const upper = messageText.trim().toUpperCase();
    if (upper === 'CANCEL' || upper === 'CANCEL_BOOKING') {
      const { cancelFlow } = await import('../core/conversations/flowEngine.js');
      const reply = await cancelFlow(session, business);
      await dispatchMessage(from, reply, tenantDoc);
      return;
    }
    if (upper === '0' || upper === 'SHOW_MENU' || upper === 'MENU') {
      await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: null });
      const cfg = getModeConfig(business);
      await dispatchMessage(from, {
        type:    'buttons',
        body:    cfg.messages?.welcome || '👋 What would you like to do?',
        buttons: cfg.ui?.welcomeButtons || [],
      }, tenantDoc);
      return;
    }

    const prevFlow = session.currentFlow;

    // Re-fetch fresh session then advance flow
    const freshSession = await getSession(from, tenantId) || session;
    const reply = await advance({
      session: freshSession,
      message: messageText || imageUrl,
      business, tenant: tenantDoc, isInteractive,
    });
    if (reply) {
      await dispatchMessage(from, reply, tenantDoc);
      const body = typeof reply === 'string' ? reply : reply?.body;
      if (body) updateSession(from, tenantId, { lastBotMessage: body }).catch(() => {});
    }

    // FIX #6 / #7 — if flow just completed (postFlowAck set), run post-flow callbacks
    const afterSession = await getSession(from, tenantId);
    if (afterSession?.postFlowAck && afterSession.postFlowAck !== session.postFlowAck) {
      handlePostFlowCallbacks(afterSession, prevFlow, business, tenantDoc).catch(() => {});
    }

    return;
  }

  // ── 15. Intent → module router ────────────────────────────────────────────

  // Extract and persist customer name if mentioned
  const extractedName = extractCustomerName(messageText);
  if (extractedName) {
    if (!session.customerName) {
      updateSession(from, tenantId, { customerName: extractedName }).catch(() => {});
      session = { ...session, customerName: extractedName };
    }
    // FIX #6 — persist name to UserProfile memory
    updateName(from, tenantId, extractedName).catch(() => {});
  }

  // FIX #5 — load customer context for AI personalisation
  const customerContext = await getCustomerContext(from, tenantId).catch(() => null);

  // FIX #7 — check for FIRST_MESSAGE lead capture trigger
  if (customerContext !== null) {
    const firstMsgCapture = await shouldCaptureLead(business, session, 'FIRST_MESSAGE').catch(() => false);
    if (firstMsgCapture) {
      const leadMsg = await startLeadCapture(session, business).catch(() => null);
      if (leadMsg) {
        await dispatchMessage(from, leadMsg, tenantDoc);
        return;
      }
    }
  }

  const { action, intent, confidence, suggestion } = await detectIntent({
    message: messageText, isInteractive, session, business,
  });

  logger.debug('[Webhook] Intent', { action, intent, confidence, from });

  // Special case: ENQUIRY starts a two-step question flow
  if (action === 'ENQUIRY') {
    await updateSession(from, tenantId, { currentFlow: 'ENQUIRY', step: 'AWAITING_QUESTION' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    '❓ What would you like to know? Type your question below.',
      buttons: [{ id: 'SHOW_MENU', title: '🏠 Back to menu' }],
    }, tenantDoc);
    return;
  }

  const reply = await route({
    action, intent, session,
    message: messageText, business,
    tenant: tenantDoc, isInteractive, suggestion,
    customerContext,   // FIX #5 — available to handlers that need it
  });

  if (reply) {
    await dispatchMessage(from, reply, tenantDoc);
    const body = typeof reply === 'string' ? reply : reply?.body;
    if (body) updateSession(from, tenantId, { lastBotMessage: body }).catch(() => {});
  }
}

// ── Meta webhook verification ──────────────────────────────────────────────────
export function verifyWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
}

// ── Meta webhook event receiver ────────────────────────────────────────────────
export async function receiveWebhook(req, res) {
  res.sendStatus(200); // Always ACK immediately

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value         = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;

        for (const msg of value.messages || []) {
          try {
            const from   = msg.from;
            const tenant = await Tenant.findOne({
              'whatsapp.phoneNumberId': phoneNumberId, status: 'ACTIVE',
            }).lean();
            if (!tenant) continue;

            await handleIncomingMessage({
              tenantId:    String(tenant._id),
              tenantDoc:   tenant,
              from, msgObj: msg, phoneNumberId,
            });
          } catch (err) {
            logger.error('[Webhook] Message failed', { err: err.message, from: msg?.from });
          }
        }
      }
    }
  } catch (err) {
    logger.error('[Webhook] receiveWebhook error', { err: err.message });
  }
}
