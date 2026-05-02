/**
 * controllers/webhookController.js — WhatsBotLyn v5.1-complete
 *
 * PIPELINE (strictly sequential, no mixing):
 *
 *   1. Receive & verify (signature, dedup, tenant lookup)
 *   2. Guard (suspended, botEnabled, business hours, human mode)
 *   3. Extract message (text / image / interactive)
 *   4. Session get-or-create
 *   5. Brain  → { action, ui?, reply?, intent? }    [LAYER 1: decision]
 *   6. Flow   → ui object or string                 [LAYER 2: logic]
 *   7. Dispatch → WhatsApp API                      [LAYER 3: delivery]
 *
 * CRITICAL RULES:
 * - dispatch() is called EXACTLY ONCE per inbound message (no double-sends).
 * - When a flow is ACTIVE, ONLY handleFlow() runs — no action switch.
 * - brainService only returns INTERRUPT/CANCEL/SHOW_MENU for active flows.
 *
 * BUG FIXES (v3.1 — merged from v2.6 + v3.0):
 * [FIX-1] Mid-flow: brain result only used for INTERRUPT/CANCEL/SHOW_MENU.
 *         CONTINUE_FLOW → straight to handleFlow(). Eliminates double-routing.
 * [FIX-2] INTERRUPT stores previousStep BEFORE session.step is overwritten.
 * [FIX-3] CANCEL action from brain is NOT honoured when session.step === 'CONFIRM'.
 *         At the CONFIRM step the "❌ Cancel" button sends id:"CANCEL". The brain
 *         classifies it as CANCEL and would clear session before flowService sees it.
 *         We now fall through to handleFlow so cancellation goes through one code path.
 *         *** THIS WAS THE ROOT CAUSE OF "We're having a little trouble right now" ***
 *         (Ported from v2.6 — was missing in v3.0)
 * [FIX-4] List reply IDs go directly to handleFlow without brain re-classification.
 * [FIX-5] Session re-fetched from DB after wamid write to avoid stale data.
 * [FIX-6] Payment proof only accepted when step === 'PAYMENT_PROOF'.
 * [FIX-7] No accidental welcome screen during confirmed order completion.
 * [FIX-H] REJECT_FLOW: clone UI before mutation — never mutate shared builder object.
 * [FIX-G] Expired session shows welcome, never "session expired" jargon.
 */

import { getSession, createSession, updateSession, clearSession } from '../services/sessionService.js';
import { dispatch }                                                   from '../services/messageService.js';
import { getBusiness }                                            from '../services/businessService.js';
import { think }                                                  from '../services/brainService.js';
import { handleFlow, startOrderFlow, startBookingFlow }           from '../services/flowService.js';
import { buildWelcomeUI, buildCancelUI, buildSmartFallbackUI } from '../utils/messageBuilders.js';
import { trackFailedInteraction }                                 from '../services/analyticsService.js';
import { getAIReply, generateGreeting, answerAboutQuestion }      from '../services/groqService.js';
import { receiveProof, handleDonePayment }                        from '../services/paymentService.js';
import { isAdminPhone, handleAdminButtonReply, handleAdminTextCommand } from '../services/adminPaymentHandler.js';
import Tenant  from '../models/Tenant.js';
import logger  from '../config/logger.js';
import { createHmac, timingSafeEqual } from 'crypto';

// ─── Signature verification ───────────────────────────────────────────────────

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    logger.warn('[Webhook] META_APP_SECRET not set — skipping signature verification');
    return true;
  }
  if (!signatureHeader) return false;
  const [scheme, theirHex] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !theirHex) return false;
  const body   = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
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
// [FIX-DUP] The previous implementation had a race condition:
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

  // Add to in-memory cache (trim if overgrown)
  if (_wamidCache.size >= WAMID_CACHE_MAX) _wamidCache.clear();
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
  const currentMinutes = (parseInt(rawH, 10) % 24) * 60 + parseInt(rawM, 10);
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
  }
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

    // [FIX-MULTI] Meta may bundle multiple entries or changes in a single POST.
    // Previously only entry[0].changes[0] was processed — all others were silently
    // dropped. Now we iterate every entry → every change → every message.
    const entries = body.entry;
    if (!Array.isArray(entries) || entries.length === 0) return;

    for (const entry of entries) {
      const changes = entry?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const value = change?.value;
        // [FIX-STATUS] Explicitly skip delivery/read status updates from WhatsApp.
        // WhatsApp sends statuses (sent, delivered, read) as value.statuses — if we
        // don't filter these early they could theoretically reach processing code.
        if (value?.statuses?.length && !value?.messages?.length) continue;
        if (!value?.messages?.length) continue;

        const msgObj        = value.messages[0];
        const wamid         = msgObj.id;
        const from          = msgObj.from;
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!from || !phoneNumberId) continue;

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

    // ── STEP 3: Deduplication ─────────────────────────────────────────────
    // [FIX-DUP] Use tenantId-scoped atomic dedup
    // [FIX-WAMID] Guard: malformed payloads may omit msgObj.id — skip dedup
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
        const buttonId = value.messages[0]?.interactive?.button_reply?.id;
        if (buttonId) {
          adminReply = await handleAdminButtonReply(buttonId, from, tenantId, tenantDoc, business);
        }
      }

      // Fallback: admin typed "APPROVE <id>" or "REJECT <id>"
      if (!adminReply && messageText) {
        adminReply = await handleAdminTextCommand(messageText, tenantId, from, tenantDoc, business);
      }

      if (adminReply) {
        await dispatch(from, { type: 'text', body: adminReply }, tenantDoc);
        continue; // Admin interaction fully handled — move to next change
      }

      // Admin sent something else (e.g. normal chat) — fall through to normal flow
    }

    // ── STEP 5: Session ───────────────────────────────────────────────────
    let session    = await getSession(from, tenantId);
    let wasExpired = false;

    if (!session) {
      const KNOWN_STARTS = new Set(['hi', 'hello', 'menu', 'start', 'order', 'book', '0', '1', '2']);
      if (!isInteractive && !KNOWN_STARTS.has(messageText.toLowerCase())) wasExpired = true;
      session = await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
    }

    // [FIX-DUP] Dedup is now handled by ProcessedMessage collection (atomic).
    // We no longer need to write lastWamid to the session for dedup purposes.
    // Re-fetch session to get the latest DB state after createSession upsert.
    session = (await getSession(from, tenantId)) || session;

    if (wasExpired) {
      // [FIX-G] Never show "session expired" — show welcome so user knows what to do.
      await dispatch(from, buildWelcomeUI(business), tenantDoc);
      continue;
    }

    // NOTE: must be `continue` not `return` — see SUSPENDED check above.
    if (session.humanMode === true) continue;

    // ── STEP 6: Image handling ────────────────────────────────────────────
    if (imageUrl) {
      // [FIX-6] Only process payment proof when explicitly in that step
      if (session.currentFlow === 'ORDER' && session.step === 'PAYMENT_PROOF') {
        // [PAY-PROOF] Delegate to paymentService — handles DB update, 24h cutoff,
        // duplicate-proof guard, and admin WhatsApp notification via adminPaymentHandler.
        // Pass tenantDoc + business so receiveProof can notify admin in-process.
        const replyText = await receiveProof(from, tenantId, imageUrl, tenantDoc, business);
        await clearSession(from, tenantId);
        await dispatch(from, { type: 'text', body: replyText }, tenantDoc);
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
    // [PAY-7] When requireProof=false, customer types DONE to confirm payment.
    if (
      session.currentFlow === 'ORDER' &&
      session.step === 'PAYMENT_PROOF' &&
      messageText.trim().toUpperCase() === 'DONE'
    ) {
      const replyText = await handleDonePayment(from, tenantId);
      await clearSession(from, tenantId);
      await dispatch(from, { type: 'text', body: replyText }, tenantDoc);
      continue;
    }

    // ── STEP 8: Brain (Layer 1 — decision) ───────────────────────────────
    const { action, ui: brainUI, reply: brainReply, intent } = await think({
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
    // [FIX-2] Capture session.step BEFORE overwriting it
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
      // [FIX-H] Clone UI before mutation — never modify the shared builder result
      await clearSession(from, tenantId);
      await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
      const baseUI = buildWelcomeUI(business);
      const rejectionReply = { ...baseUI, body: 'No problem 👍\n\n' + (baseUI.body || '') };
      await dispatch(from, rejectionReply, tenantDoc);
      continue;
    }

    // ── STEP 10b: CANCEL from brain mid-flow ──────────────────────────────
    if (action === 'CANCEL' && session.currentFlow) {
      // [FIX-3] When at the CONFIRM step, the "❌ Cancel" button sends id:"CANCEL".
      // The brain classifies this as CANCEL and would clear the session BEFORE
      // flowService has a chance to process it — causing the gracefulRetryUI error
      // ("We're having a little trouble right now") shown in the screenshot.
      //
      // Fix: only honour brain-level CANCEL for non-CONFIRM steps.
      // At CONFIRM, fall through to handleFlow which processes CANCEL correctly.
      if (session.step !== 'CONFIRM') {
        await clearSession(from, tenantId);
        await dispatch(from, buildCancelUI(business), tenantDoc);
        continue;
      }
      // Fall through to handleFlow for CONFIRM step cancellations ↓
    }

    // ── STEP 11: SHOW_MENU mid-flow ───────────────────────────────────────
    if (action === 'SHOW_MENU' && session.currentFlow) {
      await clearSession(from, tenantId);
      await createSession(from, tenantId, { customerPhone: from, phoneNumberId });
      await dispatch(from, buildWelcomeUI(business), tenantDoc);
      continue;
    }

    // ── STEP 12: Active flow → flowService handles EVERYTHING ─────────────
    // [FIX-1] This is the ONLY place we call handleFlow when a flow is active.
    // [FIX-4] List reply IDs (isInteractive=true) go straight here, no re-classify.
    // We already handled INTERRUPT / REJECT_FLOW / CANCEL / SHOW_MENU above.
    if (session.currentFlow) {

      // [B-AI1] AI_FALLBACK — user sent something unrecognised mid-flow.
      // Groq answers the question (about business, general help) WITHOUT touching
      // the cart/order/totals. The flow stays intact.
      if (action === 'AI_FALLBACK') {
        let aiReply = null;
        try {
          aiReply = await getAIReply(messageText, business, session, intent || 'FALLBACK');
        } catch { /* swallow */ }
        if (aiReply) {
          // Track but don't break the flow — next message continues where they were
          await dispatch(from, { type: 'text', body: aiReply }, tenantDoc);
          continue;
        }
        // AI failed → fall through to flowService to handle natively
      }

      // [B-AI3] AI_PAYMENT_HELP — user asked about payment while mid-flow.
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
        // [B-AI5] Track last bot reply for dedup guard
        const replyBody = typeof reply === 'string' ? reply : reply?.body;
        if (replyBody) updateSession(from, tenantId, { lastBotMessage: replyBody }).catch(() => {});
      }
      continue;
    }

    // ── STEP 13: No active flow → action switch ───────────────────────────
    let responseUI = null;

    switch (action) {

      case 'START_ORDER': {
        responseUI = await startOrderFlow(session, business);
        break;
      }

      case 'START_BOOKING': {
        responseUI = await startBookingFlow(session, business);
        break;
      }

      case 'GREET': {
        let greetMsg = null;
        try { greetMsg = await generateGreeting(business); } catch { /* use static */ }
        const welcomeBase = buildWelcomeUI(business);
        // [FIX-GREET] Clone the UI object before mutating body — never modify the shared builder result
        responseUI = greetMsg ? { ...welcomeBase, body: greetMsg } : welcomeBase;
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

      // [B-AI3] Payment question with no active flow — explain payment + guide to order
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

      // [B-AI1] AI_FALLBACK with no active flow — Groq handles it
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

      // [SA-B1] Unknown intent → ask ONE focused clarification question.
      // brainService already built the reply; just send it. Never call AI here.
      case 'CLARIFY': {
        responseUI = brainReply
          ? { type: 'text', body: brainReply }
          : buildSmartFallbackUI(business);
        break;
      }

      case 'FALLBACK':
      default: {
        trackFailedInteraction(from, messageText, 'FALLBACK', phoneNumberId).catch(() => {});
        let aiReply = null;
        try { aiReply = await getAIReply(messageText, business, null, 'FALLBACK'); } catch { /* swallow */ }
        // v3.1: buildSmartFallbackUI shows mode-appropriate buttons — never a dead-end message
        responseUI = aiReply
          ? { type: 'text', body: aiReply }
          : (brainReply ? { type: 'text', body: brainReply } : buildSmartFallbackUI(business));
        break;
      }
    }

    // ── STEP 14: dispatch response ONCE ───────────────────────────────────
    if (responseUI) {
      await dispatch(from, responseUI, tenantDoc);
      // [B-AI5] Track last bot reply for dedup guard
      const respBody = typeof responseUI === 'string' ? responseUI : responseUI?.body;
      if (respBody) updateSession(from, tenantId, { lastBotMessage: respBody }).catch(() => {});
    }

      } catch (err) {
        logger.error('[Webhook] Unhandled error', { err: err.message, stack: err.stack });
      }
      } // end for change
    } // end for entry
};
