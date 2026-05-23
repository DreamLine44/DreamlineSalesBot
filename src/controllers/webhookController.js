/**
 * controllers/webhookController.js — WhatSalesAgent (Merged)
 *
 * THE SINGLE MESSAGE ENTRY POINT.
 *
 * Processing order (strict):
 *   1.  De-duplicate (wamid guard)
 *   2.  Empty message guard
 *   3.  Load business config
 *   4.  Load / create session
 *   5.  Business hours enforcement          [FIX-BUG3 — was never checked]
 *   6.  Human mode guard
 *   7.  Loop prevention                     [FIX-BUG4 — was never enforced]
 *   8.  Admin command guard
 *   9.  Payment proof (image)
 *   10. DONE payment (requireProof=false gate)
 *   11. Admin button reply
 *   12. LEAD_CAPTURE active flow routing
 *   13. ENQUIRY active flow routing
 *   14. Post-flow acknowledgement
 *   15. Active flow → flowEngine.advance()
 *   16. Intent detection → module router
 *
 * [FIX-BUG3]  Hours enforcement: bot now respects business.hours.enabled — replies
 *             with a closed message outside configured hours.
 * [FIX-BUG4]  Loop prevention: loopCount is incremented per session. After 3
 *             identical consecutive messages the bot breaks the loop with the
 *             configured loopFallback message and welcomes menu buttons.
 * [FIX-BUG9]  FLOW_PASSTHROUGH_IDS — all button IDs generated inside active flows
 *             (TIME_*, QTY_*, SVC_*, SKIN_*, SIZE_*, CAKE_*, CONCERN_*, LEAD_SKIP)
 *             bypass intent detection and go straight to flowEngine.advance().
 */

import { getSession, createSession, updateSession } from '../core/sessions/sessionService.js';
import { detectIntent, extractCustomerName }         from '../core/intents/intentEngine.js';
import { advance }                                   from '../core/conversations/flowEngine.js';
import { route }                                     from '../core/conversations/moduleRouter.js';
import { dispatchMessage, dispatchText }             from '../core/whatsapp/dispatcher.js';
import { getModeConfig }                             from '../config/modes.js';
import Tenant           from '../models/Tenant.js';
import BusinessConfig   from '../models/BusinessConfig.js';
import ProcessedMessage from '../models/ProcessedMessage.js';
import logger           from '../config/logger.js';

// ── [FIX-BUG9] Button IDs generated inside active flows — must bypass intent detection
const FLOW_PASSTHROUGH_IDS = new Set([
  // Time slots
  'TIME_9AM','TIME_10AM','TIME_11AM','TIME_12PM',
  'TIME_1PM','TIME_2PM','TIME_3PM','TIME_4PM','TIME_5PM',
  // Quantity
  'QTY_1','QTY_2','QTY_3','QTY_4','QTY_5',
  // Service selection
  ...Array.from({ length: 10 }, (_, i) => `SVC_${i}`),
  // Skin type / concern
  'SKIN_DRY','SKIN_OILY','SKIN_COMBO','SKIN_CUSTOM',
  'CONCERN_ACNE','CONCERN_DARK','CONCERN_MOIST',
  // Cake
  'CAKE_VANILLA','CAKE_CHOCOLATE','CAKE_REDVELVET','CAKE_CARROT','CAKE_LEMON',
  'CAKE_SMALL','CAKE_MEDIUM','CAKE_LARGE','CAKE_XL',
  // Sizes
  'SIZE_XS','SIZE_S','SIZE_M','SIZE_L','SIZE_XL','SIZE_XXL','SIZE_FREE',
  // Date/time nav
  'DATE_BACK','TIME_BACK',
  // Lead capture
  'LEAD_SKIP',
]);

// ── [FIX-BUG3] Hours enforcement ─────────────────────────────────────────────
function isWithinBusinessHours(hours) {
  if (!hours?.enabled) return true; // hours checking disabled — always open
  try {
    const now = new Date();
    const tz  = hours.timezone || 'UTC';
    // Day-specific override
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayKey   = dayNames[now.getDay()];
    const dayConfig = hours.days?.get?.(dayKey) || hours.days?.[dayKey];
    if (dayConfig?.closed) return false;

    const openHr  = dayConfig?.open  ?? hours.open  ?? 8;
    const closeHr = dayConfig?.close ?? hours.close ?? 22;

    // Get current hour in the business timezone
    let currentHour = now.getUTCHours();
    if (tz !== 'UTC') {
      try {
        const formatter = new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', hour12: false });
        const parts = formatter.formatToParts(now);
        const hourPart = parts.find(p => p.type === 'hour');
        if (hourPart) currentHour = parseInt(hourPart.value, 10);
      } catch { /* fall back to UTC */ }
    }
    return currentHour >= openHr && currentHour < closeHr;
  } catch {
    return true; // on error, default open
  }
}

// ── [FIX-BUG4] Loop prevention ────────────────────────────────────────────────
async function checkAndHandleLoop(session, messageText, tenantId, business) {
  const MAX_LOOP = 3;
  const last     = session.lastLoopMessage;
  const step     = session.step;

  if (last === messageText && session.lastLoopStep === step) {
    const newCount = (session.loopCount || 0) + 1;
    await updateSession(session.customerPhone, tenantId, {
      loopCount: newCount, lastLoopMessage: messageText, lastLoopStep: step,
    });
    if (newCount >= MAX_LOOP) {
      // Break loop — clear flow, show menu with helpful message
      await updateSession(session.customerPhone, tenantId, {
        currentFlow: null, step: null, data: {},
        loopCount: 0, lastLoopMessage: null, lastLoopStep: null,
      });
      const cfg = getModeConfig(business);
      const loopMsg = business?.customMessages?.loopFallback
        || "I noticed we keep going in circles! Let me take you back to the main menu. 😊";
      return {
        type:    'buttons',
        body:    loopMsg,
        buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🏠 Main Menu' }],
      };
    }
  } else {
    // Different message — reset loop counter
    await updateSession(session.customerPhone, tenantId, {
      loopCount: 0, lastLoopMessage: messageText, lastLoopStep: step,
    });
  }
  return null; // no loop detected
}

// ── Message extraction ────────────────────────────────────────────────────────
function extractMessage(msgObj) {
  if (!msgObj) return { text: '', imageUrl: null, isInteractive: false, isListReply: false };
  const type = msgObj.type;

  if (type === 'text')
    return { text: (msgObj.text?.body || '').trim(), imageUrl: null, isInteractive: false, isListReply: false };

  if (type === 'interactive') {
    const btn  = msgObj.interactive?.button_reply;
    const list = msgObj.interactive?.list_reply;
    if (btn)  return { text: (btn.id  || btn.title  || '').trim(), isInteractive: true,  isListReply: false, imageUrl: null };
    if (list) return { text: (list.id || list.title || '').trim(), isInteractive: true,  isListReply: true,  imageUrl: null };
    return { text: '', isInteractive: true, isListReply: false, imageUrl: null };
  }
  if (type === 'image')
    return { text: '', imageUrl: msgObj.image?.id || null, isInteractive: false, isListReply: false };
  if (type === 'button')
    return { text: (msgObj.button?.payload || '').trim(), isInteractive: true, isListReply: false, imageUrl: null };

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
      if (err.code === 11000) { logger.debug('[Webhook] Duplicate wamid', { wamid }); return; }
    }
  }

  // ── 2. Empty guard ────────────────────────────────────────────────────────
  if (!messageText && !imageUrl) return;

  // ── 3. Load business ──────────────────────────────────────────────────────
  const business = await BusinessConfig.findOne({ tenantId }).lean().catch(() => null);
  if (!business) { logger.warn('[Webhook] No business config', { tenantId }); return; }

  // ── 4. Session ────────────────────────────────────────────────────────────
  let session = await getSession(from, tenantId);
  if (!session) {
    session = await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
    session = await getSession(from, tenantId) || session;
  }
  updateSession(from, tenantId, {
    lastSeen:      new Date(),
    messageCount:  (session.messageCount || 0) + 1,
    phoneNumberId: phoneNumberId || session.phoneNumberId,
  }).catch(() => {});

  // ── 5. [FIX-BUG3] Business hours enforcement ──────────────────────────────
  if (messageText && !isWithinBusinessHours(business.hours)) {
    const closedMsg = business?.customMessages?.closed
      || business?.settings?.closedMessage
      || `⏰ We're currently closed. Please contact us during business hours.`;
    // Only reply once per closed period — guard against spam
    if (!session.closedMsgSent) {
      await updateSession(from, tenantId, { closedMsgSent: true });
      await dispatchMessage(from, { type: 'text', body: closedMsg }, tenantDoc);
    }
    return;
  }
  // Clear closedMsgSent once we're open again
  if (session.closedMsgSent) {
    updateSession(from, tenantId, { closedMsgSent: false }).catch(() => {});
  }

  // ── 6. Human mode ─────────────────────────────────────────────────────────
  if (session.humanMode) {
    logger.info('[Webhook] Human mode — bot silent', { from });
    return;
  }

  // ── 7. [FIX-BUG4] Loop prevention (only on text, not buttons) ─────────────
  if (messageText && !isInteractive) {
    const loopReply = await checkAndHandleLoop(session, messageText, tenantId, business);
    if (loopReply) {
      await dispatchMessage(from, loopReply, tenantDoc);
      return;
    }
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
        // [FIX-BUG2] Pass tenantDoc so resumeBot can notify the customer
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
      await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: 'ORDER' });
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
    const reply = await handleDonePayment(from, tenantId).catch(() => "✅ Thank you! We'll confirm your order shortly.");
    await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc);
    await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: 'ORDER' });
    return;
  }

  // ── 11. Admin button reply (APPROVE_xxx / REJECT_xxx / CONFIRM_BOOK_xxx) ──
  if (isInteractive && (
    messageText.startsWith('APPROVE_') || messageText.startsWith('REJECT_')  ||
    messageText.startsWith('CONFIRM_BOOK_') || messageText.startsWith('DECLINE_BOOK_')
  )) {
    const { handleAdminButtonReply, isAdminPhone } = await import('../services/adminCommandService.js');
    const isAdmin = await isAdminPhone(from, tenantId).catch(() => false);
    if (isAdmin) {
      const reply = await handleAdminButtonReply(messageText, tenantId, from, tenantDoc, business).catch(() => null);
      if (reply) { await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc); return; }
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
      const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
      const aiText = await getAIReply({ customerMessage: messageText, business, session, intent: 'QUESTION' });
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
    await updateSession(from, tenantId, { currentFlow: null, step: null });
  }

  // ── 14. Post-flow acknowledgement ────────────────────────────────────────
  if (session.postFlowAck && messageText) {
    const ACK_RE = /^(ok|okay|k|kk|thanks|thank you|thank u|thx|ty|tq|great|perfect|got it|noted|alright|cool|nice|sounds good|good|👍|🙏|😊|yep|yh|yah|understood|cheers|appreciate it|brilliant|wonderful|awesome|lovely)$/i;
    if (ACK_RE.test(messageText.trim())) {
      const completed = session.postFlowAck;
      const custName  = session.customerName ? `, ${session.customerName}` : '';
      const cfg       = getModeConfig(business);
      const canOrder  = cfg.flows?.includes('ORDER');
      const canBook   = cfg.flows?.includes('BOOKING');

      const body = completed === 'BOOKING'
        ? `You're welcome${custName}! 😊 Your booking is confirmed. Anything else we can help with?`
        : `You're welcome${custName}! 😊 We're preparing your order. Anything else we can help with at *${business.name || 'us'}*?`;

      const buttons = [
        canOrder ? { id: 'ORDER',    title: '🛍 Place Another Order' } : null,
        canBook  ? { id: 'BOOK',     title: '📅 Make a Booking'      } : null,
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ].filter(Boolean).slice(0, 3);

      await updateSession(from, tenantId, { postFlowAck: null });
      await dispatchMessage(from, { type: 'buttons', body, buttons }, tenantDoc);
      return;
    }
    await updateSession(from, tenantId, { postFlowAck: null });
  }

  // ── 15. Active flow ───────────────────────────────────────────────────────
  if (session.currentFlow) {
    if (isListReply && session.currentFlow === 'ORDER' && !session.menuViewed) {
      await updateSession(from, tenantId, { menuViewed: true });
      session = { ...session, menuViewed: true };
    }

    // [FIX-BUG9] Flow-internal button IDs — bypass intent detection entirely
    const upperMsg = messageText.trim().toUpperCase();
    if (isInteractive && FLOW_PASSTHROUGH_IDS.has(upperMsg)) {
      const freshSession = await getSession(from, tenantId) || session;
      const reply = await advance({ session: freshSession, message: messageText, business, tenant: tenantDoc, isInteractive });
      if (reply) {
        await dispatchMessage(from, reply, tenantDoc);
        const body = typeof reply === 'string' ? reply : reply?.body;
        if (body) updateSession(from, tenantId, { lastBotMessage: body }).catch(() => {});
      }
      return;
    }

    // Global escape intents
    if (upperMsg === 'CANCEL' || upperMsg === 'CANCEL_BOOKING') {
      const { cancelFlow } = await import('../core/conversations/flowEngine.js');
      const reply = await cancelFlow(session, business);
      await dispatchMessage(from, reply, tenantDoc);
      return;
    }
    if (upperMsg === '0' || upperMsg === 'SHOW_MENU' || upperMsg === 'MENU' || upperMsg === 'HOME') {
      await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: null });
      const cfg = getModeConfig(business);
      const customWelcome = business?.customMessages?.welcomeMessage;
      await dispatchMessage(from, {
        type:    'buttons',
        body:    customWelcome || cfg.messages?.welcome || '👋 What would you like to do?',
        buttons: cfg.ui?.welcomeButtons || [],
      }, tenantDoc);
      return;
    }

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

  // ── 16. Intent → module router ────────────────────────────────────────────
  const extractedName = extractCustomerName(messageText);
  if (extractedName && !session.customerName) {
    updateSession(from, tenantId, { customerName: extractedName }).catch(() => {});
    session = { ...session, customerName: extractedName };
  }

  const { action, intent, confidence, suggestion } = await detectIntent({
    message: messageText, isInteractive, session, business,
  });

  logger.debug('[Webhook] Intent', { action, intent, confidence, from });

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
  res.sendStatus(200);
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
            const tenant = await Tenant.findOne({ 'whatsapp.phoneNumberId': phoneNumberId, status: 'ACTIVE' }).lean();
            if (!tenant) continue;
            await handleIncomingMessage({
              tenantId: String(tenant._id), tenantDoc: tenant,
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
