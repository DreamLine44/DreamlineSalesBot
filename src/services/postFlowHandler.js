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
import { buildOptionsReply } from '../core/shared/uiOptionsHelper.js';
import logger from '../config/logger.js';
import { formatMoney } from '../utils/formatCurrency.js';

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

// [PFH-8] A lone ACK/COMPLIMENT regex match sitting next to a negation ("not amazing"),
// a hedge ("hardly", "barely"), or a sarcasm marker (quoted word, clapping emoji, "lol")
// is exactly the gap a tone-testing customer exploits — the regex sees the positive
// word and ignores the qualifier flipping its meaning. Demote those to the AI tiebreak.
const NEGATION_SARCASM_RE = /\b(not|never|hardly|barely|isn't|wasn't|aren't|weren't|no\s*way|yeah\s*right)\b|['"][^'"]{2,}['"]|👏|🙄|😏|\blol\b|\blmao\b/i;
const SENTIMENT_LABELS = ['ACK', 'COMPLIMENT', 'COMPLAINT', 'QUESTION', 'UNRELATED'];

/**
 * classifyPostFlowSentiment(msg, business)
 *
 * Trusts a single confident regex match (fast path, zero added latency/cost),
 * UNLESS that lone match is an ACK/COMPLIMENT sitting next to a negation or
 * sarcasm hint ("not bad", "wow, real 'impressive' service 👏") — that's the
 * exact gap a tone-testing customer exploits, so it's demoted to the AI
 * tiebreak instead. Zero or conflicting regex matches also go to the AI
 * tiebreak. Falls back to the safe 'UNRELATED' bucket if the AI call fails.
 */
async function classifyPostFlowSentiment(msg, business) {
  const mode = (business?.businessMode || 'RETAIL').toUpperCase();

  const matches = [];
  if (ACK_RE.test(msg))        matches.push('ACK');
  if (COMPLIMENT_RE.test(msg)) matches.push('COMPLIMENT');
  if (COMPLAINT_RE.test(msg))  matches.push('COMPLAINT');
  if (QUESTION_RE.test(msg))   matches.push('QUESTION');

  // [AUDIT-FIX-LIVE-3] A regex can't tell "impressive" from "'impressive'" or
  // "bad" from "not bad" — a negation word or sarcasm marker next to a lone
  // positive match means the fast path can't be trusted.
  const hasNegationOrSarcasm = NEGATION_SARCASM_RE.test(msg);
  const soleMatchIsGameable = matches.length === 1 &&
    (matches[0] === 'ACK' || matches[0] === 'COMPLIMENT') &&
    hasNegationOrSarcasm;

  if (matches.length === 1 && !soleMatchIsGameable) return matches[0];

  try {
    const { classifyIntent } = await import('../core/ai/providers/groqProvider.js');
    const result = await classifyIntent({ message: msg, validIntents: SENTIMENT_LABELS, mode });
    if (result && SENTIMENT_LABELS.includes(result.intent)) return result.intent;
    return 'UNRELATED';
  } catch (err) {
    return 'UNRELATED';
  }
}

// ── Post-flow expression turn budget ─────────────────────────────────────────
// [PFH-9] After order/booking completes, customers get a bounded number of
// expression replies (thanks, compliments, complaints, questions) before normal
// routing resumes. Active flows (ORDER/BOOKING mid-checkout) are never touched.
//
// Budget of 2 = two human replies, then the third message falls through to
// intent detection / order-status cards / welcome menu — not an open-ended loop.
export const EXPRESSION_TURN_BUDGET = 2;

/** Max chars for a single post-flow expression reply (WhatsApp-friendly, not an essay). */
export const EXPRESSION_MAX_CHARS = 80;

const EXPRESSION_CLOSING = `\n\n_Message us anytime._`;

export function trimExpressionReply(text) {
  if (!text) return text;
  let s = String(text).replace(/\s+/g, ' ').trim();
  s = s.replace(/^[-*•]\s+/gm, '').replace(/\n{2,}/g, ' ').trim();
  if (s.length <= EXPRESSION_MAX_CHARS) return s;
  const cut = s.slice(0, EXPRESSION_MAX_CHARS);
  const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  if (lastStop > 30) return cut.slice(0, lastStop + 1).trim();
  return `${cut.trim()}…`;
}

/** Append a soft close line on the last budgeted expression turn. */
export function maybeAppendExpressionClosing(body, flowData) {
  if (getExpressionTurnsLeft(flowData) <= 1) {
    return `${body}${EXPRESSION_CLOSING}`;
  }
  return body;
}

/** Trim long text and append soft close on the last budgeted turn. */
export function formatExpressionReply(body, flowData) {
  return maybeAppendExpressionClosing(trimExpressionReply(body), flowData);
}

export function getExpressionTurnsLeft(flowData) {
  const n = flowData?._exprTurnsLeft;
  if (typeof n === 'number' && n >= 0) return n;
  return EXPRESSION_TURN_BUDGET;
}

export function isExpressionSentiment(sentiment) {
  return sentiment === 'ACK' || sentiment === 'COMPLIMENT' ||
    sentiment === 'COMPLAINT' || sentiment === 'QUESTION';
}

export function preserveExpressionTurns(flowData = {}) {
  return { ...flowData, _exprTurnsLeft: getExpressionTurnsLeft(flowData) };
}

/**
 * Decrement the expression budget and re-arm postFlowAck if turns remain.
 * @returns {{ turnsLeftAfter: number, rearmed: boolean }}
 */
export async function consumeExpressionTurn({ from, tenantId, ackCtx, flowData }) {
  const left     = getExpressionTurnsLeft(flowData);
  const nextLeft = Math.max(0, left - 1);
  const nextData = { ...flowData, _exprTurnsLeft: nextLeft };
  if (nextLeft > 0) {
    await updateSession(from, tenantId, { postFlowAck: ackCtx, postFlowData: nextData });
    return { turnsLeftAfter: nextLeft, rearmed: true };
  }
  return { turnsLeftAfter: 0, rearmed: false };
}

/** Re-arm postFlowAck without consuming an expression turn (ETA, cancel confirm, etc.). */
export async function rearmPostFlowAck({ from, tenantId, ackCtx, flowData }) {
  await updateSession(from, tenantId, {
    postFlowAck:  ackCtx,
    postFlowData: preserveExpressionTurns(flowData),
  });
}

async function finishExpressionTurn({ from, tenantId, ackCtx, flowData }) {
  await consumeExpressionTurn({ from, tenantId, ackCtx, flowData });
}

/** AI reply for post-flow expressions — one short sentence, hard cap on length. */
async function getPostFlowAIReply({ customerMessage, business, session, intent, orderContext, sessionContext }) {
  const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
  const raw = await getAIReply({
    customerMessage, business, session, intent, orderContext, sessionContext,
    replyMode: 'expression',
  });
  return raw ? trimExpressionReply(raw) : null;
}

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

  const sentiment = await classifyPostFlowSentiment(msg, business);
  const isAck        = sentiment === 'ACK';
  const isCompliment = sentiment === 'COMPLIMENT';
  const isComplaint  = sentiment === 'COMPLAINT';
  const isQuestion   = sentiment === 'QUESTION';

  // [PFH-2] Clear postFlowAck first — consumed regardless of path taken below.
  // Each handler that needs to KEEP the ack context restores it explicitly.
  await updateSession(from, tenantId, { postFlowAck: null, postFlowData: null });

  switch (ackCtx) {
    case 'ORDER_CONFIRMED':
      return handleOrderConfirmed({
        msg, upper, isAck, isCompliment, isComplaint, isQuestion,
        flowData, session, business, tenantDoc, from, tenantId,
        cfg, bizName, mode, welcomeBtns, custName, isVIP,
        ackCtx: 'ORDER_CONFIRMED',
      });

    case 'ORDER_REJECTED':
      return handleOrderRejected({
        msg, isAck, isCompliment, isComplaint,
        flowData, business, tenantDoc, from, tenantId,
        custName, welcomeBtns, cfg,
        ackCtx: 'ORDER_REJECTED',
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
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type: 'text',
          body: formatExpressionReply(`You're welcome${custName}! 😊`, flowData),
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      if (isComplaint) {
        const _r = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    formatExpressionReply(_r || `Sorry to hear that${custName}. 😔`, flowData),
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      const _followUp = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'QUESTION' });
      await dispatchMessage(from, {
        type: 'text',
        body: formatExpressionReply(_followUp || `Happy to help${custName}! 😊`, flowData),
      }, tenantDoc);
      await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
      return true;
    }

    // [AUDIT-FIX-SPEC-WARRANTY] SPEC_REQUEST/WARRANTY postFlowAck — set by
    // completeFlow() calls in modules/electronics/flows/orderFlow.js's
    // handleSpecRequest()/handleWarranty(). Previously fell to the generic
    // `default` branch and logged a spurious "Unknown ackCtx" warning for an
    // entirely expected, legitimate state — any follow-up after a spec or
    // warranty answer (a "thanks", another question, or a buy-now tap) got the
    // generic menu with zero context, same class of gap as QUESTION above.
    case 'SPEC_REQUEST': {
      const { getAIReply: _specAI } = await import('../core/ai/providers/aiRouter.js');
      const _specBtns = [
        { id: 'SPEC_REQUEST', title: '❓ Another Question' },
        ...welcomeBtns.slice(0, 2),
      ].slice(0, 3);
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `You're welcome${custName}! 😊 Let us know if you have any other questions about the product.`,
          buttons: _specBtns,
        }, tenantDoc);
        return true;
      }
      if (isComplaint) {
        const _r = await _specAI({ customerMessage: msg, business, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    _r || `We're sorry to hear that${custName}. 😔 Please speak to our team directly.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        return true;
      }
      const _followUp = await _specAI({ customerMessage: msg, business, session, intent: 'SPEC_REQUEST' });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    _followUp || `Happy to help${custName}! 😊`,
        buttons: _specBtns,
      }, tenantDoc);
      return true;
    }

    case 'WARRANTY': {
      const { getAIReply: _warAI } = await import('../core/ai/providers/aiRouter.js');
      const _warBtns = [
        { id: 'WARRANTY',     title: '❓ Another Question' },
        { id: 'SPEC_REQUEST', title: '🛒 Tech Help'         },
        { id: 'SUPPORT',      title: '💬 Speak to Team'      },
      ];
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type:    'buttons',
          body:    `You're welcome${custName}! 😊 Let us know if you need anything else on warranty or after-sales.`,
          buttons: _warBtns,
        }, tenantDoc);
        return true;
      }
      if (isComplaint) {
        const _r = await _warAI({ customerMessage: msg, business, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    _r || `We're sorry to hear that${custName}. 😔 Please speak to our team directly.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        return true;
      }
      const _followUp = await _warAI({ customerMessage: msg, business, session, intent: 'WARRANTY' });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    _followUp || `Happy to help${custName}! 😊`,
        buttons: _warBtns,
      }, tenantDoc);
      return true;
    }

    case 'BOOKING_CONFIRMED':
      return handleBookingConfirmed({
        msg, upper, isAck, isCompliment, isComplaint, isQuestion,
        flowData, business, tenantDoc, from, tenantId,
        custName,
        ackCtx: 'BOOKING_CONFIRMED',
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
        // [AUDIT-FIX-15b] Was setting step: 'SELECT_SERVICE' with data: {} while the
        // message below asks "What date works best for you?" — a genuine step/prompt
        // mismatch. handleSalonBooking's SELECT_SERVICE case expects the customer's
        // NEXT message to be a service name; a typed date ("tomorrow", "25 June")
        // never matches one, so it silently re-showed the service picker instead of
        // accepting the date, and the original service (flowData.service) was lost
        // entirely since data was reset to {}. Fixed to land on 'DATE' (which
        // handleBookingFlow's shared DATE step genuinely does accept free-text dates
        // for — see core/conversations/bookingFlow.js) with the customer's existing
        // service/stylist carried over from flowData, matching the "for your *X*"
        // wording already in the message body below and the same
        // step:'DATE' + pre-populated data pattern already used elsewhere in
        // handleSalonBooking (SELECT_SERVICE / SELECT_STYLIST cases) when skipping
        // straight to date selection.
        await updateSession(from, tenantId, {
          currentFlow: 'BOOKING', step: 'DATE', postFlowAck: null,
          data: {
            service:         flowData?.service || null,
            selectedService: flowData?.service || null,
            stylist:         flowData?.staff    || null,
          },
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

      // [FIX-REMINDER-Q] isQuestion (computed once for the whole function, same as
      // ORDER_READY/handleWalkInQueueAck below) was never checked in this case — a
      // customer replying to an appointment reminder with a genuine question ("what
      // should I bring?", "do I need to pay in advance?") fell straight through to
      // the generic "What would you like to do?" default below, which doesn't answer
      // anything and just re-shows the same three buttons. This is the exact
      // "questioning system silently breaks" shape already fixed for MFQ_RESUME
      // (AUDIT-FIX-15) — same fix here: answer via AI, then re-arm postFlowAck so a
      // further typed question or a button tap both keep working afterwards.
      if (isQuestion) {
        const { getAIReply: _reminderQA } = await import('../core/ai/providers/aiRouter.js');
        const aiReply = await _reminderQA({ customerMessage: msg, business, intent: 'QUESTION' }).catch(() => null);
        await dispatchMessage(from, {
          type:    'buttons',
          body:    (aiReply || `Happy to help${custName}! 😊`)
                 + `\n\n_Just a reminder: your appointment${serviceStr}${whenStr} is coming up._`,
          buttons: reminderBtns,
        }, tenantDoc);
        await updateSession(from, tenantId, { postFlowAck: 'APPOINTMENT_REMINDER', postFlowData: flowData });
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
        await dispatchMessage(from, buildOptionsReply(cfg, `You're welcome${custName}! 😊 Ready to explore our range?`), tenantDoc);
        return true;
      }
      if (isQuestion) {
        const { getAIReply } = await import('../core/ai/providers/aiRouter.js');
        const aiReply = await getAIReply({ customerMessage: msg, business, session, intent: 'SKINCARE_ADVICE' });
        await dispatchMessage(from, buildOptionsReply(cfg, aiReply || `Happy to help${custName}! 😊`), tenantDoc);
        return true;
      }
      // Any other message — show welcome menu
      await dispatchMessage(from, buildOptionsReply(cfg, `What else can I help you with${custName}? 💄`), tenantDoc);
      return true;
    }

    // [FIX-ACK-COLLECT] ORDER_COLLECTED: set after the customer taps "Collected – Thanks!"
    // in the ORDER_READY flow. Any follow-up (thank you, emoji, compliment) gets a warm
    // farewell reply instead of going to AI → SUPPORT escalation.
    case 'ORDER_COLLECTED': {
      const itemStr = flowData.item ? ` *${flowData.item}*` : '';
      if (isCompliment || isAck) {
        await dispatchMessage(from, {
          type: 'text',
          body: formatExpressionReply(`You're so welcome${custName}! 😊 Glad you enjoyed it.`, flowData),
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      if (isComplaint) {
        const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, session, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    formatExpressionReply(aiReply || `Sorry to hear that${custName}. 😔`, flowData),
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      await dispatchMessage(from, buildOptionsReply(cfg, `😊 What would you like to do next${custName}?`), tenantDoc);
      return true;
    }

    // [FIX-26] ENQUIRY postFlowAck — set by completeFlow('ENQUIRY') in services/general flows.
    // Previously fell to 'default' (generic "How can I help?") after any enquiry submission.
    // A customer who just submitted a detailed enquiry and replies "thanks" now gets warmth.
    case 'ENQUIRY': {
      if (isAck || isCompliment) {
        await dispatchMessage(from, {
          type: 'text',
          body: formatExpressionReply(`You're welcome${custName}! 😊 Enquiry received.`, flowData),
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      if (isComplaint) {
        const _r = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    formatExpressionReply(_r || `Sorry to hear that${custName}. 😔`, flowData),
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      const _enqFollowUp = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'QUESTION' });
      await dispatchMessage(from, {
        type: 'text',
        body: formatExpressionReply(_enqFollowUp || `Happy to help${custName}! 😊`, flowData),
      }, tenantDoc);
      await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
      return true;
    }

    // [FIX-26] QUOTE_FOLLOW postFlowAck — set by completeFlow('QUOTE_FOLLOW') in services flow.
    case 'QUOTE_FOLLOW': {
      if (isAck || isCompliment) {
        await dispatchMessage(from, buildOptionsReply(cfg, `You're welcome${custName}! 😊 We'll have your quote ready shortly. We'll reach out as soon as it's prepared.`), tenantDoc);
        return true;
      }
      // [AUDIT-FIX-EXPRESSION-WINDOW-2] A complaint here previously fell into the
      // generic "else" branch below and got the same upbeat "Thanks! Our team
      // will be in touch" reply as an ordinary follow-up — ignoring the
      // complaint entirely. Now escalates like every other ackCtx case.
      if (isComplaint) {
        const { getAIReply: _qfAI } = await import('../core/ai/providers/aiRouter.js');
        const _qfReply = await _qfAI({ customerMessage: msg, business, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    _qfReply || `We're sorry to hear that${custName}. 😔 Let us know how we can help.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        return true;
      }
      // Question or other — show warm menu
      await dispatchMessage(from, buildOptionsReply(cfg, `Thanks${custName}! 😊 Our team will be in touch with your quote. Is there anything else we can help with?`), tenantDoc);
      return true;
    }

    // [FIX-26] ABOUT postFlowAck — set by completeFlow('ABOUT') in general/handleAbout.
    case 'ABOUT': {
      if (isAck || isCompliment) {
        await dispatchMessage(from, buildOptionsReply(cfg, `Glad to share! 😊 Let us know if you'd like to get started.`), tenantDoc);
        return true;
      }
      // [AUDIT-FIX-EXPRESSION-WINDOW-2] A complaint here previously went through
      // the generic AI QUESTION-intent reply below with no escalation path —
      // the AI would improvise an answer without ever offering to connect the
      // customer to a human. Now escalates like every other ackCtx case.
      if (isComplaint) {
        const { getAIReply: _aboutComplaintAI } = await import('../core/ai/providers/aiRouter.js');
        const _aboutComplaintReply = await _aboutComplaintAI({ customerMessage: msg, business, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    _aboutComplaintReply || `We're sorry to hear that${custName}. 😔 Let us know how we can help.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        return true;
      }
      const { getAIReply: _aboutAI } = await import('../core/ai/providers/aiRouter.js');
      const _aboutReply = await _aboutAI({ customerMessage: msg, business, intent: 'QUESTION' });
      await dispatchMessage(from, buildOptionsReply(cfg, _aboutReply || `Happy to help${custName}! 😊`), tenantDoc);
      return true;
    }

    // [PFH-9] Bounded expression window — up to EXPRESSION_TURN_BUDGET replies
    // (thanks, compliments, complaints, questions) before normal routing resumes.
    // Active ORDER/BOOKING flows are never touched; this only runs post-completion.
    case 'ORDER': {
      if (isComplaint) {
        const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, session, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    formatExpressionReply(
            aiReply || `Sorry to hear that${custName}. 😔 We'll look into it.`,
            flowData,
          ),
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      if (isCompliment) {
        await dispatchMessage(from, {
          type: 'text',
          body: formatExpressionReply(`That means a lot${custName}! 😊 Order's being prepared.`, flowData),
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      if (isQuestion) {
        const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, session, intent: 'QUESTION' });
        await dispatchMessage(from, {
          type: 'text',
          body: formatExpressionReply(aiReply || `Happy to help${custName}! 😊`, flowData),
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      await dispatchMessage(from, {
        type: 'text',
        body: formatExpressionReply(`You're welcome${custName}! 😊`, flowData),
      }, tenantDoc);
      await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
      return true;
    }

    case 'BOOKING': {
      if (isComplaint) {
        const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, session, intent: 'COMPLAINT' });
        await dispatchMessage(from, {
          type:    'buttons',
          body:    formatExpressionReply(
            aiReply || `Sorry to hear that${custName}. 😔 We'll look into it.`,
            flowData,
          ),
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      if (isCompliment) {
        await dispatchMessage(from, {
          type: 'text',
          body: formatExpressionReply(`That's very kind${custName}! 😊 We'll confirm your booking soon.`, flowData),
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      if (isQuestion) {
        const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, session, intent: 'QUESTION' });
        await dispatchMessage(from, {
          type: 'text',
          body: formatExpressionReply(aiReply || `Happy to help${custName}! 😊`, flowData),
        }, tenantDoc);
        await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
        return true;
      }
      await dispatchMessage(from, {
        type: 'text',
        body: formatExpressionReply(`You're welcome${custName}! 😊 Booking request received.`, flowData),
      }, tenantDoc);
      await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
      return true;
    }

    // ── [MFQ] Mid-Flow Question Resume ────────────────────────────────────
    // Set when the customer paused a flow (booking/order) to ask a question.
    // The question has been answered. Now offer to take them back to the flow.
    case 'MFQ_RESUME': {
      // [AUDIT-FIX-13] The MFQ_SWITCH_YES answer screen (webhookController step 15.1a)
      // offers THREE buttons — "↩️ Continue", "❓ Ask Another", "🔄 Main Menu" — and sets
      // postFlowAck='MFQ_RESUME' so a plain typed follow-up gets this "Hope that helped!"
      // prompt. But webhookController's postFlowAck guard only exempted the "Continue"
      // button id (MFQ_RESUME_FLOW) from being intercepted here — NOT "Ask Another"
      // (button id 'QUESTION') or "Main Menu" (button id 'SHOW_MENU'). So tapping either
      // of those two buttons was swallowed by this case and just re-showed "Hope that
      // helped! Would you like to continue with your booking?" instead of doing what the
      // button said — opening a new question, or going to the main menu. Root-caused via
      // the WhatsApp Web screenshots: tapping "❓ Ask Another" produced the resume prompt
      // instead of a fresh "what would you like to know?" screen.
      //
      // Fix: if the incoming message IS one of those two button taps, don't show the
      // resume prompt at all — return false (postFlowAck was already cleared by [PFH-2]
      // above) so the caller falls through to normal button/intent routing, which sends
      // 'QUESTION' to the real Ask-a-Question flow and 'SHOW_MENU' to the real main menu.
      if (isInteractive && (upper === 'QUESTION' || upper === 'SHOW_MENU')) {
        return false;
      }

      const resumeFlow = flowData?.resumeFlow || null;
      const resumeStep = flowData?.resumeStep || null;

      // [AUDIT-FIX-15] This case previously ignored the CONTENT of the customer's
      // message entirely — isAck/isCompliment/isComplaint/isQuestion are computed at
      // the top of this function for every other ackCtx case, but MFQ_RESUME never
      // looked at them. That meant: after the bot answered one mid-flow question and
      // showed "Hope that helped! Continue?", if the customer typed ANOTHER question
      // directly (instead of tapping "❓ Ask Another" first), that question text was
      // silently discarded — the bot just re-showed the same generic prompt, never
      // answering it. Only a SINGLE mid-flow question could ever be asked; any further
      // typed follow-up broke the "questioning system" entirely.
      //
      // Fix: only show the plain "did that help" prompt for genuine acknowledgements
      // or compliments. Complaints escalate to support (consistent with the QUESTION
      // ackCtx case above). Anything else is treated as a NEW question and answered
      // using the same data-backed (TRACK_ORDER etc.) -> AI fallback pipeline used for
      // the original mid-flow question, then postFlowAck is re-armed so the customer
      // can keep asking further questions or resume the paused flow at any point.
      if (isComplaint) {
        const { getAIReply: _mfqComplaintAI } = await import('../core/ai/providers/aiRouter.js');
        const _r = await _mfqComplaintAI({ customerMessage: msg, business, intent: 'COMPLAINT' }).catch(() => null);
        await dispatchMessage(from, {
          type:    'buttons',
          body:    _r || `We're sorry to hear that${custName}. 😔 Please speak to our team directly.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
        }, tenantDoc);
        if (resumeFlow) await updateSession(from, tenantId, { postFlowAck: 'MFQ_RESUME', postFlowData: flowData });
        return true;
      }

      if (!isAck && !isCompliment) {
        const DATA_BACKED_MFQ_ACTIONS = new Set(['TRACK_ORDER']);
        const flowlessSession = { ...session, currentFlow: null, step: null, data: {} };

        const resumeButtons = resumeFlow
          ? [
              { id: 'MFQ_RESUME_FLOW', title: '↩️ Continue'    },
              { id: 'QUESTION',        title: '❓ Ask Another'   },
              { id: 'SHOW_MENU',       title: '🔄 Main Menu'     },
            ]
          : [
              { id: 'QUESTION',  title: '❓ Ask Another' },
              { id: 'SHOW_MENU', title: '🔄 Main Menu'   },
            ];

        let dataReply = null;
        try {
          const { detectIntent } = await import('../core/intents/intentEngine.js');
          const { route }        = await import('../core/conversations/moduleRouter.js');
          const pqResult = await detectIntent({
            message: msg, isInteractive: false, session: flowlessSession, business,
          });
          if (DATA_BACKED_MFQ_ACTIONS.has(pqResult.action) && pqResult.confidence !== 'LOW') {
            dataReply = await route({
              action: pqResult.action, intent: pqResult.intent, session: flowlessSession,
              message: msg, business, tenant: tenantDoc, isInteractive: false,
              suggestion: pqResult.suggestion,
            }).catch(() => null);
          }
        } catch (err) {
          logger.warn('[MFQ_RESUME] follow-up question data routing failed', { err: err.message });
        }

        if (dataReply) {
          const payloads = Array.isArray(dataReply) ? dataReply : [dataReply];
          for (const p of payloads) await dispatchMessage(from, p, tenantDoc);
          await dispatchMessage(from, {
            type:    'buttons',
            body:    resumeFlow ? `_Tap below to continue where you left off, or ask another question._` : `👇 Anything else?`,
            buttons: resumeButtons,
          }, tenantDoc);
        } else {
          const { getAIReply: _mfqFollowUpAI } = await import('../core/ai/providers/aiRouter.js');
          const aiText = await _mfqFollowUpAI({ customerMessage: msg, business, session, intent: 'QUESTION' }).catch(() => null);
          await dispatchMessage(from, {
            type:    'buttons',
            body:    aiText || 'Let me check that for you! 😊',
            buttons: resumeButtons,
          }, tenantDoc);
        }

        // Re-arm postFlowAck so further typed questions or the resume tap keep working.
        if (resumeFlow) await updateSession(from, tenantId, { postFlowAck: 'MFQ_RESUME', postFlowData: flowData });
        return true;
      }

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
        // [FIX-MFQ-LOOP] Do NOT restore postFlowAck here. Previously we set
        // postFlowAck='MFQ_RESUME' again after every message, causing an infinite
        // loop where every customer message showed "Hope that helped!" repeatedly.
        // The MFQ_RESUME_FLOW button tap is intercepted in webhookController step 15.1b
        // which reads postFlowData directly from the session (already set by updateSession
        // at step 15.1a). We only need to keep postFlowData for the button to work —
        // postFlowAck was already cleared by [PFH-2] at the top of this function, which
        // is correct: one "Hope that helped!" message per Q&A session, not per message.
        await updateSession(from, tenantId, { postFlowData: flowData });
        return true;
      }

      // No resume context — just show the menu
      await dispatchMessage(from, buildOptionsReply(cfg, `😊 Hope that helped! What would you like to do next?`), tenantDoc);
      return true;
    }

    default: {
      // [PFH-2] Unknown ackCtx — stale session or unhandled future state.
      // Clear it and show a gentle menu. Without this, the caller's intent detection
      // would route the customer into a fresh flow, silently wiping their context.
      logger.warn('[PostFlow] Unknown ackCtx — clearing and showing menu', { ackCtx, from });
      await updateSession(from, tenantId, { postFlowAck: null, postFlowData: null });
      await dispatchMessage(from, buildOptionsReply(cfg, `😊 How can I help you?`), tenantDoc);
      return true;
    }
  }
}

// ── ORDER_CONFIRMED ──────────────────────────────────────────────────────────
async function handleOrderConfirmed({
  msg, upper, isAck, isCompliment, isComplaint, isQuestion,
  flowData, session, business, tenantDoc, from, tenantId,
  cfg, bizName, mode, welcomeBtns, custName, isVIP,
  ackCtx = 'ORDER_CONFIRMED',
}) {
  const { default: Order } = await import('../models/Order.js');

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
      postFlowAck:  ackCtx,
      postFlowData: preserveExpressionTurns(flowData),
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
        { shortId: cancelShortId, tenantId, customerPhone: from, status: { $nin: ['cancelled', 'completed'] } },
        { $set: { status: 'cancelled', paymentStatus: 'cancelled', cancelledBy: 'customer', cancelledAt: new Date() } }
      ).catch(() => {});
    }
    await updateSession(from, tenantId, { postFlowAck: null, postFlowData: null, data: {} });
    await dispatchMessage(from, buildOptionsReply(
      cfg,
      `❌ Your order has been cancelled.\n\nWhat would you like to do next?`,
      [{ id: 'ORDER', title: '🛒 Place New Order' }]
    ), tenantDoc);
    return true;
  }

  if (upper === 'SWITCH_NO') {
    const itemRef = flowData.item ? `*${flowData.item}*` : 'your order';
    await rearmPostFlowAck({ from, tenantId, ackCtx, flowData });
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
    const ordTotal  = ord?.totalPrice ? `${currency}${formatMoney(ord.totalPrice)}` : '—';
    const ordRef    = ord?.shortId   || flowData.shortId || '—';
    const ordStatus = (ord?.status === 'confirmed') ? 'Being Prepared 🍳' : '⏳ Pending';

    await rearmPostFlowAck({ from, tenantId, ackCtx, flowData });
    await dispatchMessage(from, {
      type: 'text',
      body:
        `📦 *${ordItem}* × ${ordQty} · *${ordTotal}*\n` +
        `🔖 #${ordRef} · ${ordStatus}`,
    }, tenantDoc);
    return true;
  }

  // [SPEC-4F] "When will it be ready?" — ETA
  const ETA_RE = /\b(when\s*(will\s*(it|my\s*order)\s*be\s*ready|is\s*(it|my\s*order)\s*ready)?|how\s*long|any\s*update|update(\s*please)?|status\s*(please)?|how\s*soon|is\s*(it|my\s*order)\s*ready|still\s*waiting|ready\s*yet)\b/i;
  if (ETA_RE.test(msg)) {
    await rearmPostFlowAck({ from, tenantId, ackCtx, flowData });
    const etaMins = business?.settings?.estimatedDeliveryMinutes;
    await dispatchMessage(from, {
      type: 'text',
      body: etaMins
        ? `⏳ Still preparing — about *${etaMins} mins*. We'll ping you when it's ready!`
        : `⏳ Still preparing — we'll ping you when it's ready!`,
    }, tenantDoc);
    return true;
  }

  if (isComplaint) {
    const orderContext = flowData.item ? { item: flowData.item, shortId: flowData.shortId } : null;
    const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, session, intent: 'COMPLAINT', orderContext });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    formatExpressionReply(
        aiReply || `Really sorry about that${custName}. 😔`,
        flowData,
      ),
      buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  if (isCompliment) {
    const orderContext = flowData.item ? { item: flowData.item, shortId: flowData.shortId } : null;
    const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, session, intent: 'COMPLIMENT', orderContext });
    const fallback = isVIP
      ? `Thank you${custName}! 🙏 Your order's on the way.`
      : `Thank you${custName}! 😊`;
    await dispatchMessage(from, {
      type: 'text',
      body: formatExpressionReply(aiReply || fallback, flowData),
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  if (isQuestion) {
    const orderContext = flowData.item ? { item: flowData.item, shortId: flowData.shortId } : null;
    const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, session, intent: 'QUESTION', orderContext });
    await dispatchMessage(from, {
      type: 'text',
      body: formatExpressionReply(aiReply || `Happy to help${custName}! 😊`, flowData),
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  // [SPEC-4I] Completely unrelated message
  const isUnrelated = !isAck && !isCompliment && !isComplaint && !isQuestion;
  if (isUnrelated) {
    await rearmPostFlowAck({ from, tenantId, ackCtx, flowData });
    const itemRef2 = flowData.item ? `*${flowData.item}*` : 'your order';
    const isFoodMode = ['RESTAURANT', 'BAKERY', 'FOOD'].includes(mode);
    if (isFoodMode) {
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `Your ${itemRef2} is still being prepared — we'll notify you! 😊`,
        buttons: [
          { id: 'QUESTION',     title: '❓ Ask a Question' },
          { id: 'CANCEL_ORDER', title: '❌ Cancel Order'   },
        ],
      }, tenantDoc);
    } else {
      await dispatchMessage(from, {
        type:    'buttons',
        body:    `Order *#${flowData.shortId || ''}* is processing. Need anything else? 😊`,
        buttons: (cfg.ui?.welcomeButtons || []).slice(0, 2).concat([{ id: 'QUESTION', title: '❓ Ask a Question' }]),
      }, tenantDoc);
    }
    return true;
  }

  const itemRef = flowData.item ? `*${flowData.item}*` : 'your order';
  const ackBody = formatExpressionReply(
    `You're welcome${custName}! 😊 ${itemRef} is being prepared.`,
    flowData,
  );
  await dispatchMessage(from, { type: 'text', body: ackBody }, tenantDoc);
  await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
  return true;
}

// ── ORDER_REJECTED ───────────────────────────────────────────────────────────
async function handleOrderRejected({
  msg, isAck, isCompliment, isComplaint,
  flowData, business, tenantDoc, from, tenantId,
  custName, welcomeBtns, cfg,
  ackCtx = 'ORDER_REJECTED',
}) {
  const itemStr = flowData.item ? ` for *${flowData.item}*` : '';
  const reasonLine = flowData.rejectReason
    ? `\nReason: ${flowData.rejectReason}`
    : '';

  if (isComplaint) {
    const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    formatExpressionReply(
        aiReply || `Sorry about that${custName}. 😔`,
        flowData,
      ),
      buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  if (isAck || isCompliment) {
    await dispatchMessage(from, {
      type: 'text',
      body: formatExpressionReply(
        `Sorry your order${itemStr} didn't go through${custName}. 🙏${reasonLine}`,
        flowData,
      ),
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'SUPPORT' });
  await dispatchMessage(from, {
    type: 'text',
    body: formatExpressionReply(aiReply || `We're here to help${custName}. 😊`, flowData),
  }, tenantDoc);
  await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
  return true;
}

// ── ORDER_READY ──────────────────────────────────────────────────────────────
async function handleOrderReady({
  msg, upper, isAck, isQuestion,
  flowData, business, tenantDoc, from, tenantId,
  cfg, bizName, custName,
}) {
  const itemRef = flowData.item ? `*${flowData.item}*` : 'your order';

  const COLLECTED_RE = /\b(collect|collected|got\s*it|picked\s*up|received|have\s*it|got\s*my|picked\s*it|taken|taking|here\s*now|coming\s*now|on\s*my\s*way|coming\s*to|heading)\b/i;
  const isCollected = COLLECTED_RE.test(msg) || upper.startsWith('COLLECTED_');

  if (isCollected) {
    const { default: Order } = await import('../models/Order.js');
    const shortIdRef = flowData.shortId || upper.replace('COLLECTED_', '');
    if (shortIdRef) {
      // [AUDIT-FIX-TRACE-5] Was missing `customerPhone: from` — same gap as the
      // COLLECTED_* handler in webhookController.js and the SWITCH_YES cancel above.
      await Order.findOneAndUpdate(
        { shortId: shortIdRef, tenantId, customerPhone: from, status: 'ready' },
        { $set: { status: 'completed', completedAt: new Date() } }
      ).catch(() => {});
    }
    await dispatchMessage(from, {
      type: 'text',
      body: `🎉 Enjoy! See you again soon. — *${bizName}*`,
    }, tenantDoc);
    // [FIX-ACK-COLLECT] Set postFlowAck so that any immediate follow-up from the customer
    // ("thank you", "was delicious", emoji) is handled with warm contextual reply instead
    // of falling through to AI classify → SUPPORT and triggering an unintended escalation.
    await updateSession(from, tenantId, {
      postFlowAck:  'ORDER_COLLECTED',
      postFlowData: { item: flowData.item, shortId: shortIdRef, _exprTurnsLeft: EXPRESSION_TURN_BUDGET },
    }).catch(() => {});
    return true;
  }

  if (isAck) {
    const collectedBtnId = flowData.shortId ? `COLLECTED_${flowData.shortId}` : null;
    await dispatchMessage(from, {
      type:    'buttons',
      body:    `You're welcome${custName}! ${itemRef} is ready at the counter. 😊`,
      buttons: collectedBtnId
        ? [{ id: collectedBtnId, title: '✅ Collected — Thanks!' }]
        : [{ id: 'SUPPORT',      title: '✅ Collected — Thanks!' }],
    }, tenantDoc);
    return true;
  }

  if (isQuestion) {
    const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'QUESTION' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    aiReply || `Happy to help${custName}! Ready at the counter. 😊`,
      buttons: [{ id: 'SUPPORT', title: '❓ Need Help' }],
    }, tenantDoc);
    return true;
  }

  await dispatchMessage(from, {
    type:    'buttons',
    body:    `${itemRef} is ready at the counter! 😊`,
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
    const isConfirmed = ackCtx === 'WALKIN_CONFIRMED';
    const body = isConfirmed
      ? `You're welcome${custName}! ${emoji} We're ready for you — head on over${serviceStr}${staffStr}. See you soon! 🙏`
      : `You're welcome${custName}! ${emoji} You're in the queue${serviceStr}${staffStr}. Please head to the salon — we'll message you to confirm your spot! 🙏`;
    await dispatchMessage(from, {
      type: 'text',
      body: formatExpressionReply(body, flowData),
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  if (isComplaint) {
    const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    formatExpressionReply(aiReply || `Sorry to hear that${custName}. 😔`, flowData),
      buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  const aiReply = await getPostFlowAIReply({
    customerMessage: msg, business,
    intent: /\b(aftercare|after care|maintain|how long|prep|what to bring|what to wear)\b/i.test(msg) ? 'AFTERCARE' : 'SALON_QUESTION',
    sessionContext: `Customer is in the walk-in queue${serviceStr}${staffStr}.`,
  });
  await dispatchMessage(from, {
    type: 'text',
    body: formatExpressionReply(aiReply || `Happy to help${custName}! ${emoji}`, flowData),
  }, tenantDoc);
  await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
  return true;
}

// ── BOOKING_CONFIRMED ────────────────────────────────────────────────────────
async function handleBookingConfirmed({
  msg, upper, isAck, isCompliment, isComplaint, isQuestion,
  flowData, business, tenantDoc, from, tenantId,
  custName,
  ackCtx = 'BOOKING_CONFIRMED',
}) {
  const mode          = (business?.businessMode || '').toUpperCase();
  const isSalon       = mode === 'SALON' || mode === 'BARBERSHOP';
  const isWalkIn      = flowData.bookingType === 'walkin';
  const staffStr      = flowData.staff ? ` with *${flowData.staff}*` : '';

  const whenStr = isWalkIn
    ? ''
    : (flowData.date
        ? ` on *${flowData.date}${flowData.time ? ` at ${flowData.time}` : ''}*`
        : '');

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

  if (upper === 'RESCHEDULE') {
    if (flowData?.shortId) {
      const { default: _ReschBooking } = await import('../models/Booking.js');
      await _ReschBooking.findOneAndUpdate(
        { shortId: flowData.shortId, tenantId, customerPhone: from, status: { $nin: ['cancelled', 'completed'] } },
        { $set: { status: 'cancelled', cancelledBy: 'customer', cancelledAt: new Date() } }
      ).catch(() => {});
    }
    await updateSession(from, tenantId, {
      currentFlow: 'BOOKING', step: 'DATE', postFlowAck: null,
      data: {
        service:         flowData?.service || null,
        selectedService: flowData?.service || null,
        stylist:         flowData?.staff    || null,
      },
    });
    await dispatchMessage(from, {
      type: 'text',
      body: `📅 *Reschedule Appointment*

No problem${custName}! Let's find a new time${flowData?.service ? ` for your *${flowData.service}*` : ''}.

What date works best for you?`,
    }, tenantDoc);
    return true;
  }

  if (isComplaint) {
    const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    formatExpressionReply(aiReply || `Sorry to hear that${custName}. 😔`, flowData),
      buttons: [{ id: 'SUPPORT', title: '💬 Speak to Team' }],
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  if (isCompliment || isAck) {
    const seeYouStr = isWalkIn
      ? `See you soon${staffStr}!`
      : `See you${whenStr}${staffStr}.`;
    await dispatchMessage(from, {
      type: 'text',
      body: formatExpressionReply(`You're welcome${custName}! 😊 ${seeYouStr}`, flowData),
    }, tenantDoc);
    await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
    return true;
  }

  const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'QUESTION' });
  await dispatchMessage(from, {
    type: 'text',
    body: formatExpressionReply(aiReply || `Happy to help${custName}! 😊`, flowData),
  }, tenantDoc);
  await finishExpressionTurn({ from, tenantId, ackCtx, flowData });
  return true;
}

// ── BOOKING_DECLINED ─────────────────────────────────────────────────────────
async function handleBookingDeclined({
  msg, isAck, isComplaint,
  flowData, business, tenantDoc, from, tenantId,
  custName,
}) {
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
    const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'COMPLAINT' });
    await dispatchMessage(from, {
      type:    'buttons',
      body:    trimExpressionReply(aiReply || `Sorry about that${custName}. 😔`),
      buttons: _declinedBtns,
    }, tenantDoc);
    return true;
  }

  if (isAck) {
    const retryMsg = isWalkIn
      ? `Sorry the queue's full${custName}. 🙏 Try again later or book below.`
      : `Sorry we couldn't fit you in${custName}. 🙏 Tap below to try another time.`;
    await dispatchMessage(from, {
      type:    'buttons',
      body:    retryMsg,
      buttons: _declinedBtns,
    }, tenantDoc);
    return true;
  }

  const aiReply = await getPostFlowAIReply({ customerMessage: msg, business, intent: 'SUPPORT' });
  await dispatchMessage(from, {
    type:    'buttons',
    body:    trimExpressionReply(aiReply || `We're here to help${custName}. 😊`),
    buttons: _declinedBtns,
  }, tenantDoc);
  return true;
}
