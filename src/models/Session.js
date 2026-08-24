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
    // ⚠️  MAINTENANCE RULE: Every string passed to startFlow({ flowName }) or written
    // directly to session.currentFlow MUST appear in this enum. Mongoose silently
    // discards values outside the enum and stores null instead — the flow never starts
    // and no error is thrown. When you add a new flow in moduleRegistry.js or any
    // module handler, add its name here at the same time.
    //
    // Current flow → source mapping:
    enum: [
      'ORDER',              // moduleRegistry ORDER action / adminCommandService
      'BOOKING',            // moduleRegistry BOOKING action / bookingFlow
      'LEAD_CAPTURE',       // leadCaptureService.startLeadCapture
      'ENQUIRY',            // webhookController ENQUIRY two-step
      'CAKE_CUSTOMIZATION', // bakery module — handleCakeCustomization
      'SKINCARE_ADVICE',    // cosmetics module — handleSkincareAdvice
      'SPEC_REQUEST',       // electronics module — handleSpecRequest
      'COMPARE',            // electronics module — handleCompare
      'WARRANTY',           // electronics module — handleWarranty
      'WALKIN',             // salon/barbershop module — handleWalkInFlow
      'PRODUCT_QUERY',      // retail module — handleProductQuery
      'QUOTE_FOLLOW',       // services module — handleQuoteFollowUp
      'ABOUT',              // general module — handleAbout (GENERAL mode only)
      'QUESTION',           // general/services module — handleGeneralQuestion / handleServicesQuestion
      // [FIX-7] Add new flow names here when registering in moduleRegistry.js.
      // Failure to do so = silent null write = broken flow, no error logged.
      null,
    ],
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

  // [FEAT-SPAM-1] Rapid identical-message suppression (spec: "Ignore repeated
  // identical messages ... respond once"). Distinct from loopCount above
  // (multi-turn stuck-loop detection over many exchanges) and from the wamid
  // dedup in webhookController.js (network-level duplicate delivery of the
  // SAME event) — this throttles the same customer re-sending the exact same
  // text within a few seconds.
  lastRapidMessage:   { type: String, default: null },
  lastRapidMessageAt: { type: Date,   default: null },

  // [FIX-ACK-THROTTLE] Tracks the last time we sent an order-status acknowledgement
  // reply so we don't repeat the same status text on every reaction emoji or filler word.
  lastOrderStatusAckAt: { type: Date, default: null },
  // [FIX-AOR-5] Throttle timestamp for activeOrderResolver intercepts.
  // Prevents the same preparing-card from being sent on every filler message.
  lastAorInterceptAt:   { type: Date, default: null },

  // Conversation mode
  mode: { type: String, default: null },

  // Step history
  stepHistory: { type: [String], default: [] },

  // Upsell state
  upsellSent:   { type: Boolean, default: false },
  pendingAddOn: { type: Object,  default: null  },

  // [FIX-C] Track whether the customer has opened the menu list during the
  // current ORDER session. A bare number typed BEFORE the menu is shown is
  // almost certainly a quantity or a random message — not an item selection.
  // The SELECT_ITEM step checks this flag before accepting numeric input.
  menuViewed:   { type: Boolean, default: false },

  // [ORDER-CHANNEL] Persists how the customer chose to shop: 'catalog' (WA Catalog)
  // vs 'menu' (text/list menu). Set when they tap Browse Catalog or Order Food,
  // survives flow completion so follow-up taps like "New Order" stay on-path.
  orderChannel: { type: String, default: null }, // 'catalog' | 'menu' | null

  // [ENHANCED-NLU] Recent conversation turns for Groq context (user + assistant).
  aiHistory: {
    type: [{
      role:    { type: String, enum: ['user', 'assistant'] },
      content: { type: String, maxlength: 500 },
      at:      { type: String, default: null },
    }],
    default: [],
  },

  // [FIX-A] Set to the completed flow name ('ORDER'|'BOOKING') when a flow
  // finishes successfully. Survives the session reset so the next message
  // ("Ok", "Thanks", etc.) can be intercepted for a warm acknowledgement
  // instead of immediately re-showing the full welcome menu.
  // Cleared by the webhook ack handler or after any non-ack message.
  postFlowAck:  { type: String, default: null },
  postFlowData: { type: Object, default: null }, // context stored after flow completion (item, shortId, etc.)

  // [v11] Payment retry tracking — max 2 proof reminders before suggesting human support
  paymentRetryCount: { type: Number, default: 0 },

  // [v11] Message count for session-level usage analytics
  messageCount: { type: Number, default: 0 },

  // [v11] Abandoned cart — set when session expires mid-flow; used for follow-up campaigns
  abandonedAt:  { type: Date, default: null },
  abandonedFlow: { type: String, default: null },
  abandonedItem: { type: String, default: null },

  // [FIX-BUG3] Tracks whether we have already sent closed-hours message
  closedMsgSent: { type: Boolean, default: false },

  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + SESSION_TTL_MS),
  },

}, { timestamps: true });

// TTL index — MongoDB auto-expires documents after expiresAt
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound unique index — sparse so null-tenantId docs never collide
sessionSchema.index({ phone: 1, tenantId: 1 }, { unique: true, sparse: true });

// [FIX-IDX-1] Partial index for humanMode queries (adminCommandService RESUME BOT,
// dashboard conversation list, webhookController TTL-restore check).
// These queries always filter { tenantId, humanMode: true } so a compound partial
// index covering both is faster than a full collection scan on large tenants.
sessionSchema.index({ tenantId: 1, humanMode: 1 }, { partialFilterExpression: { humanMode: true } });

// [v11] Partial index for abandoned flow queries (analytics / re-engagement)
sessionSchema.index({ abandonedAt: 1, tenantId: 1 }, { sparse: true });

export default mongoose.model('Session', sessionSchema);
