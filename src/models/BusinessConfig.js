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
  // [CATALOG-STOCK-1] Optional per-item stock count. null = untracked/unlimited
  // (the default — zero behaviour change for every existing tenant/item that
  // never sets this). When set, orderService.saveOrder() decrements it on every
  // confirmed order line and flips `available` to false once it hits 0, then
  // triggers an immediate WA Catalog resync so the Meta-facing listing doesn't
  // go stale between manual menu edits. See services/orderService.js
  // decrementStockForOrder().
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
  // [FIX-VARIANTS-SCHEMA] variants: product options (fashion sizes, retail
  // options, etc). Entries can be a plain string ('M') or an object with at
  // least a `name` field ({ name: 'M' }) — every reader in the codebase
  // (retail/flows/index.js, fashion/flows/index.js, waCatalogHelpers.js
  // resolveCatalogItem()) already does `v.name || v` / `String(v)` to accept
  // either shape, and scripts/seed.js seeds plain strings. This field was
  // missing from the schema entirely: Mongoose's default strict mode drops
  // any key not declared on the (sub)document schema when casting writes —
  // so every `variants` array sent via addMenuItem/updateMenuItem/updateMenu
  // (dashboardController.js and businessController.js), or via seed.js's
  // BusinessConfig.create(), was silently stripped before it ever reached
  // Mongo. That broke, all at once: fashion size selection and retail
  // variant selection (both fall back to "no variants — skip to quantity"
  // for EVERY item), and WA Catalog's variant-specific retailer IDs
  // (buildRetailerId()/resolveCatalogItem() in waCatalogHelpers.js), since
  // there was never a `variants` array on any persisted menu item to build
  // or resolve against.
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

  // ── Discount codes / promotions [PROMO-1] ─────────────────────────────────
  // Config-only feature — the bot's live flows never write here. A promo is
  // resolved and applied entirely inside orderService.saveOrder() at the
  // moment an order is persisted (see services/promoService.js), the same
  // pattern already used for stock decrement — so this never touches Session
  // or any in-flight flow state.
  promotions: {
    type: [{
      code:         { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
      type:         { type: String, enum: ['PERCENT', 'FIXED'], required: true },
      value:        { type: Number, required: true, min: 0 }, // percent (0-100) or fixed currency amount
      active:       { type: Boolean, default: true },
      minOrderValue:{ type: Number, default: 0, min: 0 },
      maxUses:      { type: Number, default: null, min: 1 }, // null = unlimited
      usedCount:    { type: Number, default: 0, min: 0 },
      expiresAt:    { type: Date, default: null },
      description:  { type: String, default: '', trim: true, maxlength: 200 },
    }],
    default: [],
  },

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

  // ── WA (Meta) Commerce Catalog — [CATALOG-1] ──────────────────────────────
  // Optional, per-tenant, off by default. Purely a visual presentation layer
  // on top of the existing menuItems/matchEngine/order-flow pipeline — see
  // src/modules/catalog/ for the integration. Follows the same additive
  // per-tenant-enum precedent as tone.industry/businessMode above (see
  // [FIX-TONE-1]/[FIX-TONE-2]) rather than a new top-level collection: the
  // retailer_id↔menuItem mapping is DERIVED from menuItems._id at send/sync
  // time (waCatalogHelpers.js buildRetailerId/parseRetailerId), so no
  // separate mapping table is needed and menuItems stays the single source
  // of truth for product data.
  waCatalog: {
    enabled:   { type: Boolean, default: false },
    // Meta Commerce Catalog ID this tenant's WhatsApp number is connected to.
    // Required for enabled:true to have any effect — see waCatalogConfig.js
    // isCatalogEnabled(), which treats enabled:true + no catalogId as "off".
    catalogId: { type: String, default: null, trim: true, maxlength: 100 },
    // AI_DECIDES  — offer WA Catalog when the already-classified intent looks
    //               like open browsing (see waCatalogConfig.js BROWSE_INTENTS).
    // ALWAYS_OFFER— offer WA Catalog on every START_ORDER-routed entry.
    // MANUAL_ONLY — WA Catalog is never sent automatically (reserved for a
    //               future explicit trigger, e.g. an admin "Send Catalog" action).
    mode: {
      type: String,
      enum: ['AI_DECIDES', 'ALWAYS_OFFER', 'MANUAL_ONLY'],
      default: 'AI_DECIDES',
    },
    // Set by waCatalogService.syncMenuToCatalog() on a successful push of
    // menuItems into the Meta Commerce Catalog. null = never synced.
    lastSyncedAt: { type: Date, default: null },
    // [CATALOG-CRUD-1] The retailer_ids pushed as part of the MOST RECENT
    // successful sync. Meta's Catalog Batch API has no "replace the whole
    // catalog with this list" mode — CREATE/UPDATE/DELETE are all per-item,
    // so the only way to know an item was REMOVED from menuItems (as opposed
    // to just never having existed) is to diff the current menuItems against
    // whatever was synced last time. This field is that "last time" snapshot;
    // syncMenuToCatalog() rewrites it after every successful run.
    syncedRetailerIds: { type: [String], default: [] },
    // [CATALOG-DELTA-1] retailer_id -> content hash (sha1 of the exact payload
    // last pushed for that item) from the MOST RECENT successful sync. Lets
    // syncMenuToCatalog() skip re-sending items whose content is unchanged,
    // instead of rebuilding+resending the full menu on every edit. Missing
    // entries (e.g. tenants who synced before this field existed) are treated
    // as "always changed" — self-healing, no migration needed.
    syncedItemHashes: { type: Map, of: String, default: {} },
    // [CATALOG-HEALTH-4] Set by waCatalogService.syncMenuToCatalog() on a
    // FAILED sync attempt (network error, Graph API rejection, missing
    // token) and cleared on the next SUCCESSFUL one. Previously a failing
    // sync only ever produced a log line — lastSyncedAt simply stayed stale
    // with no way for GET /:tenantId/wacatalog/health (and therefore no way
    // for an admin dashboard) to tell "hasn't synced in a while because
    // nothing changed" apart from "has been silently failing every attempt."
    lastSyncError: {
      reason: { type: String, default: null },
      at:     { type: Date,   default: null },
    },
  },

  // [MULTICART-v39] Per-tenant opt-in for multi-item orders (single checkout
  // carrying several distinct items, e.g. a cosmetics customer ordering a
  // lipstick + a foundation together instead of two separate orders).
  // Default false: every existing tenant keeps today's single-item-per-order
  // flow with zero behavior change. Follows the same additive
  // enabled-flag-on-a-nested-object precedent as waCatalog above.
  multiItemCart: {
    enabled:  { type: Boolean, default: false },
    // Upper bound on distinct items per order — protects against a customer
    // (or a stuck "add another?" loop) building an unbounded cart.
    maxItems: { type: Number, default: 10, min: 1, max: 50 },
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
