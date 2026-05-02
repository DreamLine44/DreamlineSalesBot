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
  return await Session.findOneAndUpdate(
    { phone: key },
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
      },
    },
    { upsert: true, new: true }
  );
};

// ─── GET ──────────────────────────────────────────────────────────────────────
export const getSession = async (customerPhone, tenantId) => {
  const key = sessionKey(customerPhone, tenantId);
  return await Session.findOne({ phone: key });
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

  return await Session.findOneAndUpdate(
    { phone: key },
    { $set: patch },
    { new: true }
  );
};

// ─── CLEAR ────────────────────────────────────────────────────────────────────
export const clearSession = async (customerPhone, tenantId) => {
  const key = sessionKey(customerPhone, tenantId);
  return await Session.deleteOne({ phone: key });
};
