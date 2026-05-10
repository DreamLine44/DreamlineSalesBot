/**
 * services/sessionService.js
 *
 * Session store backed by MongoDB with a 30-minute TTL.
 *
 * KEY FORMAT: "${customerPhone}_${tenantId}"
 * This composite key scopes sessions per-tenant so two different businesses
 * receiving a message from the same customer number never share a session.
 *
 * All exported functions accept (customerPhone, tenantId) and build the
 * composite key internally — callers never construct it themselves.
 */

import Session from '../models/Session.js';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Build the composite lookup key stored in Session.phone */
function sessionKey(customerPhone, tenantId) {
  return `${customerPhone}_${tenantId}`;
}

// ─── CREATE / RESET ───────────────────────────────────────────────────────────
/**
 * Create or fully reset a session for (customerPhone, tenantId).
 * data may include: { currentFlow, step, data, phoneNumberId }
 */
export const createSession = async (customerPhone, tenantId, data = {}) => {
  const key = sessionKey(customerPhone, tenantId);
  // [FIX] Include tenantId in the filter so the upsert never matches a stale
  // document where tenantId is null (left over from old sessions before the
  // composite key format was introduced). Without this, two different tenants
  // receiving a message from the same phone number could share a session document,
  // and the E11000 duplicate key error on key_1 (null) would crash the handler.
  return await Session.findOneAndUpdate(
    { phone: key, tenantId: String(tenantId) },
    {
      $set: {
        phone:         key,
        customerPhone,
        tenantId:      String(tenantId),
        phoneNumberId: data.phoneNumberId  || null,  // needed by flowService to look up BusinessConfig
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
        expiresAt:     new Date(Date.now() + SESSION_TTL_MS),
        mode:          null,  // clear any awaiting_question / awaiting_rejection_action state
        // ── Loop-prevention & upsell state ──────────────────────────────
        // These must be explicitly reset so returning customers start clean.
        // Without this reset:
        //   - loopCount/lastLoopMessage/lastLoopStep persist from old sessions,
        //     causing false loop-threshold hits for returning users.
        //   - upsellSent=true persists forever, permanently disabling upsells
        //     after the first order even across entirely new sessions.
        //   - stepHistory is polluted with steps from prior flows.
        loopCount:       0,
        lastLoopMessage: null,
        lastLoopStep:    null,
        stepHistory:     [],
        upsellSent:      false,
        pendingAddOn:    null,
      },
    },
    { upsert: true, new: true }
  );
};

// ─── GET ──────────────────────────────────────────────────────────────────────
export const getSession = async (customerPhone, tenantId) => {
  const key = sessionKey(customerPhone, tenantId);
  // Guard against MongoDB TTL lag — expired sessions stay in collection
  // for up to 60s after expiry. Filter them out explicitly.
  return await Session.findOne({ phone: key, expiresAt: { $gt: new Date() } });
};

// ─── UPDATE ───────────────────────────────────────────────────────────────────
/** Uses $set so only the supplied fields are changed — never wipes the document. */
export const updateSession = async (customerPhone, tenantId, updates = {}) => {
  const key   = sessionKey(customerPhone, tenantId);
  const patch = { ...updates };

  // Extend TTL whenever the flow progresses
  if (updates.step !== undefined || updates.currentFlow !== undefined) {
    patch.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  }

  // [FIX] Include tenantId in filter to prevent null-key collisions (E11000)
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
