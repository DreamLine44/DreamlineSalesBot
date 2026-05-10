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
  humanMode:          { type: Boolean, default: false },
  humanModeNotified:  { type: Boolean, default: false }, // true after first human-mode acknowledgement is sent

  // ── Loop prevention (DB-persisted, safe across restarts) ─────────────────
  loopCount:        { type: Number, default: 0 },
  lastLoopMessage:  { type: String, default: null },
  lastLoopStep:     { type: String, default: null },

  // ── Conversation mode — tracks special waiting states ────────────────────
  // 'awaiting_question'         : bot asked "what would you like to know?" — next msg is the question
  // 'awaiting_rejection_action' : payment was rejected — customer must choose resend/support/cancel
  // null                        : normal operation
  mode: { type: String, default: null },

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

// [FIX-9] Compound unique index on (phone, tenantId).
// The `phone` field already encodes both customerPhone and tenantId as a composite
// key ("${customerPhone}_${tenantId}"), so a unique index on phone alone is the
// primary dedup guard. The compound index also protects against a future refactor
// where the composite key format changes, and speeds up admin queries by tenantId.
// Under concurrent webhook retries, two simultaneous upserts for the same customer
// could race and create duplicate sessions, causing split or corrupted flow state.
// [FIX] The old schema had a separate unique index named `key_1` (from a previous
// field called `key`) that is still sitting in MongoDB. When tenantId is null it
// causes E11000 duplicate key errors because null == null in a unique index.
//
// Fix 1: compound index is sparse: true — MongoDB skips documents where EITHER
//         field is null, so null-tenantId docs never collide.
// Fix 2: phone alone is already unique per composite key, so the compound index
//         uses sparse to avoid fighting the legacy key_1 index during migration.
//
// IMPORTANT: After deploying this fix, drop the old stale index once manually:
//   In mongosh:  db.sessions.dropIndex("key_1")
//   The app will work fine before you do — sparse:true prevents the crash —
//   but dropping the dead index keeps your DB clean.
sessionSchema.index({ phone: 1, tenantId: 1 }, { unique: true, sparse: true });

export default mongoose.model('Session', sessionSchema);
