/**
 * models/Session.js
 *
 * Per-customer conversation state, scoped by composite key "${customerPhone}_${tenantId}".
 * Includes flow tracking, loop prevention (DB-persisted), step history, and upsell state.
 * Sessions auto-expire via TTL index on expiresAt (default: 30 minutes).
 */

import mongoose from 'mongoose';

const SESSION_TTL_MS = 30 * 60 * 1000;

const sessionSchema = new mongoose.Schema({
  // Composite lookup key: "${customerPhone}_${tenantId}"
  phone:         { type: String, required: true, index: true },
  customerPhone: { type: String, default: null },
  phoneNumberId: { type: String, default: null },

  currentFlow: {
    type: String,
    enum: ['ORDER', 'BOOKING', null], // 'WELCOME' removed — never set by any service
    default: null,
  },

  step:          { type: String, default: null },
  data:          { type: Object, default: {} },
  suggestion:    { type: String, default: null },

  pendingIntent: { type: String, default: null },
  previousStep:  { type: String, default: null },
  previousFlow:  { type: String, default: null }, // for mid-flow switches

  lastMessage:   { type: String, default: null },
  lastWamid:     { type: String, default: null },
  // Last message the BOT sent — used by dedup guard in brainService
  lastBotMessage: { type: String, default: null },
  // Last detected intent — used by groqService for AI memory context
  lastIntent:    { type: String, default: null },

  tenantId:      { type: String, default: null, index: true },

  isCompleted:   { type: Boolean, default: false },
  humanMode:     { type: Boolean, default: false },

  // ── Loop prevention (DB-persisted, safe across restarts) ─────────────────
  loopCount:        { type: Number, default: 0 },
  lastLoopMessage:  { type: String, default: null },
  lastLoopStep:     { type: String, default: null },

  // ── Step history (last 5, for debugging) ─────────────────────────────────
  stepHistory: { type: [String], default: [] },

  // ── Upsell state (v3.1) — ensures add-on is suggested at most ONCE ───────
  upsellSent:   { type: Boolean, default: false },
  pendingAddOn: { type: Object,  default: null  },

  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + SESSION_TTL_MS),
  },

}, { timestamps: true });

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('Session', sessionSchema);
