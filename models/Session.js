/**
 * models/Session.js — v11.0
 *
 * Upgrades:
 * - TTL index via expiresAt (already present) + configurable SESSION_TTL_MS
 * - customerName capture for personalised replies
 * - retryCount for payment proof reminders (max 2)
 * - lastSeen timestamp for analytics
 * - abandonedAt for abandoned-cart detection
 * - messageCount for per-session usage tracking
 */

import mongoose from 'mongoose';

// TTL controlled by env var — default 30 min, configurable per deployment
const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_MINUTES, 10) || 30) * 60 * 1000;

const sessionSchema = new mongoose.Schema({
  phone:         { type: String, required: true, index: true },
  customerPhone: { type: String, default: null },
  customerName:  { type: String, default: null },   // [v11] captured during flow
  phoneNumberId: { type: String, default: null },

  currentFlow: {
    type: String,
    enum: ['ORDER', 'BOOKING', null],
    default: null,
  },

  step:          { type: String, default: null },
  data:          { type: Object, default: {} },
  suggestion:    { type: String, default: null },

  // [SPEC] Explicit input type expected at the current step.
  // flowService sets this on every step transition so external systems
  // (analytics, admin dashboards) always know what the bot is waiting for.
  // Values: 'quantity' | 'date' | 'time' | 'address' | 'image' | 'confirmation' | 'text' | null
  expectedInputType: { type: String, default: null },

  pendingIntent: { type: String, default: null },
  previousStep:  { type: String, default: null },
  previousFlow:  { type: String, default: null },

  lastMessage:    { type: String, default: null },
  lastWamid:      { type: String, default: null },
  lastBotMessage: { type: String, default: null },
  lastIntent:     { type: String, default: null },
  lastSeen:       { type: Date,   default: null },   // [v11] updated on every message

  tenantId:      { type: String, default: null, index: true },

  isCompleted:          { type: Boolean, default: false },
  humanMode:            { type: Boolean, default: false },
  humanModeNotified:    { type: Boolean, default: false },

  // Loop prevention
  loopCount:        { type: Number, default: 0 },
  lastLoopMessage:  { type: String, default: null },
  lastLoopStep:     { type: String, default: null },

  // Conversation mode
  mode: { type: String, default: null },

  // Step history
  stepHistory: { type: [String], default: [] },

  // Upsell state
  upsellSent:   { type: Boolean, default: false },
  pendingAddOn: { type: Object,  default: null  },

  // [v11] Payment retry tracking — max 2 proof reminders before suggesting human support
  paymentRetryCount: { type: Number, default: 0 },

  // [v11] Message count for session-level usage analytics
  messageCount: { type: Number, default: 0 },

  // [v11] Abandoned cart — set when session expires mid-flow; used for follow-up campaigns
  abandonedAt:  { type: Date, default: null },
  abandonedFlow: { type: String, default: null },
  abandonedItem: { type: String, default: null },

  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + SESSION_TTL_MS),
  },

}, { timestamps: true });

// TTL index — MongoDB auto-expires documents after expiresAt
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound unique index — sparse so null-tenantId docs never collide
sessionSchema.index({ phone: 1, tenantId: 1 }, { unique: true, sparse: true });

// [v11] Partial index for abandoned flow queries (analytics / re-engagement)
sessionSchema.index({ abandonedAt: 1, tenantId: 1 }, { sparse: true });

export default mongoose.model('Session', sessionSchema);
