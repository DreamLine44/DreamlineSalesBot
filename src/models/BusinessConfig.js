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
 * [FIX-TONE-1] tone.industry enum was missing 'SERVICES'. businessMode='SERVICES' tenants
 *              triggering a tone sync on save would get a Mongoose validation error on
 *              the industry field, causing the document save to fail entirely.
 * [FIX-TONE-2] toneMap in the pre-save hook was missing SERVICES and GENERAL entries.
 *              When a SERVICES or GENERAL tenant changed their businessMode, toneMap lookup
 *              returned undefined → the if(t) guard silently skipped the sync, leaving
 *              stale tone values from any previous businessMode on the document.
 */

import mongoose from 'mongoose';

const menuItemSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, maxlength: 100 },
  price:       { type: Number, default: 0, min: 0, max: 999999 },
  description: { type: String, default: '', trim: true, maxlength: 300 },
  keywords:    { type: [String], default: [], validate: { validator: v => v.length <= 20, message: 'Max 20 keywords per item' } },
  available:   { type: Boolean, default: true },
  // [FIX-STOCKCOUNT-SCHEMA] MenuPage.jsx's MENU-FIELDS-1 comment claims
  // menuItemSchema already supports stockCount ("per-item inventory —
  // auto-decrements on order, flips available:false at 0") — but the field
  // was never actually added here. Every stockCount write from the create
  // and edit forms has been silently dropped by Mongoose strict mode; no
  // item has ever had a persisted stock count. null = unlimited stock
  // (matches the frontend's "blank = unlimited" placeholder).
  stockCount:  { type: Number, default: null, min: 0 },
  // [v1-SALON] category: 'services'|'service' = appointment service; anything else = retail product.
  // Salon flow uses this to split the menu into bookable services vs purchasable products.
  category:    { type: String, default: null, trim: true, maxlength: 60 },
  // [v1-SALON] currency: per-item currency override (defaults to business.payment.currency)
  currency:    { type: String, default: null, trim: true, maxlength: 5 },
  // [v1-SALON] duration: appointment duration in minutes (used in service list descriptions)
  duration:    { type: Number, default: null, min: 5, max: 480 },
  // [v14-PREP] prep: service-specific preparation tip shown on booking confirmation and reminder.
  // e.g. "Please arrive with unwashed hair" for colour treatments.
  prep:        { type: String, default: null, trim: true, maxlength: 300 },

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

  // [FIX-VARIANTS-SCHEMA] variants was written by addMenuItem/updateMenuItem/
  // updateMenu (dashboardController.js and businessController.js) and by
  // scripts/seed.js, but absent from this schema — Mongoose strict mode
  // silently dropped it on every write. This broke fashion's SELECT_ITEM size
  // selection, retail's SELECT_VARIANT, and waCatalogHelpers.resolveCatalogItem's
  // variant-specific retailer_id resolution all at once, since item.variants
  // was never actually populated on any persisted item. Mixed type since both
  // plain strings (scripts/seed.js shape) and { name } objects (the shape every
  // reader also accepts via `v.name || v`) are written across this codebase.
  variants: {
    type: [mongoose.Schema.Types.Mixed],
    default: [],
    validate: { validator: v => v.length <= 20, message: 'Max 20 variants per item' },
  },
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
  address:     { type: String, default: null, trim: true, maxlength: 300 },  // [FIX-ADDR] Used by moduleRouter ABOUT and general/flows handleAbout — was absent from schema; Mongoose strict mode silently dropped every write.

  phoneNumberId: {
    // NOT required at model level: onboarding step 2 (POST /register/business) runs
    // BEFORE WhatsApp is connected (step 3). Sparse index still prevents two tenants
    // sharing the same phoneNumberId once it is set.
    type: String, required: false, unique: true, sparse: true, index: true, trim: true,
  },

  // v15 canonical mode field
  businessMode: {
    type: String,
    // [FIX-MODE-ENUM] SERVICES and GENERAL are registered modules with full configs
    // in modes.js and moduleRegistry.js but were missing from this enum. Any tenant
    // saving businessMode='SERVICES' or 'GENERAL' would get a Mongoose validation
    // error (or silently be rejected), making those modules unusable.
    enum: ['RESTAURANT', 'SALON', 'BARBERSHOP', 'RETAIL', 'BAKERY', 'FASHION', 'COSMETICS', 'ELECTRONICS', 'DELIVERY', 'SERVICES', 'GENERAL'],
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
    // [FIX-D] `enabled` was written by seed.js and read by orderFlow.js
    // (payment?.enabled) but was absent from the schema — Mongoose strict mode
    // silently dropped every write, so payment was always treated as disabled.
    enabled:      { type: Boolean, default: false },
    // Legacy single wavePhone — kept for backward-compat; prefer channels[] below
    wavePhone:    { type: String, default: null, trim: true },
    currency:     { type: String, default: 'GMD', trim: true },
    requireProof: { type: Boolean, default: true },
    // Multi-channel payment accounts. Each entry has a provider name and account number/phone.
    // Supported providers: Wave, GT Bank, EcoBank, Trust Bank (and any custom name).
    // Clients send a screenshot; the tenant admin confirms it — no automated verification.
    channels: {
      type: [{
        provider:    { type: String, required: true, trim: true, maxlength: 50 },  // e.g. "Wave", "GT Bank"
        accountNo:   { type: String, required: true, trim: true, maxlength: 100 }, // phone number or account number
        label:       { type: String, default: '', trim: true, maxlength: 100 },    // optional display label
        isDefault:   { type: Boolean, default: false },
      }],
      default: [],
    },
  },

  // [FIX-D] addOns array — read by orderFlow.js (business?.addOns) and written
  // by seed.js, but was missing from schema. Mongoose strict mode silently
  // dropped every write, so upsell logic never had items to offer.
  addOns: {
    type: [{
      name:  { type: String, required: true, trim: true },
      price: { type: Number, default: 0, min: 0 },
    }],
    default: [],
  },

  hours: {
    enabled:  { type: Boolean, default: false },
    timezone: { type: String, default: 'UTC', trim: true },
    // [FIX-4/13] Changed from { type: Number, max: 23 } (integer-only) to plain Number
    // with no max. Hours are now stored as decimal values: 8.5 = 08:30, 22.75 = 22:45.
    // isWithinBusinessHours() in webhookController already computes decimal hours
    // (h + m / 60) for the current time — previously the schema capped stored values
    // at integers, making minutes from any business-hours config always 0 and rendering
    // the decimal-hour comparison logic completely dead. Same fix applied to per-day
    // override fields below.
    open:     { type: Number, default: 8,  min: 0, max: 24 },
    close:    { type: Number, default: 22, min: 0, max: 24 },
    days: {
      type: Map,
      of: {
        open:   { type: Number, min: 0, max: 24 }, // [FIX-13] was max: 23
        close:  { type: Number, min: 0, max: 24 }, // [FIX-13] was max: 23
        closed: { type: Boolean, default: false },
      },
      default: {},
    },
  },

  // NOTE: field is 'menuItems' (not 'menu') — matches all code that reads/writes this field.
  // Renamed from 'menu' at v2.1 to fix silent data loss: seed, orderFlow, businessController,
  // and groqProvider all use 'menuItems', but the old schema field was 'menu', so Mongoose
  // strict mode silently dropped every write and returned [] on every read.
  menuItems: [menuItemSchema],
  services:  [serviceSchema],

  // ── Staff (salon / barbershop) ────────────────────────────────────────────
  // Used by salon/flows/index.js _getStaff() for stylist selection.
  // Each entry is either a plain string (stylist name) or an object with
  // at least a `name` field. When absent the stylist-selection step is skipped.
  // Previously absent from schema — Mongoose strict mode silently dropped every
  // write, so any staff list saved via dashboard or seed never persisted.
  staff: {
    type: [{
      name:        { type: String, required: true, trim: true, maxlength: 60 },
      displayName: { type: String, default: null, trim: true, maxlength: 60 },
      specialty:   { type: String, default: null, trim: true, maxlength: 100 }, // shown in stylist list description
      available:   { type: Boolean, default: true },
    }],
    default: [],
  },

  // ── WA (Meta) Commerce Catalog integration ────────────────────────────────
  // [CATALOG-CONFIG] Feature flag + sync bookkeeping for the WhatsApp/Meta
  // Commerce Catalog integration (see modules/catalog/*). Previously entirely
  // absent from this schema — every field written by the WA Catalog fixes
  // (enabled/catalogId toggles from onboarding, syncedRetailerIds/
  // syncedItemHashes snapshots from syncMenuToCatalog()) was silently dropped
  // by Mongoose strict mode on every save.
  waCatalog: {
    enabled:   { type: Boolean, default: false },
    catalogId: { type: String,  default: null },
    mode: {
      type: String,
      enum: ['AI_DECIDES', 'ALWAYS_OFFER', 'MANUAL_ONLY'],
      default: 'AI_DECIDES',
    },
    // [CATALOG-CRUD-1] Snapshot of retailer_ids currently live in Meta's
    // catalog as of the last successful sync — lets the next sync diff
    // against it to build DELETE requests for items removed since then.
    syncedRetailerIds: { type: [String], default: [] },
    // [CATALOG-DELTA-1] Per-retailer_id content hash from the last successful
    // sync — lets the next sync only re-send items whose data actually
    // changed, instead of re-uploading the tenant's entire catalog every time.
    syncedItemHashes: { type: Map, of: String, default: {} },
    // [CATALOG-ASYNC-VERIFY-1] Meta's items_batch POST is async — a 200
    // response only means the batch was ACCEPTED, returning `handles` to
    // check later via check_batch_request_status. Treating that 200 as
    // "the items are now live" (as this code previously did) is a
    // false-confidence bug: a batch can be accepted, then fail per-item
    // validation moments later, and this codebase would still show a green
    // "last synced" timestamp. Any handle whose status hasn't resolved to
    // finished/error by the end of a sync attempt is persisted here so the
    // NEXT sync call (manual or autosync) can check on it first — no
    // separate cron needed, since every route that can trigger a sync
    // already runs through syncMenuToCatalog().
    pendingBatchHandles: {
      type: [{ handle: String, at: Date, _id: false }],
      default: [],
    },
    lastSyncedAt: { type: Date, default: null },
    // [CATALOG-HEALTH-4] Cleared on the next successful sync.
    lastSyncError: {
      reason: { type: String, default: null },
      // [CATALOG-HEALTH-4] Meta's actual error.message/body text (truncated),
      // so a GRAPH_ERROR is diagnosable from the dashboard alone rather than
      // requiring a server-log lookup for the specifics.
      detail: { type: String, default: null },
      at:     { type: Date,   default: null },
    },
    // [FIX-CATALOG-SEND-HEALTH] Distinct from lastSyncError above: that field
    // only ever tracks the PRODUCT SYNC (items_batch upload into Meta's
    // catalog). It says nothing about whether the actual customer-facing
    // 'catalog_message'/'product_list' interactive SEND (waCatalogService.js
    // sendCatalogMessage() → dispatcher.js) is succeeding — a tenant's sync
    // can be perfectly healthy (products live in Commerce Manager) while
    // every send still 400/403s from Meta (e.g. catalog not connected to the
    // WABA in WhatsApp Manager, or missing catalog permission on the system
    // user), which previously was only visible in server logs. dispatcher.js
    // now writes here on every failed catalog-type send so this is
    // diagnosable from getWaCatalogHealth() alone.
    lastSendError: {
      reason: { type: String, default: null },
      detail: { type: String, default: null },
      at:     { type: Date,   default: null },
    },
  },


  nlp: {
    synonyms: { type: Map, of: [String], default: {} },
    keywords: {
      order:   { type: [String], default: ['order', 'buy', 'food', 'meal', 'eat'] },
      booking: { type: [String], default: ['book', 'appointment', 'reserve', 'schedule'] },
    },
  },

  tone: {
    style:    { type: String, enum: ['PROFESSIONAL', 'FRIENDLY', 'PREMIUM'], default: 'PROFESSIONAL' },
    // [FIX-TONE-1] SERVICES was present in businessMode enum but missing here.
    // Any tenant saving businessMode='SERVICES' and triggering a tone sync would
    // get a Mongoose validation error on the industry field, preventing the save.
    industry: { type: String, enum: ['RESTAURANT', 'SALON', 'BARBERSHOP', 'RETAIL', 'BAKERY', 'FASHION', 'COSMETICS', 'ELECTRONICS', 'DELIVERY', 'SERVICES', 'GENERAL'], default: 'GENERAL' },
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
    // [FIX-SCHEMA-REOPENED] Message sent when a customer messages again after the business
    // re-opens following a closed period. webhookController reads customMessages.reopened
    // but this field was absent from the schema — Mongoose strict mode silently dropped
    // any write to it, meaning a tenant's custom reopen message was never persisted.
    reopened:            { type: String, default: '', trim: true, maxlength: 500 },
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

  // [FIX-MULTIITEMCART-SCHEMA] PreferencesPage.jsx builds and saves a
  // "Multi-Item Cart" toggle (multiItemCart.enabled / multiItemCart.maxItems)
  // but this field was entirely absent from the schema — under Mongoose's
  // default strict mode every save silently dropped it. Never persisted
  // anything until now. Same "missing schema field → silent data loss"
  // pattern already hit repeatedly elsewhere in this codebase (menuItemSchema
  // variants, waCatalog, Tenant.whatsapp timestamps, etc.).
  multiItemCart: {
    enabled:  { type: Boolean, default: false },
    maxItems: { type: Number,  default: 10, min: 1, max: 100 },
  },

  settings: {
    autoSuggestions:       { type: Boolean, default: true },
    enableLearning:        { type: Boolean, default: true },
    sessionTimeout:        { type: Number,  default: 30, min: 1 },
    allowAfterHoursOrders: { type: Boolean, default: true },
    maxOrderQuantity:      { type: Number,  default: 20, min: 1, max: 500 },
    estimatedDeliveryMinutes: { type: Number,  default: null, min: 1, max: 1440 }, // null = no fixed ETA shown
    vipThreshold:          { type: Number,  default: 5,  min: 1, max: 1000 },  // orders needed for VIP status
    // [v1-SALON] Salon/barbershop specific settings
    requireNamedStylist:   { type: Boolean, default: false }, // true = no "Any available" option shown
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
      FASHION:     { style: 'PREMIUM',      industry: 'FASHION'      },
      COSMETICS:   { style: 'PREMIUM',      industry: 'COSMETICS'    },
      ELECTRONICS: { style: 'PROFESSIONAL', industry: 'ELECTRONICS'  },
      DELIVERY:    { style: 'FRIENDLY',     industry: 'DELIVERY'     },
      // [FIX-TONE-2] SERVICES and GENERAL were in businessMode enum but missing
      // from toneMap. When a SERVICES or GENERAL tenant saved, toneMap lookup
      // returned undefined → the if(t) guard silently skipped the tone sync,
      // leaving stale tone values from a previous businessMode on the document.
      SERVICES:    { style: 'PROFESSIONAL', industry: 'SERVICES'     },
      GENERAL:     { style: 'FRIENDLY',     industry: 'GENERAL'      },
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
