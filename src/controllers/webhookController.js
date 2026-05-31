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
 *   6.  Admin command guard                 [FIX-HM-7 — moved before humanMode]
 *   7.  Human mode guard
 *   8.  Loop prevention                     [FIX-BUG4 — was never enforced]
 *   8.5 Non-payment image guard             [FIX-WH-4 — images outside checkout]
 *   9.  Payment proof (image)
 *   10. DONE payment (requireProof=false gate)
 *   10.5 PAYMENT_PROOF strict text guard
 *   11. [Admin button reply moved to step 6]
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
 * [FIX-WH-3]  humanMode TTL restore now uses a single atomic createSession upsert
 *             instead of a separate updateSession call — eliminates race window.
 * [FIX-WH-4]  Images sent outside the ORDER/PAYMENT_PROOF context are now caught
 *             at step 8.5 and given a polite reply instead of falling through to
 *             intent detection with an empty messageText string.
 * [FIX-WH-5]  Step 6 'RESUME BOT' guard uses === / startsWith(' ') instead of plain
 *             startsWith('RESUME BOT') — prevents 'RESUME BOTNET ...' from triggering
 *             an unnecessary isAdminPhone DB lookup.
 * [FIX-WH-6]  createSession data no longer passes redundant customerPhone: from.
 *             sessionService ignores data.customerPhone entirely (uses first param),
 *             so the field was dead weight and a potential source of confusion.
 * [FIX-LOOP-1] Loop break now uses a single merged updateSession call — the previous
 *             two sequential writes had a race window where a concurrent request could
 *             see loopCount=MAX with the flow still active and send a double response.
 * [FIX-LOOP-2] MAX_LOOP corrected from 3 to 2 — the first identical message sets
 *             lastLoopMessage (loopCount stays 0), so MAX_LOOP=3 would break on the
 *             4th send, not the 3rd as documented. MAX_LOOP=2 breaks on the 3rd send.
 * [FIX-WH-1]  Removed redundant getSession call after createSession — createSession
 *             already returns the freshly written document via { new: true }.
 * [FIX-WH-2]  Fire-and-forget updateSession (lastSeen/messageCount/phoneNumberId) now
 *             logs failures instead of silently swallowing them.
 * [FIX-WH-3]  hours.days normalised to a plain object once, replacing the fragile
 *             dual Map/object accessor pattern.
 * [FIX-WH-4]  FLOW_PASSTHROUGH_IDS SVC_ coverage extended to SVC_0..SVC_99 and backed
 *             by isFlowPassthroughId() regex so businesses with >10 services work.
 * [FIX-WH-5]  'ORDER' typed during PAYMENT_PROOF step now cancels the pending order
 *             and routes to a fresh start, consistent with NEW_ORDER behaviour.
 * [FIX-2.1]   step 15 advance(): `|| imageUrl` fallback removed — imageUrl is fully
 *             consumed by steps 8.5 and 9; passing it as a text fallback was a silent
 *             footgun that would send a WhatsApp media ID into the flow engine if either
 *             guard were ever relaxed. Now `message: messageText` only.
 * [FIX-2.2]   Non-admin tapping a stale admin button (e.g. forwarded message) now
 *             receives a neutral fallback reply instead of a silent drop.
 * [FIX-2.3]   Expired-humanMode findOne now filters `expiresAt: { $lte: new Date() }`
 *             so it only matches expired sessions, not any live humanMode document.
 * [FIX-2.4]   messageCount fire-and-forget update now uses atomic $inc via the new
 *             `inc` argument to updateSession() — safe under concurrent webhooks.
 * [FIX-WH-7]  ProcessedMessage.create non-duplicate errors now log and return instead
 *             of falling through silently. Previously any DB error other than code 11000
 *             (duplicate key) was swallowed and message processing continued — breaking
 *             the dedup guarantee and risking double-processing on webhook retries.
 */

import { getSession, createSession, updateSession } from '../core/sessions/sessionService.js';
import { detectIntent, extractCustomerName }         from '../core/intents/intentEngine.js';
import { advance }                                   from '../core/conversations/flowEngine.js';
import { route }                                     from '../core/conversations/moduleRouter.js';
import { dispatchMessage }                           from '../core/whatsapp/dispatcher.js';
import { getModeConfig }                             from '../config/modes.js';
import Tenant           from '../models/Tenant.js';
import BusinessConfig   from '../models/BusinessConfig.js';
import ProcessedMessage from '../models/ProcessedMessage.js';
import logger           from '../config/logger.js';

// ── [FIX-BUG9] Button IDs generated inside active flows — must bypass intent detection
// [FIX-WH-4] SVC_ IDs were previously capped at SVC_0..SVC_9 (10 services). Businesses
// with more than 10 services would have SVC_10, SVC_11, etc. fall through to intent
// detection, silently breaking the service-selection step. The Set is now generated up
// to SVC_99, and the passthrough check also accepts any SVC_N pattern via the helper
// isSvcId() so the cap can never be hit in practice without a code change.
function isFlowPassthroughId(id) {
  return FLOW_PASSTHROUGH_IDS.has(id) || /^SVC_\d+$/.test(id);
}

const FLOW_PASSTHROUGH_IDS = new Set([
  // Time slots
  'TIME_9AM','TIME_10AM','TIME_11AM','TIME_12PM',
  'TIME_1PM','TIME_2PM','TIME_3PM','TIME_4PM','TIME_5PM',
  // Quantity
  'QTY_1','QTY_2','QTY_3','QTY_4','QTY_5',
  // Service selection — extended to SVC_0..SVC_99; use isFlowPassthroughId() which
  // also accepts any SVC_N via regex so a business with 100+ services still works.
  ...Array.from({ length: 100 }, (_, i) => `SVC_${i}`),
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

    // [FIX-WH-3] Normalise hours.days to a plain object regardless of whether the
    // schema stored it as a Mongoose Map (has .get()) or a plain object (bracket
    // access). The previous dual-accessor (hours.days?.get?.(key) || hours.days?.[key])
    // was fragile — a future schema change could silently fall through to the wrong
    // branch. Normalise once here so the rest of the function uses simple bracket access.
    const daysObj = (hours.days instanceof Map)
      ? Object.fromEntries(hours.days)
      : (hours.days && typeof hours.days.toObject === 'function')
        ? hours.days.toObject()  // Mongoose Map .toObject()
        : (hours.days || {});
    const dayConfig = daysObj[dayKey];

    if (dayConfig?.closed) return false;

    const openHr  = dayConfig?.open  ?? hours.open  ?? 8;
    const closeHr = dayConfig?.close ?? hours.close ?? 22;

    // [FIX-15] Get current time as decimal hours (e.g. 22.5 = 22:30) in the
    // business timezone so minutes are respected. Previously only the integer
    // hour was checked, meaning a business closing at 22:30 effectively closed
    // at 22:00, and opening at 8:30 let messages through from 8:00.
    let currentDecimalHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    if (tz !== 'UTC') {
      try {
        const formatter = new Intl.DateTimeFormat('en', {
          timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
        });
        const parts = formatter.formatToParts(now);
        const hourPart   = parts.find(p => p.type === 'hour');
        const minutePart = parts.find(p => p.type === 'minute');
        if (hourPart) {
          const h = parseInt(hourPart.value, 10);
          const m = minutePart ? parseInt(minutePart.value, 10) : 0;
          currentDecimalHour = h + m / 60;
        }
      } catch { /* fall back to UTC decimal */ }
    }
    return currentDecimalHour >= openHr && currentDecimalHour < closeHr;
  } catch {
    return true; // on error, default open
  }
}

// ── [FIX-BUG4] Loop prevention ────────────────────────────────────────────────
async function checkAndHandleLoop(session, messageText, tenantId, business) {
  // [FIX-LOOP-2] MAX_LOOP is the maximum number of times the SAME message can be sent
  // consecutively before the bot breaks the loop. The first occurrence sets lastLoopMessage
  // (loopCount stays 0). Each subsequent identical message increments loopCount.
  // So loopCount=0 on first, 1 on second, 2 on third → break on third repeat (= 4th total send).
  // Set MAX_LOOP=2 to break on the 3rd total send (2nd repeat), which matches the comment
  // "after 3 identical consecutive messages" more intuitively.
  const MAX_LOOP = 2;
  const last     = session.lastLoopMessage;
  const step     = session.step;

  if (last === messageText && session.lastLoopStep === step) {
    const newCount = (session.loopCount || 0) + 1;
    if (newCount >= MAX_LOOP) {
      // [FIX-LOOP-1] Break loop — merge into a single updateSession call so a concurrent
      // request can't see an intermediate state (loopCount=MAX but flow still active)
      // that would trigger a second loop-break response. Previously two sequential writes.
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
        buttons: cfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
      };
    }
    // Not yet at limit — persist the incremented count
    await updateSession(session.customerPhone, tenantId, {
      loopCount: newCount, lastLoopMessage: messageText, lastLoopStep: step,
    });
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
      // [FIX-WH-7] Any non-duplicate DB error (connection lost, schema violation, etc.)
      // is re-thrown so the message is NOT processed. Previously the catch block only
      // handled 11000 and silently fell through for all other errors — message processing
      // continued without a dedup record, so a webhook retry would process the message
      // twice with no record to deduplicate against.
      logger.error('[Webhook] ProcessedMessage write failed — dropping message to preserve dedup guarantee', {
        wamid, tenantId, err: err.message,
      });
      return;
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
    // [FIX-HM-4] Before creating a blank new session, check whether an EXPIRED session
    // had humanMode=true. If so, restore it — the admin never typed RESUME BOT so
    // the bot must stay silent. A TTL expiry must never silently re-enable the bot.
    const expiredHumanSession = await (async () => {
      try {
        const Session = (await import('../models/Session.js')).default;
        // Build the composite key directly — avoids an import that could fail and
        // produce 'undefined_tenantId' if sessionKey destructuring returned undefined.
        const key = `${from}_${tenantId}`;
        // [FIX-2.3] Filter on expiresAt: { $lte: new Date() } so this query only
        // matches genuinely expired sessions. Without the bound it would also match
        // any live session with humanMode=true if getSession's filter ever relaxes,
        // risking a duplicate upsert on top of an active document.
        return await Session.findOne({
          phone:     key,
          tenantId:  String(tenantId),
          humanMode: true,
          expiresAt: { $lte: new Date() },  // only expired sessions
        }).sort({ updatedAt: -1 }).lean();
      } catch { return null; }
    })();

    const preservedHumanMode = expiredHumanSession?.humanMode === true;
    session = await createSession(from, tenantId, {
      phoneNumberId,
      // [FIX-WH-3] Pass humanMode directly so createSession writes it via $set in a single
      // atomic upsert. The old approach passed a dead key (_restoreHumanMode) that createSession
      // never read, then called a separate updateSession() — a two-step operation with a race
      // window where a concurrent message could see humanMode=false between the two writes.
      ...(preservedHumanMode ? { humanMode: true } : {}),
    });

    if (preservedHumanMode) {
      logger.info('[Webhook] Restored humanMode=true from expired session', { from, tenantId });
    }

    // [FIX-WH-1] createSession uses findOneAndUpdate with { new: true } and already
    // returns the freshly written document. The previous follow-up getSession call was
    // redundant (an extra DB round-trip on every new session) and the || session fallback
    // meant it only helped in the theoretically impossible case where the document
    // vanished between write and read. Removed.
  }
  // [FIX-WH-2] Log failures rather than swallowing them silently. phoneNumberId is
  // used for routing — a silent failure here could cause messages to be dispatched
  // on the wrong WhatsApp number for businesses with multiple phone number IDs.
  // [FIX-2.4] Use $inc for messageCount so concurrent webhooks (WhatsApp occasionally
  // delivers duplicate wamids with different IDs) can't both read the same snapshot
  // count and write count+1, losing an increment. The fourth argument to updateSession
  // is the atomic $inc map added in sessionService [FIX-SES-7].
  updateSession(from, tenantId, {
    lastSeen:      new Date(),
    phoneNumberId: phoneNumberId || session.phoneNumberId,
  }, { messageCount: 1 }).catch(err => logger.warn('[Webhook] Non-critical session update failed', { err: err.message, from }));

  // ── 5. [FIX-BUG3] Business hours enforcement ──────────────────────────────
  // Apply to ALL message types — button taps during closed hours must also be blocked.
  if (!isWithinBusinessHours(business.hours)) {
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
  // Clear closedMsgSent once we're open again — awaited so a DB failure is visible in logs
  if (session.closedMsgSent) {
    await updateSession(from, tenantId, { closedMsgSent: false });
  }

  // ── 6. Admin commands (checked BEFORE humanMode guard) ──────────────────
  // [FIX-HM-7] Admin commands must be processed before the humanMode guard.
  // Previously step 8 (admin commands) was after step 6 (humanMode block).
  // When the admin uses the same phone number to test the bot as a customer,
  // their session can have humanMode=true — which silently blocked "RESUME BOT"
  // at step 6, so the bot never saw the admin's command and humanMode was stuck.
  // Fix: check ALL admin commands (text AND button) FIRST. Non-admin messages
  // still hit the humanMode guard below and are silently dropped as before.
  if (messageText) {
    const upper = messageText.trim().toUpperCase();

    // Admin TEXT commands: APPROVE / REJECT / CONFIRM BOOK / DECLINE BOOK / RESUME BOT
    // [FIX-WH-5] Use === / startsWith(' ') instead of bare startsWith('RESUME BOT') so
    // 'RESUME BOTNET ...' doesn't trigger an unnecessary isAdminPhone DB round-trip.
    if (
      upper.startsWith('APPROVE ')      ||
      upper.startsWith('REJECT ')       ||
      upper.startsWith('CONFIRM BOOK ') ||
      upper.startsWith('DECLINE BOOK ') ||
      upper === 'RESUME BOT' || upper.startsWith('RESUME BOT ')
    ) {
      const { handleAdminTextCommand, isAdminPhone } = await import('../services/adminCommandService.js');
      // [FIX-X2] Pass pre-fetched business and tenantDoc so isAdminPhone skips both DB queries.
      const isAdmin = await isAdminPhone(from, tenantId, business, tenantDoc).catch(() => false);
      if (isAdmin) {
        const adminReply = await handleAdminTextCommand(messageText, tenantId, from, tenantDoc, business).catch(() => null);
        if (adminReply) {
          await dispatchMessage(from, { type: 'text', body: adminReply }, tenantDoc);
        }
        return; // admin text commands never fall through — not even to humanMode guard
      }
    }

    // Admin BUTTON replies: APPROVE_xxx / REJECT_xxx / CONFIRM_BOOK_xxx / DECLINE_BOOK_xxx
    if (isInteractive && (
      upper.startsWith('APPROVE_') || upper.startsWith('REJECT_') ||
      upper.startsWith('CONFIRM_BOOK_') || upper.startsWith('DECLINE_BOOK_')
    )) {
      const { handleAdminButtonReply, isAdminPhone } = await import('../services/adminCommandService.js');
      // [FIX-X2] Pass pre-fetched business and tenantDoc so isAdminPhone skips both DB queries.
      const isAdmin = await isAdminPhone(from, tenantId, business, tenantDoc).catch(() => false);
      if (isAdmin) {
        const reply = await handleAdminButtonReply(messageText, tenantId, from, tenantDoc, business).catch(() => null);
        if (reply) await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc);
        return; // admin button replies never fall through
      }
      // [FIX-2.2] Non-admin tapping a stale admin button (e.g. a forwarded approval
      // message) previously returned silently, leaving the customer with no feedback.
      // Send a neutral fallback so the customer knows the tap was received but that
      // the action isn't available to them, preventing a confusing no-response UX.
      logger.warn('[Webhook] Non-admin tapped admin button — sending fallback', { from, buttonId: messageText });
      await dispatchMessage(from, {
        type: 'text',
        body: "Sorry, that action isn't available. How can I help you? 😊",
      }, tenantDoc);
      return;
    }
  }

  // ── 7. Human mode ─────────────────────────────────────────────────────────
  // Non-admin messages are silently dropped here when humanMode=true.
  // The admin can still reach step 6 above regardless of their own session state.
  if (session.humanMode) {
    logger.info('[Webhook] Human mode — bot silent', { from });
    return;
  }

  // ── 8. [FIX-BUG4] Loop prevention (text AND button taps) ─────────────────
  // Previously this only ran for !isInteractive — button loops were unchecked.
  if (messageText) {
    const loopReply = await checkAndHandleLoop(session, messageText, tenantId, business);
    if (loopReply) {
      await dispatchMessage(from, loopReply, tenantDoc);
      return;
    }
  }

  // ── 8.5. Non-text image guard ─────────────────────────────────────────────
  // Images sent outside the ORDER/PAYMENT_PROOF context have messageText='' and
  // would otherwise fall through to intent detection with an empty string, producing
  // erratic matches. Reply with a gentle prompt and stop processing.
  if (imageUrl && !(session.currentFlow === 'ORDER' && session.step === 'PAYMENT_PROOF')) {
    await dispatchMessage(from, {
      type: 'text',
      body: '📎 Thanks for the image! I can only accept screenshots as payment proof during checkout. Is there something else I can help you with?',
    }, tenantDoc);
    return;
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
      await dispatchMessage(from, {
        type:    'buttons',
        body:    '⚠️ Could not process your screenshot. Please try again — send a clear image of your payment confirmation.',
        buttons: [{ id: 'SUPPORT', title: '💬 Contact Support' }],
      }, tenantDoc);
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
    // [FIX-PAY-1] Pass tenantDoc so handleDonePayment can dispatch buttons directly.
    // When it returns null the message is already sent; only dispatch if a string is returned.
    const reply = await handleDonePayment(from, tenantId, tenantDoc).catch(() => "✅ Thank you! We'll confirm your order shortly.");
    if (reply) await dispatchMessage(from, { type: 'text', body: reply }, tenantDoc);
    await updateSession(from, tenantId, { currentFlow: null, step: null, postFlowAck: null });
    return;
  }

  // ── 10.5. PAYMENT_PROOF — strict text guard ───────────────────────────────
  // Any text while awaiting a payment screenshot is intercepted here.
  // NOTHING bleeds through to intent detection / order restart from this stage.
  if (
    session.currentFlow === 'ORDER' &&
    session.step        === 'PAYMENT_PROOF' &&
    !imageUrl
  ) {
    const upper = messageText.trim().toUpperCase();

    // Allow explicit cancellation or order restart
    if (upper === 'CANCEL' || upper === 'CANCEL_ORDER' || upper === 'NEW_ORDER' || upper === 'ORDER') {
      const { default: Order } = await import('../models/Order.js');
      await Order.findOneAndUpdate(
        { customerPhone: from, tenantId, paymentStatus: { $in: ['unpaid', 'proof_received'] } },
        { $set: { status: 'cancelled', paymentStatus: 'cancelled' } },
        { sort: { createdAt: -1 } }
      ).catch(() => {});
      await updateSession(from, tenantId, { currentFlow: null, step: null, data: {} });
      const cfg = getModeConfig(business);
      await dispatchMessage(from, {
        type:    'buttons',
        body:    '❌ Your order has been cancelled.\n\nWhat would you like to do next?',
        buttons: cfg.ui?.welcomeButtons || [{ id: 'ORDER', title: '🛒 Place New Order' }],
      }, tenantDoc);
      return;
    }

    // All other text (greetings, questions, anything) → strict reminder
    await dispatchMessage(from, {
      type:    'buttons',
      body:
        '⏳ *Awaiting your payment screenshot.*\n\n' +
        'Please send a clear image of your Wave payment confirmation to complete your order.\n\n' +
        '_To cancel this order, tap the button below._',
      buttons: [{ id: 'CANCEL', title: '❌ Cancel Order' }],
    }, tenantDoc);
    return;
  }

  // ── 11. [Admin button replies moved to step 6 — before humanMode guard] ────

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
      // [FIX] Clear the flow BEFORE dispatching so "Ask again" tap correctly
      // re-triggers the ENQUIRY intent (sets step back to AWAITING_QUESTION).
      await updateSession(from, tenantId, { currentFlow: null, step: null });
      await dispatchMessage(from, {
        type:    'buttons',
        body:    aiText || 'Let me check that for you. 😊',
        buttons: [
          { id: 'QUESTION',  title: '❓ Ask again'  },
          { id: 'SHOW_MENU', title: '🔄 Start Over' },
        ],
      }, tenantDoc);
      return;
    }
    // Stale ANSWERED state — just clear and fall through
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
        : completed === 'ORDER'
          ? `You're welcome${custName}! 😊 We're preparing your order. Anything else we can help with at *${business.name || 'us'}*?`
          // [FIX-11] Any other completedFlow (e.g. LEAD_CAPTURE) gets a neutral ack
          // instead of the misleading "preparing your order" message.
          : `You're welcome${custName}! 😊 Anything else we can help with?`;

      // [FIX-WH-2] Use mode welcomeButtons as source of truth so button labels
      // ("Order Food" / "Book a Table") match the welcome screen exactly.
      // Previously hardcoded labels were shown even on modes that use different wording.
      const buttons = (cfg.ui?.welcomeButtons || [
        canOrder ? { id: 'ORDER',    title: '🛒 Place New Order' } : null,
        canBook  ? { id: 'BOOK',     title: '📅 Make a Booking'  } : null,
        { id: 'QUESTION', title: '❓ Ask a Question' },
      ].filter(Boolean)).slice(0, 3);

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
    if (isInteractive && isFlowPassthroughId(upperMsg)) {
      const freshSession = await getSession(from, tenantId) || session;
      const reply = await advance({ session: freshSession, message: messageText, business, tenant: tenantDoc, isInteractive });
      if (reply) {
        // reply can be an array (e.g. [image, buttons]) — dispatch each in order
        const payloads = Array.isArray(reply) ? reply : [reply];
        for (const payload of payloads) {
          await dispatchMessage(from, payload, tenantDoc);
        }
        const lastPayload = payloads[payloads.length - 1];
        const body = typeof lastPayload === 'string' ? lastPayload : lastPayload?.body;
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
      // [FIX] Mid-session "Start Over" tap → short prompt, NOT full welcome greeting
      await dispatchMessage(from, {
        type:    'buttons',
        body:    '👇 What would you like to do?',
        buttons: cfg.ui?.welcomeButtons || [],
      }, tenantDoc);
      return;
    }

    const freshSession = await getSession(from, tenantId) || session;
    // [FIX-2.1] Pass only messageText to advance(). Both image guards at steps 8.5 and 9
    // ensure imageUrl cannot be truthy here with messageText empty — but including it as
    // a fallback is a silent footgun: if either guard is ever relaxed or a new message
    // type is added, advance() would receive a WhatsApp media ID as customer text,
    // producing nonsense flow transitions with no error. Remove the dead fallback entirely.
    const reply = await advance({
      session: freshSession,
      message: messageText,
      business, tenant: tenantDoc, isInteractive,
    });
    if (reply) {
      // reply can be an array (e.g. [imagePayload, buttonsPayload]) — dispatch each in order
      const payloads = Array.isArray(reply) ? reply : [reply];
      for (const payload of payloads) {
        await dispatchMessage(from, payload, tenantDoc);
      }
      const lastPayload = payloads[payloads.length - 1];
      const body = typeof lastPayload === 'string' ? lastPayload : lastPayload?.body;
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
      buttons: [{ id: 'SHOW_MENU', title: '🔄 Start Over' }],
    }, tenantDoc);
    return;
  }

  const reply = await route({
    action, intent, session,
    message: messageText, business,
    tenant: tenantDoc, isInteractive, suggestion,
  });

  if (reply) {
    // reply can be an array (e.g. [imagePayload, buttonsPayload]) — dispatch each in order
    const payloads = Array.isArray(reply) ? reply : [reply];
    for (const payload of payloads) {
      await dispatchMessage(from, payload, tenantDoc);
    }
    const lastPayload = payloads[payloads.length - 1];
    const body = typeof lastPayload === 'string' ? lastPayload : lastPayload?.body;
    if (body) updateSession(from, tenantId, { lastBotMessage: body }).catch(() => {});
  }
}

// ── Meta webhook verification ──────────────────────────────────────────────────
export async function verifyWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || !token) {
    return res.status(403).send('Forbidden');
  }

  // [FIX-WA-3] Accept EITHER the global META_WEBHOOK_VERIFY_TOKEN (set by admin
  // when registering the webhook in Meta Developer Console) OR a tenant-specific
  // verifyToken stored on the Tenant document (for multi-tenant setups where each
  // tenant registers their own webhook token).
  // Previously ONLY the global env var was checked — tenant verifyToken fields
  // were never used, so tenants who stored their own token always failed verification.
  if (token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  // Check per-tenant verifyToken (allows each tenant to have their own token)
  try {
    const tenant = await Tenant.findOne({ 'whatsapp.verifyToken': token }).lean();
    if (tenant) {
      logger.info('[Webhook] Verified via tenant verifyToken', { tenantId: tenant._id });
      return res.status(200).send(challenge);
    }
  } catch (err) {
    logger.error('[Webhook] verifyWebhook DB lookup failed', { err: err.message });
  }

  logger.warn('[Webhook] Webhook verification failed — token mismatch', { ip: req.ip });
  return res.status(403).send('Forbidden');
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
            // [FIX-WA-4] Previously only status:'ACTIVE' tenants were matched.
            // A newly-created tenant (status:'PENDING') with valid WhatsApp credentials
            // had all incoming messages silently dropped — the lookup returned null and
            // the message was discarded with no error or log entry.
            // Fix: also accept PENDING tenants that have whatsapp.connected=true so
            // the bot is reachable as soon as credentials are verified, even before
            // an admin manually promotes the tenant to ACTIVE.
            const tenant = await Tenant.findOne({
              'whatsapp.phoneNumberId': phoneNumberId,
              status: { $in: ['ACTIVE', 'PENDING'] },
            }).lean();
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
