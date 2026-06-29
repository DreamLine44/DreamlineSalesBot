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
const ACK_RE        = /^(ok|okay|k|kk|thanks?|thank\s*you|thank\s*u|thx|ty|tq|great|perfect|got\s*it|noted|alright|cool|nice|sounds\s*good|good|👍|🙏|😊|yep|yh|yah|understood|cheers|appreciate\s*it|brilliant|wonderful|awesome|lovely|received|noted|sure|fine|no\s*problem|np)$/i;
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

    // [FIX-SALON-19] QUESTION postFlowAck — set by completeFlow('QUESTION') in
    // handleSalonQuestion, handleServicesQuestion, handleGeneralQuestion, and
    // handleRestaurantQuestion. Previously fell to the default "unknown ackCtx"
    // branch which showed a generic "How can I help?" menu. This meant any follow-up
    // after an AI answer (a "thanks", another question, or a booking tap) was handled
    // with zero context, occasionally routing to AI classify as an unrelated message.
    case 'QUESTION': {
      const { getAIReply: _qaAI } = await import('../core/ai/providers/aiRouter.js');
      const _qaBtns = [
        { id: 'QUESTION',  title: '❓ Another Question' },
        ...welcomeBtns.slice(0, 2),
      ].slice(0, 3);
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `You're welcome${custName}! 😊 Let us know if you have any other questions.`,
          buttons: _qaBtns,
        }, tenantDoc);
        return true;
      }
      if (isComplaint) {
        const _r = await _qaAI({ customerMessage: msg, business, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    _r || `We're sorry to hear that${custName}. 😔 Please speak to our team directly.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        return true;
      }
      // Follow-up question or general message — answer with AI
      const _followUp = await _qaAI({ customerMessage: msg, business, intent: 'QUESTION' });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    _followUp || `Happy to help${custName}! 😊`,
        buttons: _qaBtns,
      }, tenantDoc);
      return true;
    }

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

    // [FIX-SALON-13] WALKIN postFlowAck — set by completeFlow('WALKIN') in
    // handleSalonWalkIn CONFIRM step. Previously fell to the default "unknown ackCtx"
    // branch (generic "How can I help?" menu) because no case existed here. Any
    // follow-up message after joining the queue (a "thanks", emoji, or question)
    // showed the generic menu instead of a warm queue-context reply.
    //
    // WALKIN_CONFIRMED is set by adminCommandService.confirmBooking() when the admin
    // taps "✅ Confirm Queue" on the walk-in alert. It's the counterpart to
    // BOOKING_CONFIRMED for the walk-in path — without it every follow-up after
    // admin queue confirmation hit the default branch.
    // [v14-POSTFLOW] APPOINTMENT_REMINDER: set by schedulerService when a reminder is sent.
    // When the customer replies to their appointment reminder, show confirm/reschedule/cancel
    // options instead of routing to generic intent detection.
    case 'APPOINTMENT_REMINDER': {
      const mode       = (business?.businessMode || '').toUpperCase();
      const isSalon    = mode === 'SALON' || mode === 'BARBERSHOP';
      const emoji      = mode === 'BARBERSHOP' ? '✂️' : '💇';
      const serviceStr = flowData?.service ? ` for *${flowData.service}*` : '';
      const whenStr    = flowData?.date
        ? ` on *${flowData.date}${flowData.time ? ` at ${flowData.time}` : ''}*`
        : '';

      const reminderBtns = [
        { id: 'CONFIRM',        title: '✅ I\'ll be there'     },
        { id: 'RESCHEDULE',     title: '📅 Reschedule'         },
        { id: 'CANCEL_BOOKING', title: '❌ Cancel Appointment'  },
      ];

      // [v15-REMINDER-BTNS] Handle the three explicit reminder buttons first, before
      // running sentiment classifiers. Previously RESCHEDULE and CANCEL_BOOKING were
      // shown as buttons but not handled here — they fell through to the default
      // dispatchMessage at the bottom, showing the reminder options again in a loop.
      if (upper === 'CONFIRM') {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `✅ Perfect${custName}! ${emoji} We look forward to seeing you${serviceStr}${whenStr}. See you soon! 🙏`,
          buttons: [{ id: 'QUESTION', title: '❓ Ask a Question' }, { id: 'CANCEL_BOOKING', title: '❌ Cancel' }],
        }, tenantDoc);
        return true;
      }

      if (upper === 'RESCHEDULE') {
        await updateSession(from, tenantId, {
          currentFlow: 'BOOKING', step: 'SELECT_SERVICE', data: {}, postFlowAck: null,
        });
        await dispatchMessage(from, {
          type: 'text',
          body: `📅 *Reschedule Appointment*\n\nNo problem${custName}! Let's find a new time${serviceStr}.\n\nWhat date works best for you?`,
        }, tenantDoc);
        return true;
      }

      if (upper === 'CANCEL_BOOKING' || upper === 'CANCEL') {
        const { cancelFlow } = await import('../core/conversations/flowEngine.js');
        const cancelReply = await cancelFlow({ customerPhone: from, tenantId }, business);
        await dispatchMessage(from, cancelReply, tenantDoc);
        return true;
      }

      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `Great${custName}! ${emoji} We're looking forward to seeing you${serviceStr}${whenStr}. See you soon! 🙏`,
          buttons: reminderBtns,
        }, tenantDoc);
        return true;
      }

      if (isComplaint) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `We're sorry to hear that${custName}. 😔 Would you like to reschedule or speak to our team?`,
          buttons: [
            { id: 'RESCHEDULE', title: '📅 Reschedule'      },
            { id: 'SUPPORT',    title: '💬 Speak to Team'   },
          ],
        }, tenantDoc);
        return true;
      }

      // Default — show options
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `${emoji} Your appointment${serviceStr}${whenStr} is coming up! What would you like to do?`,
        buttons: reminderBtns,
      }, tenantDoc);
      return true;
    }

    case 'WALKIN':
    case 'WALKIN_CONFIRMED':
      return handleWalkInQueueAck({
        msg, upper, isAck, isCompliment, isComplaint,
        flowData, business, tenantDoc, from, tenantId,
        custName, ackCtx,
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

    // [FIX-26] ENQUIRY postFlowAck — set by completeFlow('ENQUIRY') in services/general flows.
    // Previously fell to 'default' (generic "How can I help?") after any enquiry submission.
    // A customer who just submitted a detailed enquiry and replies "thanks" now gets warmth.
    case 'ENQUIRY': {
      const { getAIReply: _enqAI } = await import('../core/ai/providers/aiRouter.js');
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `You're welcome${custName}! 😊 We've received your enquiry and will get back to you shortly.`,
          buttons: welcomeBtns,
        }, tenantDoc);
        return true;
      }
      if (isComplaint) {
        const _r = await _enqAI({ customerMessage: msg, business, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    _r || `We're sorry to hear that${custName}. 😔 Let us know how we can help.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        return true;
      }
      // Follow-up question — AI handles it
      const _enqFollowUp = await _enqAI({ customerMessage: msg, business, intent: 'QUESTION' });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    _enqFollowUp || `Happy to help${custName}! 😊 We'll follow up on your enquiry shortly.`,
        buttons: welcomeBtns,
      }, tenantDoc);
      return true;
    }

    // [FIX-26] QUOTE_FOLLOW postFlowAck — set by completeFlow('QUOTE_FOLLOW') in services flow.
    case 'QUOTE_FOLLOW': {
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `You're welcome${custName}! 😊 We'll have your quote ready shortly. We'll reach out as soon as it's prepared.`,
          buttons: welcomeBtns,
        }, tenantDoc);
        return true;
      }
      // Question or other — show warm menu
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `Thanks${custName}! 😊 Our team will be in touch with your quote. Is there anything else we can help with?`,
        buttons: welcomeBtns,
      }, tenantDoc);
      return true;
    }

    // [FIX-26] ABOUT postFlowAck — set by completeFlow('ABOUT') in general/handleAbout.
    case 'ABOUT': {
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `Glad to share! 😊 Let us know if you'd like to get started.`,
          buttons: welcomeBtns,
        }, tenantDoc);
        return true;
      }
      const { getAIReply: _aboutAI } = await import('../core/ai/providers/aiRouter.js');
      const _aboutReply = await _aboutAI({ customerMessage: msg, business, intent: 'QUESTION' });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    _aboutReply || `Happy to help${custName}! 😊`,
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

    // ── [MFQ] Mid-Flow Question Resume ────────────────────────────────────
    // Set when the customer paused a flow (booking/order) to ask a question.
    // The question has been answered. Now offer to take them back to the flow.
    case 'MFQ_RESUME': {
      const resumeFlow = flowData?.resumeFlow || null;
      const resumeStep = flowData?.resumeStep || null;

      if (resumeFlow) {
        const flowLabel = {
          'BOOKING':   'your booking',
          'WALKIN':    'your walk-in queue entry',
          'ORDER':     'your order',
          'ENQUIRY':   'your enquiry',
        }[resumeFlow] || 'what you were doing';

        await dispatchMessage(from, {
          type:    'buttons',
          body:    `😊 Hope that helped! Would you like to continue with *${flowLabel}*?`,
          buttons: [
            { id: 'MFQ_RESUME_FLOW', title: `↩️ Continue ${resumeFlow === 'BOOKING' ? 'Booking' : resumeFlow === 'ORDER' ? 'Order' : 'Flow'}` },
            { id: 'SHOW_MENU',       title: '🔄 Main Menu' },
          ],
        }, tenantDoc);
        // Restore the postFlowData so MFQ_RESUME_FLOW button tap can use it
        await updateSession(from, tenantId, { postFlowAck: 'MFQ_RESUME', postFlowData: flowData });
        return true;
      }

      // No resume context — just show the menu
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `😊 Hope that helped! What would you like to do next?`,
        buttons: welcomeBtns,
      }, tenantDoc);
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
        { shortId: shortIdRef, tenantId, status: 'ready' },
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

// ── WALKIN / WALKIN_CONFIRMED ────────────────────────────────────────────────
// Handles customer follow-up messages after joining the walk-in queue (WALKIN)
// or after the admin confirms their queue entry (WALKIN_CONFIRMED).
//
// [FIX-SALON-13] Previously both of these fell to the default "unknown ackCtx"
// branch, showing a generic "How can I help?" menu. Customers who just joined
// the queue and sent a thank-you or question got no contextual response.
async function handleWalkInQueueAck({
  msg, upper, isAck, isCompliment, isComplaint,
  flowData, business, tenantDoc, from, tenantId,
  custName, ackCtx,
}) {
  const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
  const mode       = (business?.businessMode || '').toUpperCase();
  const isBarbershop = mode === 'BARBERSHOP';
  const emoji      = isBarbershop ? '✂️' : '💇';
  const staffStr   = flowData?.staff ? ` with *${flowData.staff}*` : '';
  const serviceStr = flowData?.service ? ` for *${flowData.service}*` : '';

  // Contextual buttons — customers in the walk-in queue can book a proper
  // appointment for next time, ask a question, or see the main menu.
  const queueBtns = [
    { id: 'QUESTION',  title: '❓ Ask a Question'   },
    { id: 'BOOK',      title: '📅 Book Next Time'   },
    { id: 'SHOW_MENU', title: '🔄 Main Menu'         },
  ];

  if (upper === 'CANCEL_BOOKING' || upper === 'CANCEL') {
    const { cancelFlow } = await import('../core/conversations/flowEngine.js');
    const reply = await cancelFlow({ customerPhone: from, tenantId }, business);
    await dispatchMessage(from, reply, tenantDoc);
    return true;
  }

  if (isCompliment || isAck) {
    // If they're already confirmed (WALKIN_CONFIRMED ackCtx), tailor the message.
    const isConfirmed = ackCtx === 'WALKIN_CONFIRMED';
    const body = isConfirmed
      ? `You're welcome${custName}! ${emoji} We're ready for you — head on over${serviceStr}${staffStr}. See you soon! 🙏`
      : `You're welcome${custName}! ${emoji} You're in the queue${serviceStr}${staffStr}. Please head to the salon — we'll message you to confirm your spot! 🙏`;
    await dispatchMessage(from, {
      type:    'buttons',
      body,
      buttons: queueBtns,
    }, tenantDoc);
    return true;
  }

  if (isComplaint) {
    const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    aiReply || `We're sorry to hear that${custName}. 😔 Please speak to our team directly and we'll make it right.`,
      buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
    }, tenantDoc);
    return true;
  }

  // Question or general message — AI handles it with queue context
  const aiReply = await getAIReply({
    customerMessage: msg, business,
    intent: /\b(aftercare|after care|maintain|how long|prep|what to bring|what to wear)\b/i.test(msg) ? 'AFTERCARE' : 'SALON_QUESTION', // [FIX-AFTERCARE]
    sessionContext: `Customer is in the walk-in queue${serviceStr}${staffStr}.`,
  });
  await dispatchMessage(from, {
    type:    'buttons',
    body:    aiReply || `Happy to help${custName}! ${emoji} You're in the queue — we'll see you soon.`,
    buttons: queueBtns,
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
  const mode          = (business?.businessMode || '').toUpperCase();
  const isSalon       = mode === 'SALON' || mode === 'BARBERSHOP';
  const isWalkIn      = flowData.bookingType === 'walkin';
  // [FIX-SALON-11] Show stylist in ack messages for salon bookings.
  const staffStr      = flowData.staff ? ` with *${flowData.staff}*` : '';

  // [FIX-SALON-11] Build context string appropriate to booking type:
  // - Walk-in: no "on <date> at <time>" — they're already in the queue.
  // - Appointment: show date + time as before.
  const whenStr = isWalkIn
    ? ''
    : (flowData.date
        ? ` on *${flowData.date}${flowData.time ? ` at ${flowData.time}` : ''}*`
        : '');

  // [FIX-SALON-11] Mode-aware button set for salon/barbershop:
  // - RESCHEDULE lets them change the appointment.
  // - QUESTION allows aftercare/prep questions.
  // - CANCEL_BOOKING always included as escape.
  // For non-salon modes: original CANCEL_BOOKING only.
  const _salonConfirmBtns = isSalon
    ? [
        { id: 'RESCHEDULE',     title: '📅 Reschedule'      },
        { id: 'QUESTION',       title: '❓ Ask a Question'  },
        { id: 'CANCEL_BOOKING', title: '❌ Cancel Booking'  },
      ]
    : [{ id: 'CANCEL_BOOKING', title: '❌ Cancel Booking' }];

  if (upper === 'CANCEL_BOOKING' || upper === 'CANCEL') {
    const { cancelFlow } = await import('../core/conversations/flowEngine.js');
    const reply = await cancelFlow({ customerPhone: from, tenantId }, business);
    await dispatchMessage(from, reply, tenantDoc);
    return true;
  }

  // [v15-RESCHEDULE] RESCHEDULE button: cancel old appointment and start a fresh booking.
  if (upper === 'RESCHEDULE') {
    if (flowData?.shortId) {
      const { default: _ReschBooking } = await import('../models/Booking.js');
      await _ReschBooking.findOneAndUpdate(
        { shortId: flowData.shortId, tenantId, status: { $nin: ['cancelled', 'completed'] } },
        { $set: { status: 'cancelled', cancelledBy: 'customer', cancelledAt: new Date() } }
      ).catch(() => {});
    }
    await updateSession(from, tenantId, {
      currentFlow: 'BOOKING', step: 'SELECT_SERVICE', data: {}, postFlowAck: null,
    });
    await dispatchMessage(from, {
      type: 'text',
      body: `📅 *Reschedule Appointment*

No problem${custName}! Let's find a new time${flowData?.service ? ` for your *${flowData.service}*` : ''}.

What date works best for you?`,
    }, tenantDoc);
    return true;
  }

  if (isCompliment || isAck) {
    const seeYouStr = isWalkIn
      ? `See you soon${staffStr}!`
      : `We're looking forward to seeing you${whenStr}${staffStr}.`;
    await dispatchMessage(from, {
      type:    'buttons',
      body:    `You're welcome${custName}! 😊 ${seeYouStr} If anything changes, just let us know!`,
      buttons: _salonConfirmBtns,
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
    buttons: isSalon
      ? [
          { id: 'QUESTION',       title: '❓ Another Question' },
          { id: 'RESCHEDULE',     title: '📅 Reschedule'       },
          { id: 'CANCEL_BOOKING', title: '❌ Cancel Booking'    },
        ]
      : [
          { id: 'QUESTION',       title: '❓ Ask a Question' },
          { id: 'CANCEL_BOOKING', title: '❌ Cancel Booking'  },
        ], // [FIX-SALON-BTNS]
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
  const mode      = (business?.businessMode || '').toUpperCase();
  const isSalon   = mode === 'SALON' || mode === 'BARBERSHOP';
  const isWalkIn  = flowData.bookingType === 'walkin';

  // [FIX-SALON-12] Walk-in declined → offer to BOOK an appointment or WALKIN again later.
  // Regular booking declined → offer to BOOK another time.
  // Salon/barbershop gets WALKIN as a second-chance option; restaurant just gets BOOK.
  const _declinedBtns = isSalon
    ? [
        { id: 'BOOK',    title: '📅 Book Appointment' },
        { id: 'WALKIN',  title: '🚶 Walk-In Queue'    },
        { id: 'SUPPORT', title: '💬 Speak to Team'    },
      ]
    : [
        { id: 'BOOK',    title: '📅 Book Another Time' },
        { id: 'SUPPORT', title: '💬 Speak to Team'     },
      ];

  if (isComplaint) {
    const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    aiReply || `We're truly sorry${custName}. 😔 We understand how disappointing this is and we want to find a solution that works for you.`,
      buttons: _declinedBtns,
    }, tenantDoc);
    return true;
  }

  if (isAck) {
    const retryMsg = isWalkIn
      ? `We're sorry the queue isn't available right now${custName}. 🙏 You can book an appointment or try the walk-in queue later!`
      : `We're sorry we couldn't accommodate you this time${custName}. 🙏 We'd love to find another time that works — tap below to try again!`;
    await dispatchMessage(from, {
      type:    'buttons',
      body:    retryMsg,
      buttons: _declinedBtns,
    }, tenantDoc);
    return true;
  }

  const aiReply = await getAIReply({ customerMessage: msg, business, intent: 'SUPPORT' });
  await dispatchMessage(from, {
    type:    'buttons',
    body:    aiReply || `We're here to help${custName}. 😊`,
    buttons: _declinedBtns,
  }, tenantDoc);
  return true;
}
