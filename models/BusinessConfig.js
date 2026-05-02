// /**
//  * models/BusinessConfig.js — WhatsBotLyn v3.1
//  *
//  * v3.0 changes:
//  * - loopFallback added to customMessages (loop recovery override)
//  * - All customMessages fields now have inline comments for non-technical owners
//  * - businessMode: replaces the old "mode" field (RESTAURANT | SALON | RETAIL)
//  *   Old "mode" kept as a computed virtual for backward-compat.
//  * - services[]: Salon-style bookable services with name/duration/price.
//  * - customMessages: expanded with welcomeMessage, paymentInstructions keys.
//  * - All flow labels overridable via customMessages (read by config/modes.js getLabel()).
//  * - NOTHING in flowService is hardcoded — everything flows through here.
//  */

// import mongoose from 'mongoose';

// const menuItemSchema = new mongoose.Schema({
//   name:        { type: String, required: true, trim: true },
//   price:       { type: Number, default: 0, min: 0 },
//   description: { type: String, default: '', trim: true },
//   keywords:    { type: [String], default: [] },
//   available:   { type: Boolean, default: true },
// }, { _id: true });

// const serviceSchema = new mongoose.Schema({
//   name:        { type: String, required: true, trim: true },
//   duration:    { type: Number, default: 30, min: 5 },
//   price:       { type: Number, default: 0, min: 0 },
//   description: { type: String, default: '', trim: true },
//   available:   { type: Boolean, default: true },
// }, { _id: true });

// const faqSchema = new mongoose.Schema({
//   trigger: { type: String, required: true, trim: true },
//   reply:   { type: String, required: true, trim: true },
// }, { _id: true });

// const businessConfigSchema = new mongoose.Schema({

//   tenantId: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'Tenant', index: true, sparse: true,
//   },

//   name:        { type: String, default: 'Our Business', trim: true },
//   description: { type: String, default: '', trim: true },

//   // phoneNumberId: {
//   //   // NOT required at model level: onboarding step 2 (POST /register/business)
//   //   // runs before WhatsApp is connected (step 3). The unique+sparse index still
//   //   // prevents two tenants sharing the same phoneNumberId once it is set.
//   //   type: String,
//   //    required: false,
//   //    unique: true,
//   //    sparse: true, 
//   //    index: true, 
//   //    trim: true,
//   // },

//   // AFTER (fixed)
// phoneNumberId: {
//   type: String,
//   required: false,  // ← allow null until WhatsApp step 3
//   unique: true,
//   sparse: true,     // ← allows multiple nulls in the unique index
//   index: true,
//   trim: true,
//   default: null,
// },

//   // v15 canonical mode field
//   businessMode: {
//     type: String,
//     enum: ['RESTAURANT', 'SALON', 'RETAIL'],
//     default: 'RESTAURANT',
//     index: true,
//   },

//   // Legacy field — kept for backward-compat; not used by v15 logic
//   mode: {
//     type: String,
//     enum: ['ORDER', 'BOOKING', 'BOTH'],
//     default: null,
//   },

//   botEnabled: { type: Boolean, default: true },
//   // Legacy top-level wavePhone (kept for backward-compat with flowService)
//   wavePhone:  { type: String, default: null, trim: true },
//   adminPhone: { type: String, default: null, trim: true },

//   // Nested payment config (used by paymentService)
//   payment: {
//     wavePhone:    { type: String, default: null, trim: true },
//     currency:     { type: String, default: 'GMD', trim: true },
//     requireProof: { type: Boolean, default: true },
//   },

//   hours: {
//     enabled:  { type: Boolean, default: false },
//     timezone: { type: String, default: 'UTC', trim: true },
//     open:     { type: Number, default: 8, min: 0, max: 23 },
//     close:    { type: Number, default: 22, min: 0, max: 23 },
//     days: {
//       type: Map,
//       of: {
//         open:   { type: Number, min: 0, max: 23 },
//         close:  { type: Number, min: 0, max: 23 },
//         closed: { type: Boolean, default: false },
//       },
//       default: {},
//     },
//   },

//   menu:     [menuItemSchema],
//   services: [serviceSchema],

//   nlp: {
//     synonyms: { type: Map, of: [String], default: {} },
//     keywords: {
//       order:   { type: [String], default: ['order', 'buy', 'food', 'meal', 'eat'] },
//       booking: { type: [String], default: ['book', 'appointment', 'reserve', 'schedule'] },
//     },
//   },

//   tone: {
//     style:    { type: String, enum: ['PROFESSIONAL', 'FRIENDLY', 'PREMIUM'], default: 'PROFESSIONAL' },
//     industry: { type: String, enum: ['RESTAURANT', 'SALON', 'RETAIL', 'GENERAL'], default: 'GENERAL' },
//   },

//   // All user-facing strings — owner overrides these; getLabel() reads them first
//   customMessages: {
//     // Welcome screen greeting (shown when user first messages)
//     welcomeMessage:      { type: String, default: '', trim: true },
//     // After-action messages (shown after successful order/booking)
//     afterOrder:          { type: String, default: '', trim: true },
//     afterBooking:        { type: String, default: '', trim: true },
//     // Payment instructions (Wave mobile money)
//     payment:             { type: String, default: '', trim: true },
//     paymentInstructions: { type: String, default: '', trim: true },
//     // Business-hours closed message
//     closed:              { type: String, default: '', trim: true },
//     // Flow prompt overrides (leave blank for smart defaults)
//     orderPrompt:         { type: String, default: '', trim: true },
//     bookPrompt:          { type: String, default: '', trim: true },
//     servicePrompt:       { type: String, default: '', trim: true },
//     timePrompt:          { type: String, default: '', trim: true },
//     // Fallback + cancel messages
//     cancelMsg:           { type: String, default: '', trim: true },
//     fallback:            { type: String, default: '', trim: true },
//     // Loop recovery message (shown when customer repeats same message 3x)
//     loopFallback:        { type: String, default: '', trim: true },
//   },

//   faq: [faqSchema],

//   settings: {
//     autoSuggestions:       { type: Boolean, default: true },
//     enableLearning:        { type: Boolean, default: true },
//     sessionTimeout:        { type: Number,  default: 30, min: 1 },
//     allowAfterHoursOrders: { type: Boolean, default: true },
//     closedMessage: {
//       type: String,
//       default: "We're currently closed. Please contact us during business hours.",
//       trim: true,
//     },
//   },

// }, { timestamps: true });

// // Sync tone from businessMode on save
// businessConfigSchema.pre('save', function (next) {
//   if (this.isModified('businessMode')) {
//     const toneMap = {
//       RESTAURANT: { style: 'FRIENDLY',     industry: 'RESTAURANT' },
//       SALON:      { style: 'PROFESSIONAL', industry: 'SALON' },
//       RETAIL:     { style: 'PROFESSIONAL', industry: 'RETAIL' },
//     };
//     const t = toneMap[this.businessMode];
//     if (t) { this.tone.style = t.style; this.tone.industry = t.industry; }
//   }
//   next();
// });

// businessConfigSchema.set('toJSON', {
//   transform: (doc, ret) => { delete ret.__v; return ret; },
// });

// export default mongoose.model('BusinessConfig', businessConfigSchema);











/**
 * models/BusinessConfig.js — WhatsBotLyn v3.1
 *
 * v3.0 changes:
 * - loopFallback added to customMessages (loop recovery override)
 * - All customMessages fields now have inline comments for non-technical owners
 * - businessMode: replaces the old "mode" field (RESTAURANT | SALON | RETAIL)
 *   Old "mode" kept as a computed virtual for backward-compat.
 * - services[]: Salon-style bookable services with name/duration/price.
 * - customMessages: expanded with welcomeMessage, paymentInstructions keys.
 * - All flow labels overridable via customMessages (read by config/modes.js getLabel()).
 * - NOTHING in flowService is hardcoded — everything flows through here.
 *
 * FIX (v3.1.1):
 * - phoneNumberId: required changed from true → false, sparse: true added.
 *   Root cause of "TypeError: Cannot read properties of undefined (reading 'length')":
 *   POST /register/business (step 2) upserts by tenantId BEFORE WhatsApp is connected
 *   (step 3 links phoneNumberId). The upsert insert path tried to create a doc without
 *   phoneNumberId, violating required:true → Mongoose ValidationError → unhandled crash.
 *   sparse:true allows multiple null values while still enforcing uniqueness for real IDs.
 * - mode enum: added null as allowed value to prevent validation errors when mode is null.
 */

import mongoose from 'mongoose';

const menuItemSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  price:       { type: Number, default: 0, min: 0 },
  description: { type: String, default: '', trim: true },
  keywords:    { type: [String], default: [] },
  available:   { type: Boolean, default: true },
}, { _id: true });

const serviceSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  duration:    { type: Number, default: 30, min: 5 },
  price:       { type: Number, default: 0, min: 0 },
  description: { type: String, default: '', trim: true },
  available:   { type: Boolean, default: true },
}, { _id: true });

const faqSchema = new mongoose.Schema({
  trigger: { type: String, required: true, trim: true },
  reply:   { type: String, required: true, trim: true },
}, { _id: true });

const businessConfigSchema = new mongoose.Schema({

  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant', index: true, sparse: true,
  },

  name:        { type: String, default: 'Our Business', trim: true },
  description: { type: String, default: '', trim: true },

  // ✅ FIX: required: false + sparse: true
  // Not required at model level: onboarding step 2 (POST /register/business)
  // runs before WhatsApp is connected (step 3). phoneNumberId is linked in
  // connectWhatsApp via $set. sparse:true allows multiple null values while
  // still enforcing uniqueness for non-null phoneNumberIds.
  phoneNumberId: {
    type:     String,
    required: false,   // ← was: required: true  (FIXED)
    unique:   true,
    sparse:   true,    // ← added: allows multiple docs with null phoneNumberId
    index:    true,
    trim:     true,
    default:  null,
  },

  // v15 canonical mode field
  businessMode: {
    type: String,
    enum: ['RESTAURANT', 'SALON', 'RETAIL'],
    default: 'RESTAURANT',
    index: true,
  },

  // Legacy field — kept for backward-compat; not used by v15 logic
  // ✅ FIX: added null to enum so default: null doesn't trigger a validation error
  mode: {
    type: String,
    enum: ['ORDER', 'BOOKING', 'BOTH', null],
    default: null,
  },

  botEnabled: { type: Boolean, default: true },
  // Legacy top-level wavePhone (kept for backward-compat with flowService)
  wavePhone:  { type: String, default: null, trim: true },
  adminPhone: { type: String, default: null, trim: true },

  // Nested payment config (used by paymentService)
  payment: {
    wavePhone:    { type: String, default: null, trim: true },
    currency:     { type: String, default: 'GMD', trim: true },
    requireProof: { type: Boolean, default: true },
  },

  hours: {
    enabled:  { type: Boolean, default: false },
    timezone: { type: String, default: 'UTC', trim: true },
    open:     { type: Number, default: 8, min: 0, max: 23 },
    close:    { type: Number, default: 22, min: 0, max: 23 },
    days: {
      type: Map,
      of: {
        open:   { type: Number, min: 0, max: 23 },
        close:  { type: Number, min: 0, max: 23 },
        closed: { type: Boolean, default: false },
      },
      default: {},
    },
  },

  menu:     [menuItemSchema],
  services: [serviceSchema],

  nlp: {
    synonyms: { type: Map, of: [String], default: {} },
    keywords: {
      order:   { type: [String], default: ['order', 'buy', 'food', 'meal', 'eat'] },
      booking: { type: [String], default: ['book', 'appointment', 'reserve', 'schedule'] },
    },
  },

  tone: {
    style:    { type: String, enum: ['PROFESSIONAL', 'FRIENDLY', 'PREMIUM'], default: 'PROFESSIONAL' },
    industry: { type: String, enum: ['RESTAURANT', 'SALON', 'RETAIL', 'GENERAL'], default: 'GENERAL' },
  },

  // All user-facing strings — owner overrides these; getLabel() reads them first
  customMessages: {
    // Welcome screen greeting (shown when user first messages)
    welcomeMessage:      { type: String, default: '', trim: true },
    // After-action messages (shown after successful order/booking)
    afterOrder:          { type: String, default: '', trim: true },
    afterBooking:        { type: String, default: '', trim: true },
    // Payment instructions (Wave mobile money)
    payment:             { type: String, default: '', trim: true },
    paymentInstructions: { type: String, default: '', trim: true },
    // Business-hours closed message
    closed:              { type: String, default: '', trim: true },
    // Flow prompt overrides (leave blank for smart defaults)
    orderPrompt:         { type: String, default: '', trim: true },
    bookPrompt:          { type: String, default: '', trim: true },
    servicePrompt:       { type: String, default: '', trim: true },
    timePrompt:          { type: String, default: '', trim: true },
    // Fallback + cancel messages
    cancelMsg:           { type: String, default: '', trim: true },
    fallback:            { type: String, default: '', trim: true },
    // Loop recovery message (shown when customer repeats same message 3x)
    loopFallback:        { type: String, default: '', trim: true },
  },

  faq: [faqSchema],

  settings: {
    autoSuggestions:       { type: Boolean, default: true },
    enableLearning:        { type: Boolean, default: true },
    sessionTimeout:        { type: Number,  default: 30, min: 1 },
    allowAfterHoursOrders: { type: Boolean, default: true },
    closedMessage: {
      type: String,
      default: "We're currently closed. Please contact us during business hours.",
      trim: true,
    },
  },

}, { timestamps: true });

// Sync tone from businessMode on save
businessConfigSchema.pre('save', function (next) {
  if (this.isModified('businessMode')) {
    const toneMap = {
      RESTAURANT: { style: 'FRIENDLY',     industry: 'RESTAURANT' },
      SALON:      { style: 'PROFESSIONAL', industry: 'SALON' },
      RETAIL:     { style: 'PROFESSIONAL', industry: 'RETAIL' },
    };
    const t = toneMap[this.businessMode];
    if (t) { this.tone.style = t.style; this.tone.industry = t.industry; }
  }
  next();
});

businessConfigSchema.set('toJSON', {
  transform: (doc, ret) => { delete ret.__v; return ret; },
});

export default mongoose.model('BusinessConfig', businessConfigSchema);