/**
 * controllers/webhookController.js — Dreamline Sales Bot v11.0
 *
 * PIPELINE (strictly sequential):
 *   1. Receive & verify (signature, dedup, tenant lookup)
 *   2. Guard (suspended, botEnabled, business hours, human mode)
 *   3. Extract message (text / image / interactive)
 *   4. Session get-or-create
 *   5. Brain  → { action, ui?, reply?, intent? }    [LAYER 1: decision]
 *   6. Flow   → ui object or string                 [LAYER 2: logic]
 *   7. Dispatch → WhatsApp API                      [LAYER 3: delivery]
 *
 * CRITICAL RULES:
 * - dispatch() is called EXACTLY ONCE per inbound message.
 * - When a flow is ACTIVE, ONLY handleFlow() runs — no action switch.
 * - brainService only returns INTERRUPT/CANCEL/SHOW_MENU for active flows.
 */

import { getSession, createSession, updateSession, clearSession } from '../services/sessionService.js';
import { dispatch }                                                   from '../services/messageService.js';
import { getBusiness }                                            from '../services/businessService.js';
import { think }                                                  from '../services/brainService.js';
import { handleFlow, startOrderFlow, startBookingFlow, handleEnquiry } from '../services/flowService.js';
import { buildWelcomeUI, buildCancelUI, buildSmartFallbackUI } from '../utils/messageBuilders.js';
import { trackFailedInteraction }                                 from '../services/analyticsService.js';
import { getAIReply, generateGreeting, answerAboutQuestion }      from '../services/groqService.js';
import { receiveProof, handleDonePayment }                        from '../services/paymentService.js';
import { isAdminPhone, handleAdminButtonReply, handleAdminTextCommand } from '../services/adminPaymentHandler.js';
import { shouldCaptureLead, startLeadCapture, handleLeadCapture } from '../services/leadCaptureService.js';
import UserProfile from '../models/UserProfile.js';
import Tenant  from '../models/Tenant.js';
import logger  from '../config/logger.js';
import { createHmac, timingSafeEqual } from 'crypto';

// ─── Signature verification ───────────────────────────────────────────────────

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;

  // No secret set → skip verification (warn so dev knows)
  if (!secret) {
    logger.warn('[Webhook] META_APP_SECRET not set — skipping signature verification');
    return true;
  }

  // [FIX] In development mode, allow unsigned requests so you can test
  // with curl / Bruno / Postman without having to compute HMAC manually.
  // NEVER set this in production.
  if (process.env.NODE_ENV === 'development' && process.env.SKIP_WEBHOOK_SIGNATURE === 'true') {
    logger.warn('[Webhook] SKIP_WEBHOOK_SIGNATURE=true — skipping signature check (dev only)');
    return true;
  }

  if (!signatureHeader) return false;
  const [scheme, theirHex] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !theirHex) return false;

  // [FIX] Guard against empty/missing rawBody — if express.raw() didn't run
  // (e.g. wrong Content-Type header from Meta) rawBody may be undefined.
  // Fall back to empty buffer so HMAC still runs and fails gracefully.
  const body   = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ? String(rawBody) : '');
  const ourHex = createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(ourHex, 'hex'), Buffer.from(theirHex, 'hex'));
  } catch { return false; }
}

// ─── Extract message ──────────────────────────────────────────────────────────

function extractMessage(msgObj) {
  const type = msgObj?.type;

  if (type === 'text') {
    return { text: (msgObj.text?.body || '').trim(), imageUrl: null, isInteractive: false };
  }

  if (type === 'interactive') {
    const btnReply  = msgObj.interactive?.button_reply;
    const listReply = msgObj.interactive?.list_reply;
    // Use stable ID (e.g. "1","2" for list rows; "ORDER","BOOK","CONFIRM","CANCEL" for buttons)
    if (btnReply)  return { text: (btnReply.id  || btnReply.title  || '').trim(), imageUrl: null, isInteractive: true };
    if (listReply) return { text: (listReply.id || listReply.title || '').trim(), imageUrl: null, isInteractive: true };
    return { text: '', imageUrl: null, isInteractive: true };
  }

  if (type === 'image') {
    const imageId  = msgObj.image?.id;
    const imageUrl = msgObj.image?.url || (imageId ? `wa-media:${imageId}` : null);
    return { text: '', imageUrl, isInteractive: false };
  }

  return { text: '', imageUrl: null, isInteractive: false };
}

// ─── Wamid deduplication ──────────────────────────────────────────────────────
//
// The previous implementation had a race condition:
//   1. _wamidCache.set() was called BEFORE the DB write
//   2. lastWamid was only written to the session AFTER all processing (line ~235)
//   3. If Meta retried within milliseconds (before DB write), both requests would
//      pass the DB check and process the same message twice → duplicate replies
//
// New approach: use a MongoDB atomic findOneAndUpdate with $setOnInsert to write
// the wamid to a dedicated ProcessedMessage collection IMMEDIATELY and atomically
// before any other processing. This is safe under concurrent requests because
// MongoDB's write concern ensures only one upsert wins.
//
// We keep a small in-memory Set as a fast first-pass cache to avoid DB round-trips
// for the common case, but the DB write is always the source of truth.

import ProcessedMessage from '../models/ProcessedMessage.js';

const _wamidCache = new Set();
const WAMID_CACHE_MAX = 1000; // LRU-lite: clear when too large

/**
 * Atomically record a wamid and return whether it was a duplicate.
 * Returns true (= duplicate, skip) if this wamid was already seen.
 * Returns false (= new, proceed) on first occurrence.
 */
async function isDuplicate(wamid, tenantId) {
  // Fast path: in-memory cache check (process-local, resets on restart)
  if (_wamidCache.has(wamid)) return true;

  // Slow path: atomic DB upsert — only one concurrent request can create the doc
  try {
    const result = await ProcessedMessage.findOneAndUpdate(
      { wamid, tenantId: String(tenantId) },
      { $setOnInsert: { wamid, tenantId: String(tenantId), processedAt: new Date() } },
      { upsert: true, new: false }, // new:false → returns null if inserted (new doc), existing doc if duplicate
    );
    // result is null when a new doc was just inserted → NOT a duplicate
    // result is the existing doc when wamid already existed → IS a duplicate
    if (result !== null) return true;
  } catch (err) {
    // Duplicate key error (E11000) means another concurrent request already inserted it
    if (err.code === 11000) return true;
    // Other DB errors — log and let it through (fail open to avoid blocking legitimate messages)
    logger.error('[Webhook] isDuplicate DB error — allowing message through', { wamid, err: err.message });
  }

  // Add to in-memory cache — evict the oldest entry when at capacity.
  // Set preserves insertion order, so values().next().value is always the
  // oldest entry. Deleting one-at-a-time avoids the thundering-herd of DB
  // dedup writes that a full _wamidCache.clear() would cause under high load.
  if (_wamidCache.size >= WAMID_CACHE_MAX) {
    _wamidCache.delete(_wamidCache.values().next().value);
  }
  _wamidCache.add(wamid);
  return false;
}

// ─── Business hours ───────────────────────────────────────────────────────────

function isBusinessOpen(business) {
  if (process.env.DISABLE_WORKING_HOURS === 'true') return true;
  const hours = business?.hours;
  if (!hours?.enabled) return true;
  const tz  = hours.timezone || 'UTC';
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' }).toLowerCase();
  const localStr = now.toLocaleString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  const [rawH, rawM] = localStr.split(':');
  // toLocaleString with hour12:false and hour:'2-digit' always returns "00"–"23".
  // The previous `% 24` was dead code and has been removed.
  const currentMinutes = parseInt(rawH, 10) * 60 + parseInt(rawM, 10);
  const dayConfig = (hours.days instanceof Map) ? hours.days.get(day) : (hours.days?.[day] ?? null);
  if (dayConfig) {
    if (dayConfig.closed === true) return false;
    if (dayConfig.open != null && dayConfig.close != null) {
      return currentMinutes >= dayConfig.open * 60 && currentMinutes < dayConfig.close * 60;
    }
  }
  return currentMinutes >= (hours.open ?? 8) * 60 && currentMinutes < (hours.close ?? 22) * 60;
}

// ─── Webhook verification (GET) ───────────────────────────────────────────────

export const verifyWebhook = async (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode !== 'subscribe' || !token || !challenge) return res.sendStatus(403);
  const phoneNumberId = req.params.phoneNumberId;
  if (phoneNumberId) {
    // Phone-scoped verification: ONLY accept the token registered for this phoneNumberId.
    // Do NOT fall through to the global META_WEBHOOK_VERIFY_TOKEN — that would allow
    // the global token to verify any phone number's webhook (security hole).
    try {
      const tenant = await Tenant.findOne(
        { 'whatsapp.phoneNumberId': phoneNumberId },
        'whatsapp.verifyToken',
      ).lean();
      if (tenant?.whatsapp?.verifyToken && token === tenant.whatsapp.verifyToken) {
        return res.status(200).send(challenge);
      }
    } catch (err) {
      logger.error('[verifyWebhook] DB error', { err: err.message });
    }
    // phoneNumberId present but no tenant matched or token mismatch → reject.
    return res.sendStatus(403);
  }
  // No phoneNumberId in URL (bare /webhook GET from Meta's app setup panel).
  // Fall back to the global verify token.
  if (token === process.env.META_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
};

// ─── Main webhook handler (POST) ─────────────────────────────────────────────

export const handleWebhook = async (req, res) => {
  if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    logger.warn('[Webhook] Invalid signature — rejected');
    return res.sendStatus(403);
  }

  res.sendStatus(200); // ACK immediately

  try {
    const body = req.body;
    if (!body?.object) return;

    // Meta may bundle multiple entries or changes in a single POST.
    // Previously only entry[0].changes[0] was processed — all others were silently
    // dropped. Now we iterate every entry → every change → every message.
    const entries = body.entry;
    if (!Array.isArray(entries) || entries.length === 0) return;

    for (const entry of entries) {
      const changes = entry?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const value = change?.value;
        // Explicitly skip delivery/read status updates from WhatsApp.
        // WhatsApp sends statuses (sent, delivered, read) as value.statuses — if we
        // don't filter these early they could theoretically reach processing code.
        if (value?.statuses?.length && !value?.messages?.length) continue;
        if (!value?.messages?.length) continue;

        // [FIX-4] Iterate ALL messages in this change, not just messages[0].
        // Meta can batch multiple messages in a single change payload; previously
        // only the first was processed and all others were silently dropped.
        for (const msgObj of value.messages) {
        const wamid         = msgObj.id;
        const from          = msgObj.from;
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!from || !phoneNumberId) continue;

        // ── [FIX] Inbound-only guard ─────────────────────────────────────
        // Bot ONLY reacts to genuine customer messages — never its own echoes,
        // system events, or reactions. Zero proactive/unsolicited messages.
        const skipTypes = new Set(['message_echo', 'system', 'reaction']);
        if (skipTypes.has(msgObj.type)) {
          logger.debug('[Webhook] Skipping non-customer message type', { type: msgObj.type, from });
          continue;
        }
        // Meta echoes outbound messages back with context.from === phoneNumberId
        if (msgObj.context?.from === phoneNumberId) {
          logger.debug('[Webhook] Skipping echo (context.from matches bot)', { from });
          continue;
        }

        try {

    // ── STEP 1: Extract ───────────────────────────────────────────────────
    const { text: messageText, imageUrl, isInteractive } = extractMessage(msgObj);

    // ── STEP 2: Tenant lookup ─────────────────────────────────────────────
    const tenantDoc = await Tenant.findOne({ 'whatsapp.phoneNumberId': phoneNumberId }).lean();
    if (!tenantDoc) {
      logger.warn('[Webhook] Unknown phoneNumberId', { phoneNumberId });
      continue;
    }

    const tenantId = tenantDoc._id;

    // ── STEP 2b: Early suspend check ─────────────────────────────────────
    // Do this BEFORE the dedup write so suspended tenants don't pollute
    // the ProcessedMessage collection with records that will never be processed.
    // NOTE: must be `continue` not `return` — we're inside a for-of loop and
    // `return` would abort the entire handler, dropping all remaining batched messages.
    if (tenantDoc.status === 'SUSPENDED') continue;

    // ── STEP 2c: Plan message limit enforcement ───────────────────────────
    // Increment usage counter atomically. If the tenant has exceeded their
    // monthly message limit, send a polite over-limit reply and stop processing.
    // Fire-and-forget the increment so it never blocks the message pipeline.
    const monthlyLimit = tenantDoc.limits?.messagesPerMonth ?? 500;
    const currentUsage = tenantDoc.usage?.messagesThisMonth ?? 0;
    if (currentUsage >= monthlyLimit) {
      // Over limit — notify customer and skip processing (don't send from bot)
      logger.warn('[Webhook] Tenant over message limit', {
        tenantId, usage: currentUsage, limit: monthlyLimit,
      });
      await dispatch(from, {
        type: 'text',
        body: `We're currently experiencing high demand and cannot process your message right now. Please try again later or contact us directly. 🙏`,
      }, tenantDoc);
      continue;
    }
    // Increment usage — atomic, non-blocking
    Tenant.findByIdAndUpdate(tenantId, { $inc: { 'usage.messagesThisMonth': 1 } })
      .catch(err => logger.warn('[Webhook] Usage increment failed', { err: err.message, tenantId }));

    // ── STEP 3: Deduplication ─────────────────────────────────────────────
    // Use tenantId-scoped atomic dedup
    // Guard: malformed payloads may omit msgObj.id — skip dedup
    // (fail-open) rather than crashing on an undefined wamid.
    if (wamid && await isDuplicate(wamid, tenantId)) {
      logger.debug('[Webhook] Duplicate wamid skipped', { wamid });
      continue;
    }

    // ── STEP 4: Guards ────────────────────────────────────────────────────
    const business = await getBusiness(tenantId);
    if (!business) {
      logger.warn('[Webhook] No BusinessConfig', { tenantId });
      continue;
    }

    if (!isBusinessOpen(business)) {
      const closedMsg =
        business?.customMessages?.closed ||
        business?.settings?.closedMessage ||
        'We are currently closed. Please contact us during business hours.';
      await dispatch(from, { type: 'text', body: closedMsg }, tenantDoc);
      continue;
    }

    // NOTE: must be `continue` not `return` — see SUSPENDED check above.
    if (business.botEnabled === false) continue;

    // ── STEP 4b: Admin phone detection ───────────────────────────────────
    // If the sender is an admin, route to the admin payment handler.
    // Admin flow is completely separate from customer flow.
    const senderIsAdmin = await isAdminPhone(from, tenantId);

    if (senderIsAdmin) {
      let adminReply = null;

      if (isInteractive) {
        // Admin tapped a button (Approve / Reject)
        const buttonId = msgObj?.interactive?.button_reply?.id;
        if (buttonId) {
          adminReply = await handleAdminButtonReply(buttonId, from, tenantId, tenantDoc, business);
        }
      }

      // Fallback: admin typed "APPROVE <id>" or "REJECT <id>"
      // [FIX-9] Guard with a cheap prefix check before calling handleAdminTextCommand.
      // Previously every admin text — including casual chat — triggered a
      // BusinessConfig.findOne + Order.find inside handleAdminTextCommand.
      // Only APPROVE/REJECT commands need that path.
      if (!adminReply && messageText) {
        const upperMsg = messageText.trim().toUpperCase();
        if (upperMsg.startsWith('APPROVE') || upperMsg.startsWith('REJECT')) {
          adminReply = await handleAdminTextCommand(messageText, tenantId, from, tenantDoc, business);
        }
      }

      if (adminReply) {
        await dispatch(from, { type: 'text', body: adminReply }, tenantDoc);
        continue; // Admin interaction fully handled — move to next change
      }

      // Admin sent something else (e.g. normal chat) — fall through to normal flow
    }

    // ── STEP 5: Session ───────────────────────────────────────────────────
    let session    = await getSession(from, tenantId);
    const isNewSession = !session;

    if (!session) {
      session = await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
    }

    // Re-fetch session to get the latest DB state after createSession upsert.
    session = (await getSession(from, tenantId)) || session;

    // If this is a brand-new customer and their first message is unrecognisable
    // (e.g. a forwarded paragraph, a random emoji, or something that won't match
    // any brain intent), respond with the friendly welcome menu so they always
    // know what the bot can do — never silently ignore a first contact.
    // NOTE: the bot NEVER sends a message unless the customer wrote first.
    // There are zero proactive / unsolicited messages in this codebase.
    if (isNewSession && !isInteractive && !messageText) {
      // Image or unsupported type on very first contact — show friendly welcome
      await dispatch(from, buildWelcomeUI(business), tenantDoc);
      continue;
    }

    // ── STEP 5b: Lead Capture ─────────────────────────────────────────────
    // Intercept new customers before routing to the normal brain pipeline.
    // Only fires when business.leadCapture.enabled=true AND triggerOn='FIRST_MESSAGE'.
    if (isNewSession && messageText && !isInteractive) {
      const captureNow = await shouldCaptureLead(business, session, 'FIRST_MESSAGE').catch(() => false);
      if (captureNow) {
        const leadMsg = await startLeadCapture(session, business);
        await dispatch(from, leadMsg, tenantDoc);
        continue;
      }
    }

    // Route active LEAD_CAPTURE flow before anything else so the brain never
    // misclassifies the customer's name/email as an ORDER or BOOKING intent.
    if (session.currentFlow === 'LEAD_CAPTURE') {
      const leadReply = await handleLeadCapture(session, messageText || '', business, tenantDoc).catch(err => {
        logger.error('[Webhook] Lead capture error', { from, err: err.message });
        return { type: 'text', body: 'Sorry, something went wrong. Please try again.' };
      });
      await dispatch(from, leadReply, tenantDoc);
      continue;
    }

    // NOTE: must be `continue` not `return` — see SUSPENDED check above.
    if (session.humanMode === true) {
      // Human mode is ON — a live agent is handling this conversation.
      // Only send the acknowledgement on the FIRST message so we don't spam
      // the customer with the same notice on every text they send.
      const alreadyNotified = session.humanModeNotified === true;
      if (!alreadyNotified) {
        const humanModeMsg =
          business?.customMessages?.humanMode?.trim() ||
          '👤 You\'re now chatting with our team directly. We\'ll reply shortly — thanks for your patience! 😊\n\nType *menu* or *0* anytime to return to the bot.';
        await dispatch(from, { type: 'text', body: humanModeMsg }, tenantDoc);
        updateSession(from, tenantId, { humanModeNotified: true }).catch(() => {});
      }
      continue;
    }

    // ── STEP 6: Image handling ────────────────────────────────────────────
    if (imageUrl) {
      // Accept payment proof in PAYMENT_PROOF step OR when customer is in the
      // awaiting_rejection_action state and chooses to resend (they may send
      // the image directly without tapping the Resend button first).
      const isPaymentProofStep = session.currentFlow === 'ORDER' && session.step === 'PAYMENT_PROOF';
      const isRejectionResend  = session.mode === 'awaiting_rejection_action';

      if (isPaymentProofStep || isRejectionResend) {
        // [FIX-ORDER-TRACK] Pass the stored orderId so receiveProof can query
        // by _id directly. This is critical for re-uploads after rejection where
        // the paymentStatus is 'payment_failed' (not in the old phone+status query).
        const sessionOrderId = session.data?.orderId || session.data?.rejectedOrderId || null;

        // If resending from rejection state, put session back into PAYMENT_PROOF
        // first so the flow is consistent after this image is processed.
        if (isRejectionResend && !isPaymentProofStep) {
          await updateSession(from, tenantId, {
            mode:        null,
            currentFlow: 'ORDER',
            step:        'PAYMENT_PROOF',
          });
        }

        const replyText = await receiveProof(from, tenantId, imageUrl, tenantDoc, business, sessionOrderId);
        // [FIX-5] dispatch BEFORE clearSession.
        // Previously clearSession was called before dispatch — if dispatch threw,
        // the session was already gone and the customer received no confirmation.
        // The order IS recorded and admin IS notified regardless; the customer
        // just silently lost their "Payment proof received" reply.
        await dispatch(from, { type: 'text', body: replyText }, tenantDoc);
        await clearSession(from, tenantId);
        continue;
      }
      const hint = session.currentFlow === 'ORDER'
        ? 'Please complete your order first, then send your payment screenshot when prompted.'
        : 'I can only understand text messages right now 😊\n\nType *Order*, *Book*, or *Hi* to get started.';
      await dispatch(from, { type: 'text', body: hint }, tenantDoc);
      continue;
    }

    // ── STEP 7: Non-text guard ────────────────────────────────────────────
    if (!messageText) {
      await dispatch(from, {
        type: 'text',
        body: 'I can only understand text messages right now 😊\n\nType *Order*, *Book*, or *Hi* to get started.',
      }, tenantDoc);
      continue;
    }

    // ── STEP 7b: DONE payment (no-proof flow) ───────────────────────────
    // When requireProof=false, customer types DONE to confirm payment.
    if (
      session.currentFlow === 'ORDER' &&
      session.step === 'PAYMENT_PROOF' &&
      messageText.trim().toUpperCase() === 'DONE'
    ) {
      const replyText = await handleDonePayment(from, tenantId);
      // [FIX-5b] dispatch BEFORE clearSession — mirrors the same fix applied
      // to the image proof path above. If dispatch throws (network error,
      // expired token), the session must still be intact so the customer
      // can retry. Clearing first left them with no session AND no reply.
      await dispatch(from, { type: 'text', body: replyText }, tenantDoc);
      await clearSession(from, tenantId);
      continue;
    }

    // ── STEP 7c: awaiting_question — customer has sent their actual question ──
    // The ENQUIRY handler already set session.mode = 'awaiting_question' and
    // asked the customer "What would you like to know?".
    // The NEXT message they send IS the real question — route directly to
    // handleEnquiry so the brain doesn't misclassify it as ORDER/BOOKING/etc.
    //
    // [SPEC FIX] Guard: if the customer sends a greeting (hi, hello, hey, start)
    // instead of a question, exit awaiting state gracefully and show the welcome
    // menu — never send "hi" to Groq as if it were a business question.
    if (session.mode === 'awaiting_question' && messageText) {
      const _GREETING_RESET = /^(hi|hello|hey|start|begin|good morning|good afternoon|good evening|menu|home|0|salaam|salam)$/i;
      if (_GREETING_RESET.test(messageText.trim())) {
        await updateSession(from, tenantId, { mode: null });
        await clearSession(from, tenantId);
        await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
        await dispatch(from, buildWelcomeUI(business), tenantDoc);
        continue;
      }
      const questionReply = await handleEnquiry(session, messageText, business, tenantDoc);
      await dispatch(from, questionReply, tenantDoc);
      const replyBody = typeof questionReply === 'string' ? questionReply : questionReply?.body;
      if (replyBody) updateSession(from, tenantId, { lastBotMessage: replyBody }).catch(() => {});
      continue;
    }

    // ── STEP 7d: awaiting_rejection_action — admin rejected payment, customer must decide ──
    // [v12 FIX] Button-first UX: button IDs (REJECTION_RESEND / REJECTION_SUPPORT /
    // REJECTION_CANCEL) are the primary path. Text fallbacks still supported for
    // customers who type instead of tap.
    if (session.mode === 'awaiting_rejection_action') {
      // Build the button UI helper — used for re-prompts and first presentation
      const rejectionButtonUI = {
        type: 'buttons',
        body: `What would you like to do?`,
        buttons: [
          { id: 'REJECTION_RESEND',  title: '📸 Resend Proof'    },
          { id: 'REJECTION_SUPPORT', title: '🤝 Contact Support' },
          { id: 'REJECTION_CANCEL',  title: '❌ Cancel Order'    },
        ],
      };

      if (!messageText) {
        // Non-text (image at wrong state, etc.) — re-show buttons
        await dispatch(from, rejectionButtonUI, tenantDoc);
        continue;
      }

      const normalized = messageText.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');

      const isResend  = messageText === 'REJECTION_RESEND'  || ['1', 'resend', 'resend payment', 'resend proof', 'retry', 'send again'].includes(normalized);
      const isSupport = messageText === 'REJECTION_SUPPORT' || ['2', 'support', 'contact support', 'help', 'agent'].includes(normalized);
      const isCancel  = messageText === 'REJECTION_CANCEL'  || ['3', 'cancel', 'cancel order'].includes(normalized);

      if (isResend) {
        // Put customer back into PAYMENT_PROOF step.
        // [FIX-ORDER-TRACK] Preserve session.data (which contains rejectedOrderId)
        // so receiveProof can query by _id when the screenshot arrives.
        await updateSession(from, tenantId, {
          mode:        null,
          currentFlow: 'ORDER',
          step:        'PAYMENT_PROOF',
          // data is NOT overwritten — rejectedOrderId and order details remain intact
        });
        await dispatch(from, {
          type: 'text',
          body: `No problem — please send a new screenshot of your Wave payment and we'll verify it right away. 📸`,
        }, tenantDoc);
        updateSession(from, tenantId, { lastBotMessage: '' }).catch(() => {});

      } else if (isSupport) {
        await updateSession(from, tenantId, { mode: null });
        await dispatch(from, {
          type: 'text',
          body: `🤝 *Support*\n\nOur team will assist you with your payment issue.\n\nPlease describe your problem and we'll get back to you as soon as possible.`,
        }, tenantDoc);
        updateSession(from, tenantId, { lastBotMessage: '' }).catch(() => {});

      } else if (isCancel) {
        await clearSession(from, tenantId);
        await dispatch(from, buildCancelUI(business), tenantDoc);

      } else {
        // Unrecognised — re-show action buttons (never dead-end text)
        await dispatch(from, rejectionButtonUI, tenantDoc);
      }

      continue;
    }

    // ── STEP 8: Brain (Layer 1 — decision) ───────────────────────────────
    const { action, ui: brainUI, reply: brainReply, intent, suggestion: brainSuggestion } = await think({
      message: messageText, session, business, phone: from,
    });

    logger.debug('[Webhook] Brain decision', { from, action, intent, step: session.step, flow: session.currentFlow });

    // [MEM] Persist lastIntent for groqService memory — fire-and-forget, never blocks pipeline.
    // brainService also writes synchronously inside think(), this is a belt-and-suspenders guard.
    if (intent && intent !== 'UNKNOWN') {
      updateSession(from, tenantId, { lastIntent: intent }).catch(() => {});
    }

    // ── STEP 8b: IGNORE — dedup guard, message is an echo of bot's last reply ──
    if (action === 'IGNORE') {
      logger.debug('[Webhook] Ignored duplicate/echo message', { from });
      continue;
    }

    // ── STEP 9: INTERRUPT — store state, send switch prompt, stop ─────────
    // Capture session.step BEFORE overwriting it
    if (action === 'INTERRUPT') {
      await updateSession(from, tenantId, {
        previousStep:  session.step,
        previousFlow:  session.currentFlow,
        step:          'INTERRUPT',
        pendingIntent: intent,
      });
      await dispatch(from, brainUI || (brainReply ? { type: 'text', body: brainReply } : null), tenantDoc);
      continue;
    }

    // ── STEP 10: REJECT_FLOW — user doesn't want this flow ────────────────
    // e.g. "i dont want to book", "not interested", "never mind"
    if (action === 'REJECT_FLOW' && session.currentFlow) {
      // Clone UI before mutation — never modify the shared builder result
      await clearSession(from, tenantId);
      await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
      const baseUI = buildWelcomeUI(business);
      const rejectionReply = { ...baseUI, body: 'No problem 👍\n\n' + (baseUI.body || '') };
      await dispatch(from, rejectionReply, tenantDoc);
      continue;
    }

    // ── STEP 10b: CANCEL from brain mid-flow ──────────────────────────────
    if (action === 'CANCEL' && session.currentFlow) {
      // When at CONFIRM, DATE_CONFIRM, or TIME_CONFIRM, the confirmation buttons
      // use specific IDs (CONFIRM / DATE_BACK / TIME_BACK). If the brain ever
      // sees a stray CANCEL at these steps, fall through to handleFlow so the
      // step-specific logic can decide what to do rather than nuking the session.
      const confirmSteps = new Set(['CONFIRM', 'DATE_CONFIRM', 'TIME_CONFIRM']);
      if (!confirmSteps.has(session.step)) {
        await clearSession(from, tenantId);
        await dispatch(from, buildCancelUI(business), tenantDoc);
        continue;
      }
      // Fall through to handleFlow for confirm-family step cancellations ↓
    }

    // ── STEP 11: SHOW_MENU mid-flow ───────────────────────────────────────
    if (action === 'SHOW_MENU' && session.currentFlow) {
      await clearSession(from, tenantId);
      await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
      await dispatch(from, buildWelcomeUI(business), tenantDoc);
      continue;
    }

    // ── STEP 12: Active flow → flowService handles EVERYTHING ─────────────
    // This is the ONLY place we call handleFlow when a flow is active.
    // List reply IDs (isInteractive=true) go straight here, no re-classify.
    // We already handled INTERRUPT / REJECT_FLOW / CANCEL / SHOW_MENU above.
    if (session.currentFlow) {

      // [FIX] Re-fetch session once at the top of the active-flow block.
      // Several updateSession() calls above (lastIntent, lastMessage) change
      // DB state but not the local `session` object.
      session = (await getSession(from, tenantId)) || session;

      // ENQUIRY — user signalled confusion or asked for help mid-flow.
      // ("enquiry", "i don't understand", "help", "i have a question", etc.)
      // We answer without clearing the session so they can continue their flow.
      if (action === 'ENQUIRY') {
        const enquiryReply = await handleEnquiry(session, messageText, business, tenantDoc);
        await dispatch(from, enquiryReply, tenantDoc);
        const replyBody = typeof enquiryReply === 'string' ? enquiryReply : enquiryReply?.body;
        if (replyBody) updateSession(from, tenantId, { lastBotMessage: replyBody }).catch(() => {});
        continue;
      }

      // AI_FALLBACK — user sent something unrecognised mid-flow.
      // Groq answers the question (about business, general help) WITHOUT touching
      // the cart/order/totals. The flow stays intact.
      if (action === 'AI_FALLBACK') {
        let aiReply = null;
        try {
          aiReply = await getAIReply(messageText, business, session, intent || 'FALLBACK');
        } catch { /* swallow */ }
        if (aiReply) {
          // Send the AI answer, then re-prompt the current step so the customer
          // knows exactly what to do next — flow stays intact.
          await dispatch(from, { type: 'text', body: aiReply }, tenantDoc);
          // Re-prompt the current step (fire handleFlow with a synthetic "re-show" trigger)
          const freshSession = (await getSession(from, tenantId)) || session;
          const stepReprompt = await handleFlow(freshSession, '', tenantDoc, false).catch(() => null);
          if (stepReprompt) await dispatch(from, stepReprompt, tenantDoc);
          continue;
        }
        // AI failed → fall through to flowService to handle natively
      }

      // AI_PAYMENT_HELP — user asked about payment while mid-flow.
      // Groq explains Wave payment in context of current order.
      if (action === 'AI_PAYMENT_HELP') {
        let paymentReply = null;
        try {
          paymentReply = await getAIReply(messageText, business, session, 'PAYMENT');
        } catch { /* swallow */ }
        if (paymentReply) {
          await dispatch(from, { type: 'text', body: paymentReply }, tenantDoc);
          continue;
        }
        // Fallback: tell them about payment manually
        const wavePhone = business?.payment?.wavePhone?.trim() || business?.wavePhone?.trim();
        const fallbackMsg = wavePhone
          ? `You can pay via *Wave* to *${wavePhone}* after confirming your order. 💳`
          : `Payment details will be shown after you confirm your order. 📱`;
        await dispatch(from, { type: 'text', body: fallbackMsg }, tenantDoc);
        continue;
      }

      const reply = await handleFlow(session, messageText, tenantDoc, isInteractive);
      if (reply) {
        await dispatch(from, reply, tenantDoc);
        // Track last bot reply for dedup guard
        const replyBody = typeof reply === 'string' ? reply : reply?.body;
        if (replyBody) updateSession(from, tenantId, { lastBotMessage: replyBody }).catch(() => {});
      }
      continue;
    }

    // ── STEP 13: No active flow → action switch ───────────────────────────
    let responseUI = null;

    switch (action) {

      case 'START_ORDER': {
        // [FIX] If a flow is already active (e.g. Meta delivered 3 copies of the same
        // message and all three hit this case), don't restart — just continue from where
        // they are. Without this, rapid-fire messages cause 3x menu sends.
        const existingSession = await getSession(from, tenantId);
        if (existingSession?.currentFlow === 'ORDER') {
          responseUI = await handleFlow(existingSession, messageText, tenantDoc, isInteractive);
        } else {
          responseUI = await startOrderFlow(session, business);
        }
        break;
      }

      case 'START_BOOKING': {
        // [FIX] Same dedup guard as START_ORDER above.
        const existingSession = await getSession(from, tenantId);
        if (existingSession?.currentFlow === 'BOOKING') {
          responseUI = await handleFlow(existingSession, messageText, tenantDoc, isInteractive);
        } else {
          responseUI = await startBookingFlow(session, business);
        }
        break;
      }

      case 'GREET': {
        await clearSession(from, tenantId);
        await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
        let greetMsg = null;
        try { greetMsg = await generateGreeting(business, session); } catch { /* use static */ }
        const welcomeBase = buildWelcomeUI(business);
        // [v11] Personalise greeting if customer name is known
        const knownName = session?.customerName;
        if (knownName && !greetMsg) {
          const { getLabel } = await import('../config/modes.js');
          const personalMsg = getLabel(business, 'welcomePersonalised', knownName);
          if (personalMsg) greetMsg = personalMsg;
        }
        responseUI = greetMsg ? { ...welcomeBase, body: greetMsg } : welcomeBase;
        break;
      }

      // [v11] Track order status — bot informs customer and provides admin contact
      case 'TRACK_ORDER': {
        const { getLabel: getLbl } = await import('../config/modes.js');
        const adminContact = business?.adminPhone || tenantDoc?.adminPhone || null;
        const trackMsg = getLbl(business, 'trackOrderMsg', adminContact)
          || `To track your order, please contact us directly.${adminContact ? `\n\n📞 *${adminContact}*` : ''}`;
        responseUI = { type: 'text', body: trackMsg };
        break;
      }

      // [v11] Repeat order — show last ordered item if known, guide to order flow
      case 'REPEAT_ORDER': {
        const { getLabel: getLbl2 } = await import('../config/modes.js');
        // session.data is cleared after every order — read persistent UserProfile instead
        let lastItem = null;
        try {
          const profile = await UserProfile.findOne({ phone: from }, 'preferences.favoriteItems').lean();
          const sorted = (profile?.preferences?.favoriteItems || []).slice().sort((a, b) => b.count - a.count);
          lastItem = sorted[0]?.name || null;
        } catch { /* non-fatal */ }
        const repeatMsg = getLbl2(business, 'repeatOrderMsg', lastItem)
          || (lastItem
            ? `Last time you ordered *${lastItem}* — would you like the same? 😊`
            : `Tap *Order* to place a new order!`);
        responseUI = {
          type: 'buttons',
          body: repeatMsg,
          buttons: [
            { id: 'ORDER',    title: '🍔 Order Now' },
            { id: 'QUESTION', title: '❓ Question' },
          ],
        };
        break;
      }

      case 'SHOW_MENU': {
        await clearSession(from, tenantId);
        await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
        responseUI = buildWelcomeUI(business);
        break;
      }

      case 'ABOUT': {
        let aboutReply = null;
        try { aboutReply = await answerAboutQuestion(messageText, business, null); } catch { /* swallow */ }
        responseUI = aboutReply
          ? { type: 'text', body: aboutReply }
          : buildWelcomeUI(business);
        break;
      }

      // Explicit enquiry / help signal with no active flow
      case 'ENQUIRY': {
        responseUI = await handleEnquiry(session, messageText, business, tenantDoc);
        break;
      }

      // Payment question with no active flow — explain payment + guide to order
      case 'AI_PAYMENT_HELP': {
        let paymentReply = null;
        try {
          paymentReply = await getAIReply(messageText, business, session, 'PAYMENT');
        } catch { /* swallow */ }
        if (!paymentReply) {
          const wavePhone = business?.payment?.wavePhone?.trim() || business?.wavePhone?.trim();
          paymentReply = wavePhone
            ? `We accept payment via *Wave* to *${wavePhone}* 💳\n\nType *Order* to place your order first, then we'll share payment details.`
            : `We accept Wave mobile money payments.\n\nType *Order* to start your order!`;
        }
        responseUI = { type: 'text', body: paymentReply };
        break;
      }

      // AI_FALLBACK with no active flow — Groq handles it
      case 'AI_FALLBACK': {
        let aiReply = null;
        try {
          aiReply = await getAIReply(messageText, business, null, intent || 'FALLBACK');
        } catch { /* swallow */ }
        responseUI = aiReply
          ? { type: 'text', body: aiReply }
          : buildSmartFallbackUI(business);
        break;
      }

      case 'RESTRICT_ORDER':
      case 'RESTRICT_BOOKING': {
        responseUI = { type: 'text', body: brainReply || 'Sorry, this option is not available.' };
        break;
      }

      // Orphaned CONFIRM / CANCEL / CONTINUE_FLOW with no active flow
      // → clear stale state and show welcome
      case 'CONFIRM':
      case 'CANCEL':
      case 'CONTINUE_FLOW': {
        await clearSession(from, tenantId);
        await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
        responseUI = buildWelcomeUI(business);
        break;
      }

      // Unknown intent → show welcome UI so user sees their options clearly.
      // CLARIFY — show interactive buttons, never "type X" plain text.
      // brainUI is the buildOptionsUI() result (buttons object) from brainService.
      // Fall back to buildWelcomeUI which also returns buttons.
      case 'CLARIFY': {
        responseUI = brainUI || buildWelcomeUI(business);
        break;
      }

      // Similarity suggestion — "Did you mean X?" — NEVER triggers a flow.
      // brainSuggestion = { intent, phrase } from brainService.
      // User must tap YES to confirm — only then does the flow start.
      case 'SUGGEST': {
        const suggestBody = brainReply || 'Did I understand you correctly?';
        const yesId = brainSuggestion?.intent === 'ORDER'   ? 'ORDER' :
                      brainSuggestion?.intent === 'BOOKING' ? 'BOOK'  : 'QUESTION';
        responseUI = {
          type:    'buttons',
          body:    suggestBody,
          buttons: [
            { id: yesId,    title: '✅ Yes, that one' },
            { id: 'CANCEL', title: '❌ No, show options' },
          ],
        };
        break;
      }

      case 'FALLBACK':
      default: {
        trackFailedInteraction(from, messageText, 'FALLBACK', phoneNumberId).catch(() => {});
        let aiReply = null;
        try { aiReply = await getAIReply(messageText, business, null, 'FALLBACK'); } catch { /* swallow */ }
        // Show AI reply if available, otherwise use brainUI buttons (never plain text options)
        responseUI = aiReply
          ? { type: 'text', body: aiReply }
          : (brainUI || buildSmartFallbackUI(business));
        break;
      }
    }

    // ── STEP 14: dispatch response ONCE ───────────────────────────────────
    if (responseUI) {
      await dispatch(from, responseUI, tenantDoc);
      // Track last bot reply for dedup guard
      const respBody = typeof responseUI === 'string' ? responseUI : responseUI?.body;
      if (respBody) updateSession(from, tenantId, { lastBotMessage: respBody }).catch(() => {});
    }

      } catch (err) {
        logger.error('[Webhook] Unhandled error', { err: err.message, stack: err.stack });
      }
        } // end for msgObj (messages)
      } // end for change
    } // end for entry
  } catch (err) {
    logger.error('[Webhook] Fatal handler error', { err: err.message, stack: err.stack });
  }
};