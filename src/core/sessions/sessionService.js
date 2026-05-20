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
 * [SES-3] createSession() preserves customerName across session resets when
 *         the name is passed explicitly. Prevents the bot from forgetting the
 *         customer's name after a GREET reset.
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

/** Build the composite lookup key stored in Session.phone */
function sessionKey(customerPhone, tenantId) {
  return `${customerPhone}_${tenantId}`;
}

/**
 * Determine the correct TTL for a given step transition.
 * Returns the TTL in milliseconds.
 */
function resolveTTL(step) {
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
  const ttl = resolveTTL(data.step);

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
        humanMode:     false,
        expiresAt:     new Date(Date.now() + ttl),
        mode:          null,
        loopCount:       0,
        lastLoopMessage: null,
        lastLoopStep:    null,
        stepHistory:     [],
        upsellSent:      false,
        pendingAddOn:    null,
        // [SES-3] Preserve name if provided; don't wipe on re-create
        ...(data.customerName ? { customerName: data.customerName } : {}),
      },
    },
    { upsert: true, new: true }
  );
};

// ─── GET ──────────────────────────────────────────────────────────────────────
export const getSession = async (customerPhone, tenantId) => {
  const key = sessionKey(customerPhone, tenantId);
  return await Session.findOne({ phone: key, expiresAt: { $gt: new Date() } });
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
 */
export const updateSession = async (customerPhone, tenantId, updates = {}) => {
  const key   = sessionKey(customerPhone, tenantId);
  const patch = { ...updates };

  // Remove internal hint before writing to DB
  const stepHint = patch._stepHint;
  delete patch._stepHint;

  // Extend TTL on any step or flow change
  if (updates.step !== undefined || updates.currentFlow !== undefined || stepHint) {
    const effectiveStep = updates.step || stepHint;
    patch.expiresAt = new Date(Date.now() + resolveTTL(effectiveStep));
  }

  return await Session.findOneAndUpdate(
    { phone: key, tenantId: String(tenantId) },
    { $set: patch },
    { new: true }
  );
};

// ─── CLEAR ────────────────────────────────────────────────────────────────────
export const clearSession = async (customerPhone, tenantId) => {
  const key = sessionKey(customerPhone, tenantId);
  return await Session.deleteOne({ phone: key });
};
