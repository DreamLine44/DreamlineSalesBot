/**
 * models/BusinessConfig.js
 *
 * Stores all per-tenant bot configuration: business mode, menu/services,
 * hours, payment, tone, custom messages, and FAQ.
 *
 * businessMode (canonical): RESTAURANT | SALON | RETAIL
 * mode (legacy):            ORDER | BOOKING | BOTH — kept for backward-compat.
 *
 * phoneNumberId is NOT required at model level: step 2 of onboarding runs
 * BEFORE WhatsApp is connected (step 3). Sparse index prevents two tenants
 * sharing the same phoneNumberId once it is set.
 *
 * All user-facing strings flow through customMessages → getLabel() in config/modes.js.
 */

import mongoose from 'mongoose';

const menuItemSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 100 },
  price:       { type: Number, default: 0, min: 0, max: 999999 },
  description: { type: String, default: '', trim: true, maxlength: 300 },
  keywords:    { type: [String], default: [], validate: { validator: v => v.length <= 20, message: 'Max 20 keywords per item' } },
  available:   { type: Boolean, default: true },

  // ── Optional image (Cloudinary) ────────────────────────────────────────
  // All image fields are optional. The bot works perfectly with no images.
  // image.url         → https://res.cloudinary.com/... (direct WhatsApp link)
  // image.public_id   → cloudinary asset ID (for deletion / replacement)
  // showImageOnSelect → when false, image is stored but never auto-sent
  // tags              → ["popular", "new", "special"] — drives upsell logic
  image: {
    url:       { type: String, default: null, trim: true },
    public_id: { type: String, default: null, trim: true },
  },
  tags:              { type: [String], default: [] },  // e.g. ["popular", "new", "special"]
  showImageOnSelect: { type: Boolean,  default: true },
}, { _id: true });

const serviceSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 100 },
  duration:    { type: Number, default: 30, min: 5, max: 480 },
  price:       { type: Number, default: 0, min: 0, max: 999999 },
  description: { type: String, default: '', trim: true, maxlength: 300 },
  available:   { type: Boolean, default: true },
}, { _id: true });

const faqSchema = new mongoose.Schema({
  trigger: { type: String, required: true, trim: true, maxlength: 200 },
  reply:   { type: String, required: true, trim: true, maxlength: 1000 },
}, { _id: true });

const businessConfigSchema = new mongoose.Schema({

  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant', index: true, sparse: true,
  },

  name:        { type: String, default: 'Our Business', trim: true, maxlength: 100 },
  description: { type: String, default: '', trim: true, maxlength: 500 },

  phoneNumberId: {
    // NOT required at model level: onboarding step 2 (POST /register/business) runs
    // BEFORE WhatsApp is connected (step 3). Sparse index still prevents two tenants
    // sharing the same phoneNumberId once it is set.
    type: String, required: false, unique: true, sparse: true, index: true, trim: true,
  },

  // v15 canonical mode field
  businessMode: {
    type: String,
    enum: ['RESTAURANT', 'SALON', 'BARBERSHOP', 'RETAIL', 'BAKERY', 'SUPERMARKET', 'FASHION', 'COSMETICS', 'ELECTRONICS', 'PHARMACY', 'DELIVERY'],
    default: 'RESTAURANT',
    index: true,
  },

  // Legacy field — kept for backward-compat; not used by v15 logic
  mode: {
    type: String,
    enum: ['ORDER', 'BOOKING', 'BOTH'],
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
    industry: { type: String, enum: ['RESTAURANT', 'SALON', 'BARBERSHOP', 'RETAIL', 'BAKERY', 'SUPERMARKET', 'FASHION', 'COSMETICS', 'ELECTRONICS', 'PHARMACY', 'DELIVERY', 'GENERAL'], default: 'GENERAL' },
  },

  // All user-facing strings — owner overrides these; getLabel() reads them first
  customMessages: {
    // Welcome screen greeting (shown when user first messages)
    welcomeMessage:      { type: String, default: '', trim: true, maxlength: 1000 },
    // After-action messages (shown after successful order/booking)
    afterOrder:          { type: String, default: '', trim: true, maxlength: 500 },
    afterBooking:        { type: String, default: '', trim: true, maxlength: 500 },
    // Payment instructions (Wave mobile money)
    payment:             { type: String, default: '', trim: true, maxlength: 1000 },
    paymentInstructions: { type: String, default: '', trim: true, maxlength: 1000 },
    // Business-hours closed message
    closed:              { type: String, default: '', trim: true, maxlength: 500 },
    // Flow prompt overrides (leave blank for smart defaults)
    orderPrompt:         { type: String, default: '', trim: true, maxlength: 300 },
    bookPrompt:          { type: String, default: '', trim: true, maxlength: 300 },
    servicePrompt:       { type: String, default: '', trim: true, maxlength: 300 },
    timePrompt:          { type: String, default: '', trim: true, maxlength: 300 },
    // Fallback + cancel messages
    cancelMsg:           { type: String, default: '', trim: true, maxlength: 500 },
    fallback:            { type: String, default: '', trim: true, maxlength: 500 },
    // Loop recovery message (shown when customer repeats same message 3x)
    loopFallback:        { type: String, default: '', trim: true, maxlength: 500 },
    // Human mode message (shown when humanMode=true so customer knows a human will reply)
    humanMode:           { type: String, default: '', trim: true, maxlength: 500 },
  },

  faq: [faqSchema],

  // ── Lead Capture (optional) ───────────────────────────────────────────────
  // When enabled, the bot collects customer name/contact before the first flow.
  // Controlled by leadCaptureService. Off by default — no behaviour change.
  leadCapture: {
    enabled:       { type: Boolean, default: false },
    triggerOn:     { type: String, enum: ['FIRST_MESSAGE', 'AFTER_ORDER', 'AFTER_BOOKING', 'MANUAL'], default: 'FIRST_MESSAGE' },
    fields:        { type: [String], default: ['name', 'email'] }, // which fields to collect
    promptMessage: { type: String, default: null, trim: true, maxlength: 500 }, // custom opening line
    thankYouMsg:   { type: String, default: null, trim: true, maxlength: 300 }, // custom thank-you
    notifyAdmin:   { type: Boolean, default: true }, // send admin a WhatsApp alert per lead
  },

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
      RESTAURANT:  { style: 'FRIENDLY',     industry: 'RESTAURANT'  },
      SALON:       { style: 'PROFESSIONAL', industry: 'SALON'        },
      BARBERSHOP:  { style: 'FRIENDLY',     industry: 'BARBERSHOP'   },
      RETAIL:      { style: 'PROFESSIONAL', industry: 'RETAIL'       },
      BAKERY:      { style: 'FRIENDLY',     industry: 'BAKERY'       },
      SUPERMARKET: { style: 'PROFESSIONAL', industry: 'SUPERMARKET'  },
      FASHION:     { style: 'PREMIUM',      industry: 'FASHION'      },
      COSMETICS:   { style: 'PREMIUM',      industry: 'COSMETICS'    },
      ELECTRONICS: { style: 'PROFESSIONAL', industry: 'ELECTRONICS'  },
      PHARMACY:    { style: 'PROFESSIONAL', industry: 'PHARMACY'     },
      DELIVERY:    { style: 'FRIENDLY',     industry: 'DELIVERY'     },
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
