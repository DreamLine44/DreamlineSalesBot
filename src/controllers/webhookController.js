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
 *   5.  Human mode guard
 *   6.  Admin command guard
 *   7.  Payment proof (image)
 *   8.  DONE payment (requireProof=false gate — FIX)
 *   9.  Admin button reply
 *   10. LEAD_CAPTURE active flow routing
 *   11. Post-flow acknowledgement (FIX-A — postFlowAck)
 *   12. Active flow → flowEngine.advance()
 *   13. Intent detection → module router
 *
 * ALL BUGS FIXED:
 *   [FIX-A] postFlowAck — warm ack, no menu dump after completion
 *   [FIX-B] Past-date validation with ordinal stripping (in bookingFlow)
 *   [FIX-C] menuViewed guard — number only trusted after menu opened
 *   [FIX]   getAIReply named-object signature (via aiRouter)
 *   [FIX]   resolveFaq correct arg order (in groqProvider)
 *   [FIX]   $exists:false → null in scheduler
 *   [FIX]   DONE payment gated on requireProof===false
 *   [FIX]   customerName preserved on GREET (in moduleRouter)
 *   [FIX]   trackRevenue includes tenantId (in analyticsService)
 *   [FIX]   buildAdminBookingAlert includes shortId (in adminCommandService)
 *   [FIX]   clearSession before leadCapture — fixed via postFlowAck keeping session alive
 */

import { getSession, createSession, updateSession } from '../core/sessions/sessionService.js';
import { detectIntent, extractCustomerName }         from '../core/intents/intentEngine.js';
import { advance }                                   from '../core/conversations/flowEngine.js';
import { route }                                     from '../core/conversations/moduleRouter.js';
import { dispatchMessage, dispatchText }             from '../core/whatsapp/dispatcher.js';
import { getModeConfig }                             from '../config/modes.js';
import { getCustomerContext }                        from '../core/memory/customerMemory.js';
import Tenant           from '../models/Tenant.js';
import BusinessConfig   from '../models/BusinessConfig.js';
import ProcessedMessage from '../models/ProcessedMessage.js';
import logger           from '../config/logger.js';

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
    // [FIX-C] list_reply = customer tapped from the WhatsApp list widget → trust numeric pick
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
  // tenantId is always known at this point (resolved from Tenant.whatsapp.phoneNumberId above).
  // The $or with phoneNumberId was redundant — it's already on the Tenant doc, not BusinessConfig.
  const business = await BusinessConfig.findOne({ tenantId }).lean().catch(() => null);

  if (!business) {
    logger.warn('[Webhook] No business config', { tenantId });
    return;
  }

  // ── 3b. Business hours check ──────────────────────────────────────────────
  if (business.hours?.enabled && process.env.DISABLE_WORKING_HOURS !== 'true') {
    const now  = new Date();
    const tz   = business.hours.timezone || 'UTC';
    try {
      const local    = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const dayKey   = dayNames[local.getDay()];
      const dayConf  = business.hours.days?.get ? business.hours.days.get(dayKey) : business.hours.days?.[dayKey];
      const closed   = dayConf?.closed === true;
      const openH    = dayConf?.open  ?? business.hours.open  ?? 8;
      const closeH   = dayConf?.close ?? business.hours.close ?? 22;
      const hour     = local.getHours();
      if (closed || hour < openH || hour >= closeH) {
        const closedMsg = business.customMessages?.closed ||
          business.settings?.closedMessage ||
          "We're currently closed. Please contact us during business hours.";
        await dispatchMessage(from, { type: 'text', body: closedMsg }, tenantDoc);
        return;
      }
    } catch (err) {
      logger.warn('[Webhook] Hours check failed (non-fatal)', { err: err.message });
    }
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

  // ── 4b. Loop prevention ───────────────────────────────────────────────────
  // Detect customer sending the exact same message 3+ times consecutively
  if (messageText && messageText === session.lastLoopMessage && session.step === session.lastLoopStep) {
    const loopCount = (session.loopCount || 0) + 1;
    await updateSession(from, tenantId, { loopCount, lastLoopMessage: messageText, lastLoopStep: session.step });
    if (loopCount >= 3) {
      await updateSession(from, tenantId, { loopCount: 0, lastLoopMessage: null, humanMode: true, humanModeNotified: false });
      const loopMsg = business.customMessages?.loopFallback ||
        "I'm having trouble understanding. Let me connect you with our team. 🆘";
      await dispatchMessage(from, { type: 'text', body: loopMsg }, tenantDoc);
      // Notify admin
      if (business.adminPhone) {
        dispatchText(business.adminPhone,
          `🚨 *Support escalation*

Customer *${from}* is stuck in a loop.
Message: "${messageText}"

Bot is now silent.
\`RESUME BOT ${from}\``,
          tenantDoc).catch(() => {});
      }
      return;
    }
  } else if (messageText) {
    updateSession(from, tenantId, { loopCount: 0, lastLoopMessage: messageText, lastLoopStep: session.step || null }).catch(() => {});
  }

  // ── 5. Human mode ─────────────────────────────────────────────────────────
  if (session.humanMode) {
    logger.info('[Webhook] Human mode — bot silent', { from });

    // Send admin a follow-up alert if customer messages again and admin hasn't been re-notified
    // (humanModeNotified is set to true on first escalation; reset when RESUME BOT is sent)
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

  // ── 6. Admin commands ─────────────────────────────────────────────────────
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

  // ── 7. Payment proof image ────────────────────────────────────────────────
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

  // ── 8. DONE payment — [FIX] gated on requireProof===false ────────────────
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
    return;
  }

  // ── 9. Admin button reply (APPROVE_xxx / REJECT_xxx) ─────────────────────
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

  // ── 10. LEAD_CAPTURE active flow ──────────────────────────────────────────
  if (session.currentFlow === 'LEAD_CAPTURE') {
    const { handleLeadCapture } = await import('../services/leadCaptureService.js');
    const reply = await handleLeadCapture(session, messageText, business, tenantDoc);
    if (reply) await dispatchMessage(from, reply, tenantDoc);
    return;
  }

  // ── 11. ENQUIRY active flow ───────────────────────────────────────────────
  if (session.currentFlow === 'ENQUIRY') {
    // Two-step: 1st message = question, 2nd = AI answers
    if (session.step === 'AWAITING_QUESTION') {
      await updateSession(from, tenantId, { step: 'ANSWERED' });
      const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
      const aiText = await getAIReply({ customerMessage: messageText, business, session, intent: 'QUESTION' });
      const cfg    = getModeConfig(business);
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

  // ── 12. Active flow ───────────────────────────────────────────────────────
  if (session.currentFlow) {
    // [FIX-C] Tag menuViewed when customer picks from list widget
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
    return;
  }

  // ── 13. Intent → module router ────────────────────────────────────────────

  // Load customer memory — enriches session with known name + top item for personalisation
  let customerCtx = null;
  try { customerCtx = await getCustomerContext(from, tenantId); } catch (_) {}
  if (customerCtx?.name && !session.customerName) {
    updateSession(from, tenantId, { customerName: customerCtx.name }).catch(() => {});
    session = { ...session, customerName: customerCtx.name };
  }
  if (customerCtx) session._customerCtx = customerCtx; // transient, used this request only

  // Extract customer name if mentioned in this message
  const extractedName = extractCustomerName(messageText);
  if (extractedName && !session.customerName) {
    updateSession(from, tenantId, { customerName: extractedName }).catch(() => {});
    const { updateName } = await import('../core/memory/customerMemory.js');
    updateName(from, tenantId, extractedName).catch(() => {});
    session = { ...session, customerName: extractedName };
  }

  const { action, intent, confidence, suggestion } = await detectIntent({
    message: messageText, isInteractive, session, business,
  });

  logger.debug('[Webhook] Intent', { action, intent, confidence, from });

  // CONTINUE_FLOW with no active flow — do nothing (already handled above in step 12)
  // This can fire for numeric inputs outside of a flow; show menu gently.
  if (action === 'CONTINUE_FLOW') {
    const cfg = getModeConfig(business);
    await dispatchMessage(from, {
      type:    'buttons',
      body:    cfg.messages?.welcome || '👋 What would you like to do?',
      buttons: cfg.ui?.welcomeButtons || [],
    }, tenantDoc);
    return;
  }

  // Special case: ENQUIRY starts a two-step question flow
  if (action === 'ENQUIRY') {
    const cfg = getModeConfig(business);
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
