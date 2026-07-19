/**
 * services/sessionService.js — DreamLine SalesBot v13.0
 *
 * v13.0 changes over v11.0:
 *
 * [SES-1] PAYMENT_PROOF step extends session TTL to 4 hours (configurable via
 *         PAYMENT_SESSION_TTL_HOURS). Wave payments in West Africa often take
 *         30–90 minutes. The old 30-minute TTL was expiring sessions before
 *         the customer had a chance to send their screenshot, causing the
 *         webhookController to route the image as "unknown" and reply with
 *         "I can only understand text messages."
 *
 * [SES-2] updateSession() accepts a `stepHint` option. flowService passes
 *         the incoming step name when transitioning to PAYMENT_PROOF so the
 *         TTL extension triggers at the right moment without requiring the
 *         caller to know the TTL internals.
 *
 * [FIX-SES-7] updateSession() accepts an optional `inc` argument (plain object)
 *             whose keys are applied as MongoDB `$inc` operations rather than
 *             `$set`. This enables atomic counter increments (e.g. messageCount)
 *             that are safe under concurrent webhook delivery — two simultaneous
 *             webhooks for the same customer no longer both read the same snapshot
 *             count and both write `count + 1`, losing one increment.
 *
 * [SES-3] createSession() preserves customerName across session resets when
 *         the name is passed explicitly. Prevents the bot from forgetting the
 *         customer's name after a GREET reset.
 *
 * [FIX-SES-4] createSession() now passes humanMode to resolveTTL so sessions
 *             created directly in humanMode (TTL-restore path) correctly receive
 *             the 24-hour TTL instead of the default 30-minute one.
 *
 * [FIX-SES-5] createSession() accepts data.humanMode and writes it via $set so
 *             the webhookController can restore humanMode in a single atomic
 *             upsert, eliminating the previous two-step race window.
 *
 * [FIX-SES-5b] $setOnInsert.humanMode is now conditional: it is omitted when
 *             data.humanMode is explicitly supplied (which writes via $set). MongoDB
 *             throws "Mod on <field> not allowed due to conflicting mods" when the same
 *             path appears in both $set and $setOnInsert. The TTL-restore path in
 *             webhookController passes humanMode: true, so the old code always crashed.
 *
 * [FIX-SES-6] $setOnInsert for humanModeNotified is intentionally kept — it must
 *             NOT be reset on session re-creation so a TTL expiry can't trigger a
 *             duplicate admin escalation alert on the customer's next message.
 *
 * All other behaviour (composite key, upsert logic, expiresAt TTL index) is
 * unchanged from v11.0.
 */

import Session from '../../models/Session.js';

// Standard conversation TTL (30 min default, configurable)
const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_MINUTES, 10) || 30) * 60 * 1000;

// [SES-1] Extended TTL for payment-proof step (4 hours default, configurable)
const PAYMENT_TTL_MS = (parseInt(process.env.PAYMENT_SESSION_TTL_HOURS, 10) || 4) * 60 * 60 * 1000;

// Steps that warrant the extended payment TTL
const PAYMENT_STEPS = new Set(['PAYMENT_PROOF', 'PAYMENT_CONFIRM', 'AWAITING_PAYMENT']);

// [FIX-HM-2] Human-mode TTL — when an admin takes over, the session must survive
// long enough for the conversation to finish. 24 hours default so overnight chats
// don't auto-resume the bot without admin intent.
const HUMAN_MODE_TTL_MS = (parseInt(process.env.HUMAN_MODE_SESSION_TTL_HOURS, 10) || 24) * 60 * 60 * 1000;

/** Build the composite lookup key stored in Session.phone */
export function sessionKey(customerPhone, tenantId) {
  return `${customerPhone}_${tenantId}`;
}

/**
 * Determine the correct TTL for a given step transition or session state.
 * Returns the TTL in milliseconds.
 *
 * Priority (highest → lowest):
 *   1. humanMode=true  → 24h TTL so the session survives the full admin-handled
 *      conversation without expiring and silently re-enabling the bot.
 *   2. PAYMENT_STEPS   → 4h TTL so the customer has time to send their screenshot.
 *   3. Default         → 30-minute standard session TTL.
 *
 * humanMode=false is intentionally NOT given extended TTL — when the admin resumes
 * the bot the session should return to the normal 30-minute window.
 *
 * [FIX-HM-2] humanMode=true gets a 24h TTL so the session survives the full
 * admin-handled conversation without expiring and accidentally re-enabling the bot.
 */
function resolveTTL(step, humanMode) {
  if (humanMode) return HUMAN_MODE_TTL_MS;
  if (step && PAYMENT_STEPS.has(step)) return PAYMENT_TTL_MS;
  return SESSION_TTL_MS;
}

// ─── CREATE / RESET ───────────────────────────────────────────────────────────
/**
 * Create or fully reset a session for (customerPhone, tenantId).
 * data may include: { currentFlow, step, data, phoneNumberId, customerName }
 *
 * [SES-3] customerName is preserved if passed in data — allows the welcome
 *         flow to restore the name after a GREET reset without re-asking.
 */
export const createSession = async (customerPhone, tenantId, data = {}) => {
  const key = sessionKey(customerPhone, tenantId);
  // [FIX-SES-4] Pass both step AND humanMode to resolveTTL so that a session created
  // directly into humanMode (e.g. after TTL restore in webhookController) gets the 24h TTL
  // instead of the default 30-minute one. Previously humanMode was always undefined here.
  const ttl = resolveTTL(data.step, data.humanMode);

  // [FIX-HM-1] humanMode MUST NOT be reset to false by createSession.
  // Previously this $set humanMode: false unconditionally — meaning when a session
  // expired (30min TTL) while the customer was in humanMode, their next message
  // created a fresh session with humanMode=false and the bot started responding
  // again without the admin ever typing RESUME BOT.
  //
  // Fix: $setOnInsert for humanMode so it defaults to false ONLY for brand-new docs.
  // Existing docs (session re-created after TTL expiry in same DB slot) keep their
  // humanMode value. The flow/step fields are still fully reset on every call.
  return await Session.findOneAndUpdate(
    { phone: key, tenantId: String(tenantId) },
    {
      $set: {
        phone:         key,
        customerPhone,
        tenantId:      String(tenantId),
        phoneNumberId: data.phoneNumberId  || null,
        currentFlow:   data.currentFlow    || null,
        step:          data.step           || null,
        data:          data.data           || {},
        suggestion:    null,
        pendingIntent: null,
        previousStep:  null,
        lastMessage:   null,
        lastWamid:     null,
        lastBotMessage: null,
        lastIntent:    null,
        expiresAt:     new Date(Date.now() + ttl),
        mode:          null,
        loopCount:       0,
        lastLoopMessage: null,
        lastLoopStep:    null,
        stepHistory:     [],
        upsellSent:      false,
        pendingAddOn:    null,
        // [FIX-SES-9] createSession upserts onto the SAME document (matched by
        // the phone+tenantId composite key) when a session is re-created after
        // TTL expiry — it does not delete the old expired doc first. Mongo's
        // $set only touches the fields it lists, so any field omitted here
        // silently survives from the expired session into the "new" one.
        // postFlowAck/postFlowData were previously omitted: webhookController's
        // step-14 postFlowAck state machine reads session.postFlowAck directly
        // off the freshly (re)created session, so a customer starting a brand-
        // new conversation days later could have their first message misrouted
        // through handlePostFlowMessage using postFlowData referencing a
        // long-gone order/shortId. Must be reset unconditionally on every call
        // — including the humanMode-restore path, which is exactly the
        // real-world case where a stale postFlowAck from before the handoff
        // would otherwise leak through.
        postFlowAck:     null,
        postFlowData:    null,
        // [SES-3] Preserve name if provided; don't wipe on re-create
        ...(data.customerName ? { customerName: data.customerName } : {}),
        // [FIX-SES-5] When humanMode is explicitly passed (e.g. TTL-restore path in
        // webhookController), write it via $set so it wins regardless of whether this
        // is an insert or an update. $setOnInsert only fires on new documents.
        ...(data.humanMode !== undefined ? { humanMode: data.humanMode } : {}),
      },
      // humanMode defaults to false ONLY when inserting a brand-new session document.
      // On updates (session re-create after TTL) the existing humanMode is preserved.
      // [FIX-SES-6] humanModeNotified is also reset to false on $setOnInsert only —
      // do NOT reset it on session re-creation; if the admin was already notified for
      // this customer, a TTL expiry must not cause a second alert on their next message.
      //
      // [FIX-SES-5b] When data.humanMode is explicitly supplied it is already written
      // above via $set. Including humanMode in $setOnInsert as well causes MongoDB to
      // throw "Mod on humanMode not allowed due to conflicting mods" because the same
      // field cannot appear in both $set and $setOnInsert in a single findOneAndUpdate.
      // Guard: only add humanMode to $setOnInsert when it is NOT already in $set.
      $setOnInsert: {
        ...(data.humanMode === undefined ? { humanMode: false } : {}),
        humanModeNotified: false,
      },
    },
    { upsert: true, new: true }
  );
};

// ─── GET ──────────────────────────────────────────────────────────────────────
export const getSession = async (customerPhone, tenantId) => {
  const key = sessionKey(customerPhone, tenantId);
  // Include tenantId as an explicit filter guard in addition to the composite key.
  // The composite key already encodes tenantId, but an explicit filter prevents
  // cross-tenant matches if a phone number ever contains an underscore.
  return await Session.findOne({ phone: key, tenantId: String(tenantId), expiresAt: { $gt: new Date() } });
};

// ─── UPDATE ───────────────────────────────────────────────────────────────────
/**
 * Partial update — only the supplied fields are changed.
 *
 * [SES-1] When step transitions to a PAYMENT_STEPS value, TTL is extended
 *         automatically. This is the core of the payment-session-survival fix.
 *
 * [SES-2] Callers may pass `_stepHint` in updates to force a specific TTL
 *         without actually writing a step value. This is useful when the
 *         step field is set elsewhere but the TTL still needs extending.
 *
 * [FIX-SES-7] An optional `inc` argument (plain object, e.g. { messageCount: 1 })
 *         is applied as a MongoDB `$inc` operation alongside the `$set`. This makes
 *         counter fields safe under concurrent webhook delivery — both operations are
 *         issued in a single findOneAndUpdate so Mongo applies them atomically.
 *         Callers pass inc as a second argument: updateSession(phone, tid, set, inc).
 */
export const updateSession = async (customerPhone, tenantId, updates = {}, inc = {}) => {
  const key   = sessionKey(customerPhone, tenantId);
  const patch = { ...updates };

  // Remove internal hint before writing to DB
  const stepHint = patch._stepHint;
  delete patch._stepHint;

  // [FIX-HM-2] Extend TTL on step/flow change OR when humanMode is being toggled.
  // humanMode=true uses a 24h TTL so the session doesn't expire mid-conversation.
  // humanMode=false returns to the standard session TTL.
  const humanModeChanging = updates.humanMode !== undefined;
  const ttlNeedsRecompute = updates.step !== undefined || updates.currentFlow !== undefined || stepHint || humanModeChanging;

  if (ttlNeedsRecompute) {
    const effectiveStep = updates.step || stepHint;
    let effectiveHuman;
    if (humanModeChanging) {
      effectiveHuman = updates.humanMode;
    } else {
      // [FIX-SES-8] This update changes step/currentFlow but does NOT mention
      // humanMode — e.g. adminCommandService confirming/rejecting an order or
      // booking, which always sets `currentFlow: null, step: null` regardless
      // of the customer's current humanMode state. Previously this branch left
      // effectiveHuman as `undefined`, so resolveTTL() silently fell back to the
      // 30-minute default — even when the session's *existing* humanMode was
      // true. That meant any admin action touching step/currentFlow on a
      // customer the admin had manually taken over would quietly collapse the
      // 24h human-mode TTL back to 30 minutes, defeating [FIX-HM-2] (the bot
      // could "wake up" and respond again mid-conversation without the admin
      // ever typing RESUME BOT). Look up the session's current humanMode so
      // the TTL is computed against the real state, not just this patch.
      const existing = await Session.findOne(
        { phone: key, tenantId: String(tenantId) },
        { humanMode: 1 }
      ).lean().catch(() => null);
      effectiveHuman = existing?.humanMode === true;
    }
    patch.expiresAt = new Date(Date.now() + resolveTTL(effectiveStep, effectiveHuman));
  }

  return await Session.findOneAndUpdate(
    { phone: key, tenantId: String(tenantId) },
    {
      $set: patch,
      ...(inc && Object.keys(inc).length > 0 ? { $inc: inc } : {}),
    },
    { new: true }
  );
};

// ─── CLEAR ────────────────────────────────────────────────────────────────────
export const clearSession = async (customerPhone, tenantId) => {
  const key = sessionKey(customerPhone, tenantId);
  // [FIX-SES-3] Include tenantId as an explicit filter to match createSession /
  // updateSession / getSession. Without it, a composite-key collision (e.g. a phone
  // number containing an underscore) could delete a session for the wrong tenant.
  return await Session.deleteOne({ phone: key, tenantId: String(tenantId) });
};
