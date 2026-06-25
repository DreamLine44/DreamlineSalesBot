/**
 * services/postFlowHandler.js — WhatSalesAgent
 *
 * Extracted postFlowAck state machine, previously embedded inline in webhookController.js
 * (lines ~1021–1540, ~600 lines of inline logic).
 *
 * Handles customer messages that arrive AFTER an order or booking has reached a
 * terminal admin-set state (confirmed, rejected, ready, booking confirmed/declined).
 *
 * [PFH-1] Extracted from webhookController to make each state independently testable
 *         and to eliminate the regression risk of a single 1,942-line controller.
 * [PFH-2] postFlowAck unknown-ctx fallback: if ackCtx contains an unexpected value
 *         (stale session, future state, bug), clear it and show a gentle menu instead
 *         of silently falling through to intent detection which would wipe customer context.
 * [PFH-3] ORDER_CONFIRMED ETA response: uses business.settings.estimatedDeliveryMinutes
 *         if set, otherwise falls back to a generic "our team will update you" message.
 *         Eliminates the hardcoded "20–30 minutes" that was wrong for bakeries, salons,
 *         retail, and any non-restaurant business with different preparation times.
 * [PFH-4] ORDER_CONFIRMED isUnrelated: mode-aware response. Food modes (RESTAURANT,
 *         BAKERY) keep the focused "order only" message. Retail/delivery/other modes
 *         allow the customer to browse while waiting.
 * [PFH-5] ORDER_REJECTED: admin rejection reason passthrough. If adminCommandService
 *         stored a rejectReason on the order, it's shown to the customer in plain language.
 * [PFH-6] AI calls from ORDER_CONFIRMED context now pass orderContext so the AI system
 *         prompt includes the active order details.
 * [PFH-7] Payment rejection with reason: reads flowData.rejectReason if present.
 */

import { updateSession }  from '../core/sessions/sessionService.js';
import { getModeConfig }  from '../config/modes.js';
import { dispatchMessage } from '../core/whatsapp/dispatcher.js';
import logger from '../config/logger.js';

// ── Name validation (duplicated from webhookController — avoids circular import) ──
function isValidName(n) {
  if (!n || n.length < 3 || n.length > 40) return false;
  if (!/^[a-zA-Z\s]+$/.test(n)) return false;
  if (!/[aeiou]/i.test(n)) return false;
  const lower = n.toLowerCase();
  const NOISE = new Set([
    'hi','hey','hello','hiya','yo','ok','okay','sure','yes','no','nope',
    'thanks','thank','fine','done','good','great','nice','ready','here',
    'home','work','busy','free','waiting','coming','hungry','back','soon',
    'now','out','away','test','hhhh','lol','haha','hihi','hehe',
  ]);
  if (NOISE.has(lower)) return false;
  const words = lower.split(/\s+/);
  return words.every(w => {
    if (w.length < 3) return false;
    if (!/[aeiou]/i.test(w)) return false;
    if (NOISE.has(w)) return false;
    const freq = {};
    for (const c of w) freq[c] = (freq[c] || 0) + 1;
    if (Object.values(freq).some(v => v / w.length > 0.5)) return false;
    return true;
  });
}

// ── Sentiment classifiers (shared across all ackCtx paths) ───────────────────
const ACK_RE        = /^(ok|okay|k|kk|thanks?|thank\s*you|thank\s*u|thx|ty|tq|great|perfect|got\s*it|noted|alright|cool|nice|sounds\s*good|good|👍|🙏|😊|yep|yh|yah|understood|cheers|appreciate\s*it|brilliant|wonderful|awesome|lovely|received|noted|sure|fine|no\s*problem|np|sure\s*i\s*do|i\s*sure\s*do|i\s*will|will\s*do|definitely|absolutely|of\s*course|certainly|for\s*sure|sure\s*thing|yeah|yes|yes\s*please|indeed|exactly|right|totally|agreed|fair\s*enough)$/i;
const COMPLIMENT_RE = /\b(amazing|excellent|fantastic|love|best|delicious|enjoyed|happy|pleased|satisfied|impressed|recommend|5\s*star|five\s*star|well\s*done|great\s*job|keep\s*it\s*up|good\s*job|wonderful|superb|outstanding|top\s*notch|quality)\b/i;
const COMPLAINT_RE  = /\b(bad|terrible|awful|horrible|disappoint|not\s*good|wrong|cold|late|missing|never|complain|refund|cheat|fraud|angry|upset|poor|issue|problem|unsatisfied|unhappy|rubbish|disgusting|unacceptable|worst)\b/i;
const QUESTION_RE   = /[?]|^(how|when|where|what|why|can\s*you|do\s*you|is\s*there|will\s*you|could\s*you)\b/i;

/**
 * handlePostFlowMessage — main entry point called from webhookController.
 *
 * @param {object} params
 * @param {string}  params.ackCtx       — session.postFlowAck value
 * @param {object}  params.flowData     — session.postFlowData
 * @param {object}  params.session      — full session document
 * @param {string}  params.messageText  — raw customer message text
 * @param {boolean} params.isInteractive — whether message was a button tap
 * @param {object}  params.business     — BusinessConfig document
 * @param {object}  params.tenantDoc    — Tenant document (for dispatchMessage)
 * @param {string}  params.from         — customer phone number
 * @param {string}  params.tenantId     — tenant ID string
 * @param {object}  params.custCtx      — from getCustomerContext()
 *
 * @returns {Promise<boolean>} true if handled (caller should return), false to fall through
 */
export async function handlePostFlowMessage({
  ackCtx, flowData, session, messageText, isInteractive,
  business, tenantDoc, from, tenantId, custCtx,
}) {
  const cfg       = getModeConfig(business);
  const bizName   = business?.name || 'us';
  const mode      = (business?.businessMode || 'RETAIL').toUpperCase();
  const welcomeBtns = (cfg.ui?.welcomeButtons || [
    { id: 'ORDER',    title: '🛒 Place an Order'   },
    { id: 'QUESTION', title: '❓ Ask a Question'   },
  ]).slice(0, 3);

  // Resolve customer name safely
  const _rawName  = session.customerName || custCtx?.name || null;
  const custName  = isValidName(_rawName) ? `, ${_rawName}` : '';
  const orderCount = custCtx?.orderCount || 0;
  const vipThreshold = business?.settings?.vipThreshold || 5;
  const isVIP     = orderCount >= vipThreshold;

  const msg   = messageText.trim();
  const upper = msg.toUpperCase();

  const isAck        = ACK_RE.test(msg);
  const isCompliment = !isAck && COMPLIMENT_RE.test(msg);
  const isComplaint  = COMPLAINT_RE.test(msg);
  const isQuestion   = !isComplaint && !isCompliment && !isAck && QUESTION_RE.test(msg);

  // [PFH-2] Clear postFlowAck first — consumed regardless of path taken below.
  // Each handler that needs to KEEP the ack context restores it explicitly.
  await updateSession(from, tenantId, { postFlowAck: null, postFlowData: null });

  switch (ackCtx) {
    case 'ORDER_CONFIRMED':
      return handleOrderConfirmed({
        msg, upper, isAck, isCompliment, isComplaint, isQuestion,
        flowData, session, business, tenantDoc, from, tenantId,
        cfg, bizName, mode, welcomeBtns, custName, isVIP,
      });

    case 'ORDER_REJECTED':
      return handleOrderRejected({
        msg, isAck, isCompliment, isComplaint,
        flowData, business, tenantDoc, from, tenantId,
        custName, welcomeBtns,
      });

    case 'ORDER_READY':
      return handleOrderReady({
        msg, upper, isAck, isQuestion,
        flowData, business, tenantDoc, from, tenantId,
        cfg, bizName, custName,
      });

    case 'BOOKING_CONFIRMED':
      return handleBookingConfirmed({
        msg, upper, isAck, isCompliment, isComplaint,
        flowData, business, tenantDoc, from, tenantId,
        custName,
      });

    case 'BOOKING_DECLINED':
      return handleBookingDeclined({
        msg, isAck, isComplaint,
        flowData, business, tenantDoc, from, tenantId,
        custName,
      });

    // [FIX-PFH-SKIN] SKINCARE_ADVICE postFlowAck — set by cosmetics/flows/index.js
    // after the AI beauty advice is delivered. Without this case every follow-up tap
    // (💄 Shop Now, ❓ Another Question, 🔄 Start Over) landed in the default branch,
    // which sent a generic "How can I help?" menu instead of a warm contextual reply.
    case 'SKINCARE_ADVICE': {
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `You're welcome${custName}! 😊 Ready to explore our range?`,
          buttons: welcomeBtns,
        }, tenantDoc);
        return true;
      }
      if (isQuestion) {
        const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
        const aiReply = await getAIReply({ customerMessage: msg, business, session, intent: 'SKINCARE_ADVICE' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    aiReply || `Happy to help${custName}! 😊`,
          buttons: welcomeBtns,
        }, tenantDoc);
        return true;
      }
      // Any other message — show welcome menu
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `What else can I help you with${custName}? 💄`,
        buttons: welcomeBtns,
      }, tenantDoc);
      return true;
    }

    // [FIX-ACK-COLLECT] ORDER_COLLECTED: set after the customer taps "Collected – Thanks!"
    // in the ORDER_READY flow. Any follow-up (thank you, emoji, compliment) gets a warm
    // farewell reply instead of going to AI → SUPPORT escalation.
    case 'ORDER_COLLECTED': {
      const itemStr = flowData.item ? ` *${flowData.item}*` : '';
      if (isCompliment || isAck) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `You're so welcome${custName}! 😊 Glad you enjoyed your${itemStr}. Hope to see you again soon! 🙏`,
          buttons: welcomeBtns,
        }, tenantDoc);
        return true;
      }
      if (isComplaint) {
        const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
        const aiReply = await getAIReply({ customerMessage: msg, business, session, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    aiReply || `We're really sorry to hear that${custName}. 😔 Please let us know how we can make it right.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        return true;
      }
      // Any other message — show welcome menu
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `😊 What would you like to do next${custName}?`,
        buttons: welcomeBtns,
      }, tenantDoc);
      return true;
    }

    // Legacy/generic postFlowAck (ORDER, BOOKING) — kept for backwards compat
    case 'ORDER': {
      await dispatchMessage(from, {
        type: 'text',
        body: `You're welcome${custName}! 😊 We're preparing your order — we'll let you know when it's ready!`,
      }, tenantDoc);
      return true;
    }

    case 'BOOKING': {
      // [FIX-BOOKING-ACK] Previously said "Your booking is confirmed" — but at this point
      // the admin has NOT yet confirmed; the booking is PENDING admin review. Saying
      // "confirmed" is factually wrong and confuses customers who then ask why the admin
      // later sends a separate confirmation message. Changed to "booking request received".
      const body = `You're welcome${custName}! 😊 Your booking request has been received and is awaiting confirmation. We'll let you know as soon as it's confirmed!`;
      await dispatchMessage(from, { type: 'text', body }, tenantDoc);
      return true;
    }

    default: {
      // [PFH-2] Unknown ackCtx — stale session or unhandled future state.
      // Clear it and show a gentle menu. Without this, the caller's intent detection
      // would route the customer into a fresh flow, silently wiping their context.
      logger.warn('[PostFlow] Unknown ackCtx — clearing and showing menu', { ackCtx, from });
      await updateSession(from, tenantId, { postFlowAck: null, postFlowData: null });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `😊 How can I help you?`,
        buttons: welcomeBtns,
      }, tenantDoc);
      return true;
    }
  }
}

// ── ORDER_CONFIRMED ──────────────────────────────────────────────────────────
async function handleOrderConfirmed({
  msg, upper, isAck, isCompliment, isComplaint, isQuestion,
  flowData, session, business, tenantDoc, from, tenantId,
  cfg, bizName, mode, welcomeBtns, custName, isVIP,
}) {
  const { default: Order } = await import('../models/Order.js');
  const { getAIReply }     = await import('../core/ai/providers/aiRouter.js');

  // [SPEC-4H] Cancel intent — show confirmation prompt before doing anything
  const CANCEL_RE = /^(cancel|cancel\s*(my\s*)?order|stop|nevermind|never\s*mind|abort)$/i;
  if (CANCEL_RE.test(msg) || upper === 'CANCEL' || upper === 'CANCEL_ORDER') {
    const activeOrd = await Order.findOne({
      customerPhone: from, tenantId,
      status: { $in: ['confirmed', 'pending'] },
      paymentStatus: { $nin: ['cancelled', 'rejected'] },
    }).select('item quantity shortId').sort({ createdAt: -1 }).lean().catch(() => null);

    const itemLine  = activeOrd ? `\n\n📦  *${activeOrd.item}* × ${activeOrd.quantity} — _paid_` : '';
    const shortRef  = activeOrd?.shortId || flowData.shortId || '';
    await updateSession(from, tenantId, {
      postFlowAck:  'ORDER_CONFIRMED',
      postFlowData: flowData,
      data: { ...(session.data || {}), cancelShortId: shortRef },
    }).catch(() => {});
    await dispatchMessage(from, {
      type:    'buttons',
      body:
        `Are you sure you want to cancel order *#${shortRef}*?` +
        itemLine +
        `\n\n⚠️ Cancellations at this stage may be subject to our refund policy.`,
      buttons: [
        { id: 'SWITCH_YES', title: '✅ Yes, Cancel'       },
        { id: 'SWITCH_NO',  title: '❌ No, Keep My Order' },
      ],
    }, tenantDoc);
    return true;
  }

  if (upper === 'SWITCH_YES') {
    const cancelShortId = session.data?.cancelShortId || flowData.shortId;
    if (cancelShortId) {
      await Order.findOneAndUpdate(
        { shortId: cancelShortId, tenantId, status: { $nin: ['cancelled', 'completed'] } },
        { $set: { status: 'cancelled', paymentStatus: 'cancelled' } }
      ).catch(() => {});
    }
    await updateSession(from, tenantId, { postFlowAck: null, postFlowData: null, data: {} });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    `❌ Your order has been cancelled.\n\nWhat would you like to do next?`,
      buttons: cfg.ui?.welcomeButtons || [{ id: 'ORDER', title: '🛒 Place New Order' }],
    }, tenantDoc);
    return true;
  }

  if (upper === 'SWITCH_NO') {
    const itemRef = flowData.item ? `*${flowData.item}*` : 'your order';
    await updateSession(from, tenantId, { postFlowAck: 'ORDER_CONFIRMED', postFlowData: flowData });
    await dispatchMessage(from, {
      type: 'text',
      body: `👍 No problem — ${itemRef} is still being prepared. We'll let you know when it's ready!`,
    }, tenantDoc);
    return true;
  }

  // [SPEC-4G] "What did I order?" — show order summary
  const MY_ORDER_RE = /\b(what\s*(did\s*i|have\s*i)\s*order(ed)?|my\s*order|my\s*ref(erence)?|show\s*my\s*order|order\s*details?|what\s*am\s*i\s*(getting|having)|remind\s*me)\b/i;
  if (MY_ORDER_RE.test(msg)) {
    const ord = await Order.findOne({
      customerPhone: from, tenantId,
      status: { $in: ['confirmed', 'pending'] },
    }).select('item quantity totalPrice shortId paymentStatus status').sort({ createdAt: -1 }).lean().catch(() => null);

    const currency  = business?.payment?.currency || 'D';
    const ordItem   = ord?.item      || flowData.item     || '—';
    const ordQty    = ord?.quantity  || flowData.quantity || '—';
    const ordTotal  = ord?.totalPrice ? `${currency}${ord.totalPrice}` : '—';
    const ordRef    = ord?.shortId   || flowData.shortId || '—';
    const ordStatus = (ord?.status === 'confirmed') ? 'Being Prepared 🍳' : '⏳ Pending';

    await updateSession(from, tenantId, { postFlowAck: 'ORDER_CONFIRMED', postFlowData: flowData });
    await dispatchMessage(from, {
      type: 'text',
      body:
        `Here's your current order:\n\n` +
        `📦  *${ordItem}* × ${ordQty}\n` +
        `💰  Total paid: *${ordTotal}*\n` +
        `🔖  Reference: *#${ordRef}*\n` +
        `📊  Status: ${ordStatus}`,
    }, tenantDoc);
    return true;
  }

  // [SPEC-4F] "When will it be ready?" — ETA
  // [PFH-3] Uses business.settings.estimatedDeliveryMinutes if configured.
  const ETA_RE = /\b(when\s*(will\s*(it|my\s*order)\s*be\s*ready|is\s*(it|my\s*order)\s*ready)?|how\s*long|any\s*update|update(\s*please)?|status\s*(please)?|how\s*soon|is\s*(it|my\s*order)\s*ready|still\s*waiting|ready\s*yet)\b/i;
  if (ETA_RE.test(msg)) {
    await updateSession(from, tenantId, { postFlowAck: 'ORDER_CONFIRMED', postFlowData: flowData });
    const etaMins = business?.settings?.estimatedDeliveryMinutes;
    const etaLine = etaMins
      ? `Estimated time: *${etaMins} minutes* from when your order was confirmed.`
      : `Our team will send you an update as soon as it's ready — we appreciate your patience!`;
    await dispatchMessage(from, {
      type: 'text',
      body:
        `⏳ Your order is still being prepared.\n\n` +
        `${etaLine}\n\n` +
        `We'll message you directly the moment it's ready!`,
    }, tenantDoc);
    return true;
  }

  if (isComplaint) {
    const orderContext = flowData.item ? { item: flowData.item, shortId: flowData.shortId } : null;
    const aiReply = await getAIReply({ customerMessage: msg, business, session, intent: 'COMPLAINT', orderContext });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    aiReply || `We're really sorry to hear that${custName}. 😔 Your experience matters to us and we want to make it right.\n\nA member of our team will look into this immediately.`,
      buttons: [
        { id: 'SUPPORT',  title: '💬 Speak to Team'  },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
    }, tenantDoc);
    return true;
  }

  // [FIX-SUPPORT-LOCK] Explicit human/support escalation requests must always escape
  // the ORDER_CONFIRMED food-mode lock. Previously these fell into isUnrelated → the
  // restaurant lock ("I can only help with your order") with no SUPPORT button — the
  // customer was trapped with no way to reach a human while their order was being prepared.
  // "i need help", "i want to talk to the admin", "talk to human", "help me", etc. all
  // landed here and were silently stonewalled. Now detected BEFORE the isUnrelated check
  // and routed to SUPPORT via the button tap (which moduleRouter handles correctly).
  const SUPPORT_ESCAPE_RE = /\b(help|support|admin|human|agent|person|team|manager|someone|real\s*person|talk\s*to|speak\s*to|contact|reach\s*out|assistance|assist|escalat)\b/i;
  if (SUPPORT_ESCAPE_RE.test(msg) || upper === 'SUPPORT') {
    const itemRef3 = flowData.item ? `*${flowData.item}*` : 'your order';
    await dispatchMessage(from, {
      type:    'buttons',
      body:    `Of course${custName}! 🙏 Let me connect you with our team.\n\n_${itemRef3} is still being prepared — we'll keep you updated._`,
      buttons: [
        { id: 'SUPPORT',  title: '💬 Speak to Team'  },
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ],
    }, tenantDoc);
    return true;
  }

  if (isCompliment) {
    const orderContext = flowData.item ? { item: flowData.item, shortId: flowData.shortId } : null;
    const aiReply = await getAIReply({ customerMessage: msg, business, session, intent: 'COMPLIMENT', orderContext });
    const fallback = isVIP
      ? `That truly means a lot to us${custName}! 🙏 Your order is still being prepared — we'll have it ready shortly. ❤️`
      : `Thank you${custName}! 😊 We're working on your order — we'll let you know the moment it's ready!`;
    await dispatchMessage(from, {
      type: 'text',
      body: aiReply || fallback,
    }, tenantDoc);
    return true;
  }

  if (isQuestion) {
    const orderContext = flowData.item ? { item: flowData.item, shortId: flowData.shortId } : null;
    const aiReply = await getAIReply({ customerMessage: msg, business, session, intent: 'QUESTION', orderContext });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    (aiReply || `Happy to help${custName}! 😊`) + `\n\n_Your order is still being prepared — we'll notify you when it's ready._`,
      buttons: [
        { id: 'QUESTION',     title: '❓ Ask a Question' },
        { id: 'CANCEL_ORDER', title: '❌ Cancel Order'   },
      ],
    }, tenantDoc);
    return true;
  }

  // [SPEC-4I] Completely unrelated message
  // [PFH-4] Mode-aware: food modes stay focused; retail/delivery allow browsing
  const isUnrelated = !isAck && !isCompliment && !isComplaint && !isQuestion;
  if (isUnrelated) {
    await updateSession(from, tenantId, { postFlowAck: 'ORDER_CONFIRMED', postFlowData: flowData });
    const itemRef2 = flowData.item ? `*${flowData.item}*` : 'your order';
    const isFoodMode = ['RESTAURANT', 'BAKERY', 'FOOD'].includes(mode);
    if (isFoodMode) {
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `😊 I can only help with your ${bizName} order right now.\n\n${itemRef2} is still being prepared. We'll notify you when it's ready!`,
        buttons: [
          { id: 'QUESTION',     title: '❓ Ask a Question' },
          { id: 'SUPPORT',      title: '💬 Contact Team'   },
          { id: 'CANCEL_ORDER', title: '❌ Cancel Order'   },
        ],
      }, tenantDoc);
    } else {
      // Retail/delivery — customer can still browse while waiting
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `😊 Your order *#${flowData.shortId || ''}* is being processed.\n\nWhile you wait, can I help you with anything else?`,
        buttons: (cfg.ui?.welcomeButtons || []).slice(0, 2).concat([{ id: 'QUESTION', title: '❓ Ask a Question' }]),
      }, tenantDoc);
    }
    return true;
  }

  // [SPEC-4A] Simple ack while order is PREPARING — no buttons, no upsell
  const itemRef = flowData.item ? `*${flowData.item}*` : 'your order';
  const ackBody = `You're welcome${custName}! 😊 ${itemRef} is on its way to the kitchen. We'll let you know when it's ready!`;
  await dispatchMessage(from, { type: 'text', body: ackBody }, tenantDoc);
  return true;
}

// ── ORDER_REJECTED ───────────────────────────────────────────────────────────
async function handleOrderRejected({
  msg, isAck, isCompliment, isComplaint,
  flowData, business, tenantDoc, from, tenantId,
  custName, welcomeBtns,
}) {
  const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
  const itemStr = flowData.item ? ` for *${flowData.item}*` : '';

  if (isComplaint) {
    const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    aiReply || `We sincerely apologise for the inconvenience${custName}. 😔 We understand how frustrating this must be.\n\nPlease contact our team and we'll resolve this for you as a priority.`,
      buttons: [
        { id: 'SUPPORT', title: '💬 Speak to Team' },
        { id: 'ORDER',   title: '🛒 Try Again'     },
      ],
    }, tenantDoc);
    return true;
  }

  if (isAck) {
    // [PFH-5] Show reject reason if the admin provided one
    const reasonLine = flowData.rejectReason
      ? `\n\n💬 *Reason:* ${flowData.rejectReason}`
      : '';
    await dispatchMessage(from, {
      type:    'buttons',
      body:    `We're sorry your order${itemStr} didn't go through${custName}. 🙏${reasonLine}\n\nWe'd love to make it up to you — tap below to try again or ask us anything.`,
      buttons: welcomeBtns,
    }, tenantDoc);
    return true;
  }

  // Any other message — treat as question/follow-up
  const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'SUPPORT' });
  await dispatchMessage(from, {
    type:    'buttons',
    body:    aiReply || `We're here to help${custName}. 😊 What can we do for you?`,
    buttons: welcomeBtns,
  }, tenantDoc);
  return true;
}

// ── ORDER_READY ──────────────────────────────────────────────────────────────
async function handleOrderReady({
  msg, upper, isAck, isQuestion,
  flowData, business, tenantDoc, from, tenantId,
  cfg, bizName, custName,
}) {
  const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
  const itemRef = flowData.item ? `*${flowData.item}*` : 'your order';

  const COLLECTED_RE = /\b(collect|collected|got\s*it|picked\s*up|received|have\s*it|got\s*my|picked\s*it|taken|taking|here\s*now|coming\s*now|on\s*my\s*way|coming\s*to|heading)\b/i;
  const isCollected = COLLECTED_RE.test(msg) || upper.startsWith('COLLECTED_');

  if (isCollected) {
    const { default: Order } = await import('../models/Order.js');
    const shortIdRef = flowData.shortId || upper.replace('COLLECTED_', '');
    if (shortIdRef) {
      await Order.findOneAndUpdate(
        { shortId: shortIdRef, tenantId, status: { $in: ['ready', 'confirmed', 'preparing'] } },
        { $set: { status: 'completed', completedAt: new Date() } }
      ).catch(() => {});
    }
    await dispatchMessage(from, {
      type: 'text',
      body: `🎉 Enjoy! 😊\n\nHope to see you again soon.\n— *${bizName}*`,
    }, tenantDoc);
    // [FIX-ACK-COLLECT] Set postFlowAck so that any immediate follow-up from the customer
    // ("thank you", "was delicious", emoji) is handled with warm contextual reply instead
    // of falling through to AI classify → SUPPORT and triggering an unintended escalation.
    await updateSession(from, tenantId, {
      postFlowAck:  'ORDER_COLLECTED',
      postFlowData: { item: flowData.item, shortId: shortIdRef },
    }).catch(() => {});
    return true;
  }

  if (isAck) {
    const collectedBtnId = flowData.shortId ? `COLLECTED_${flowData.shortId}` : null;
    await dispatchMessage(from, {
      type:    'buttons',
      body:    `You're welcome${custName}! 😊 ${itemRef} is ready and waiting for you at the counter.`,
      buttons: collectedBtnId
        ? [{ id: collectedBtnId, title: '✅ Collected — Thanks!' }]
        : [{ id: 'SUPPORT',      title: '✅ Collected — Thanks!' }],
    }, tenantDoc);
    return true;
  }

  if (isQuestion) {
    const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'QUESTION' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    (aiReply || `Happy to help${custName}! 😊`) + `\n\n_Your order is ready for collection at the counter._`,
      buttons: [{ id: 'SUPPORT', title: '❓ Need Help' }],
    }, tenantDoc);
    return true;
  }

  // Generic fallback
  await dispatchMessage(from, {
    type:    'buttons',
    body:    `😊 ${itemRef} is ready for collection at the counter! ${bizName} is waiting for you.`,
    buttons: [{ id: 'SUPPORT', title: '❓ Need Help' }],
  }, tenantDoc);
  return true;
}

// ── BOOKING_CONFIRMED ────────────────────────────────────────────────────────
async function handleBookingConfirmed({
  msg, upper, isAck, isCompliment, isComplaint,
  flowData, business, tenantDoc, from, tenantId,
  custName,
}) {
  const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
  const whenStr = flowData.date
    ? ` on *${flowData.date}${flowData.time ? ` at ${flowData.time}` : ''}*`
    : '';

  if (upper === 'CANCEL_BOOKING' || upper === 'CANCEL') {
    const { cancelFlow } = await import('../core/conversations/flowEngine.js');
    const reply = await cancelFlow({ customerPhone: from, tenantId }, business);
    await dispatchMessage(from, reply, tenantDoc);
    return true;
  }

  if (isCompliment || isAck) {
    await dispatchMessage(from, {
      type:    'buttons',
      body:    `You're welcome${custName}! 😊 We're looking forward to seeing you${whenStr}. If anything changes, just let us know!`,
      buttons: [{ id: 'CANCEL_BOOKING', title: '❌ Cancel Booking' }],
    }, tenantDoc);
    return true;
  }

  if (isComplaint) {
    const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    aiReply || `We're very sorry to hear that${custName}. 😔 Please let us know how we can make things right.`,
      buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
    }, tenantDoc);
    return true;
  }

  const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'QUESTION' });
  await dispatchMessage(from, {
    type:    'buttons',
    body:    aiReply || `Happy to help${custName}! 😊`,
    buttons: [
      { id: 'QUESTION',       title: '❓ Ask a Question' },
      { id: 'CANCEL_BOOKING', title: '❌ Cancel Booking'  },
    ],
  }, tenantDoc);
  return true;
}

// ── BOOKING_DECLINED ─────────────────────────────────────────────────────────
async function handleBookingDeclined({
  msg, isAck, isComplaint,
  flowData, business, tenantDoc, from, tenantId,
  custName,
}) {
  const { getAIReply } = await import('../core/ai/providers/aiRouter.js');

  if (isComplaint) {
    const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    aiReply || `We're truly sorry${custName}. 😔 We understand how disappointing this is and we want to find a solution that works for you.`,
      buttons: [
        { id: 'SUPPORT', title: '💬 Speak to Team'    },
        { id: 'BOOK',    title: '📅 Book Another Time' },
      ],
    }, tenantDoc);
    return true;
  }

  if (isAck) {
    await dispatchMessage(from, {
      type:    'buttons',
      body:    `We're sorry we couldn't accommodate you this time${custName}. 🙏 We'd love to find another time that works — tap below to try again!`,
      buttons: [
        { id: 'BOOK',    title: '📅 Book Another Time' },
        { id: 'SUPPORT', title: '💬 Speak to Team'     },
      ],
    }, tenantDoc);
    return true;
  }

  const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'SUPPORT' });
  await dispatchMessage(from, {
    type:    'buttons',
    body:    aiReply || `We're here to help${custName}. 😊`,
    buttons: [
      { id: 'BOOK',    title: '📅 Book Another Time' },
      { id: 'SUPPORT', title: '💬 Speak to Team'     },
    ],
  }, tenantDoc);
  return true;
}
