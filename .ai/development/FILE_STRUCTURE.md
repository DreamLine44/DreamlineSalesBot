# development/FILE_STRUCTURE.md

Directory-by-directory responsibility map (166 source files at last audit).
When you need to change behavior, use this table to find the right file
FIRST — don't guess based on a filename alone; several files have
overlapping-sounding names with distinct responsibilities (e.g. two
different things are called "catalog" — see `.ai/modules/CATALOG.md`).

```
app.js                              Express app bootstrap, middleware chain, route mounting,
                                     graceful shutdown. Route mount ORDER is load-bearing (Rule 3).

config/
  env.js                            validateEnv() — crashes fast at boot on missing/misconfigured vars
  logger.js                         Structured logger
  database.js                       connectToDB() — Mongoose connection
  cloudinary.js                     CLOUDINARY_ENABLED flag + client init (image uploads)
  modes.js                          MODE_MAP — businessMode → vertical config; getLabel() for
                                     customMessages-override-then-default text resolution

controllers/
  webhookController.js              THE pipeline (3100+ lines) — handleIncomingMessage(),
                                     isWithinBusinessHours(), all mid-flow intercept detectors,
                                     WEBHOOK_BUILD_MARKER (bump this on every meaningful deploy —
                                     curl /health after deploy to confirm Railway is running it)
  businessController.js             Tenant-scoped business-config CRUD (menu, hours, waCatalog, etc.)
  dashboardController.js            Dashboard API — orders, bookings, analytics, conversations,
                                     customers, settings, menu, services, FAQs (all under /dashboard)
  tenantController.js               Platform-level tenant CRUD (super-admin only) + encryptToken/
                                     decryptToken (shared by dispatcher.js for WhatsApp credentials)
  adminUserController.js            Dashboard admin-user accounts (login, invites)
  whatsappOnboardingController.js   Tenant-facing + admin-facing WhatsApp connection handshake
  menuImageController.js            Menu item image upload (Cloudinary)
  simulateController.js             Dev-only /api/message simulation endpoint (never in production)

core/
  ai/providers/
    aiRouter.js                     Provider-agnostic facade — getAIReply, generateGreeting, aiHealthCheck
    groqProvider.js                 Groq implementation — buildSystemPrompt, getReply, classifyIntent
    mockProvider.js                 Deterministic fallback when Groq unavailable/no API key
  analytics/analyticsService.js     Event tracking (orders, bookings, revenue, failed interactions)
  conversations/
    flowEngine.js                   advance/startFlow/cancelFlow/completeFlow — the step machine
    moduleRouter.js                 route() — the action switch + ACTION_REGISTRY fallback
    bookingFlow.js                  Shared BOOKING flow used by 8 of the 11 modes
  intents/
    intentEngine.js                 detectIntent() — the decision brain (see flows/INTENT_DETECTION.md)
    patterns.js                     BUTTON_ID_MAP, EMOJI_MAP, INTENT_PATTERNS
    negationGuard.js                analyzeMessage() — complaint/cancel/correction/confirm detection
  memory/customerMemory.js          Cross-session customer facts (NOT the Session document)
  sentiment/emotionEngine.js        Pre-flow emotion detection + tone application on AI replies
  sessions/sessionService.js        Session CRUD + dynamic TTL (see business/SESSION_RULES.md)
  shared/
    moduleRegistry.js               registerAllModules() — wires every vertical at boot
    uiOptionsHelper.js               buildOptionsReply() — small shared UI-builder helper
  whatsapp/dispatcher.js            THE ONLY file that calls the Meta Graph API (Rule 4)

middleware/
  authMiddleware.js                 requireApiKey, requireSuperAdminKey
  rateLimiter.js                    createRateLimiter, webhookLimiter, adminLimiter, overviewLimiter,
                                     catalogSyncLimiter, humanModeLimiter
  errorHandler.js                   Express error-handling middleware (mounted last)
  webhookSignature.js               verifyMetaSignature — HMAC check on raw webhook body
  uploadMiddleware.js               uploadSingle — multipart image upload handling
  onboardingValidation.js           Request-shape validation for the WhatsApp onboarding flow

models/                             See business/DATA_MODELS.md for full field-level detail
  Session.js, BusinessConfig.js, Order.js, Booking.js, Tenant.js,
  ProcessedMessage.js, UserProfile.js, Analytics.js, AuditLog.js,
  WhatsAppConnectionRequest.js, AdminUser.js, AdminNotification.js, index.js

modules/
  catalog/                          WA Commerce Catalog integration — see modules/CATALOG.md
  <vertical>/                       One dir per business vertical — see modules/BUSINESS_MODULES.md
    configs/  and/or flows/index.js   <VERTICAL>_CONFIG (steps, ui, persona, messages)
    flows/                          Per-step flow handler(s)
    handlers/                       UI-builder helpers (restaurant, electronics)

routes/                             One Express Router per API surface — see ARCHITECTURE.md
                                     "Route mount order" for how these compose in app.js
  webhookRoutes.js, businessRoutes.js, dashboardRoutes.js, tenantRoutes.js,
  adminRoutes.js, adminUserRoutes.js, whatsappOnboardingRoutes.js, simulateRoutes.js

scripts/                            One-off/maintenance — run manually or via package.json script
  genKey.js, health.js, seed.js,
  migrate_remove_raw_api_keys.js, migrate_set_meta_fields.js, migrate_unset_null_email.js

services/                           Cross-cutting business logic used by controllers/flows
  activeOrderResolver.js            AOR — single source of truth for "does this customer have an
                                     active order right now" (see flows/POST_FLOW.md)
  adminCommandService.js            Admin text/button command handling (confirm/reject/etc.)
  auditService.js                   logAudit() — writes AuditLog entries
  bookingService.js                 saveBooking, getBookingByShortId, getActiveBooking
  leadCaptureService.js             Post-order/booking name/contact capture sequence
  metaCredentialService.js          Meta credential verification, WABA/phone-number discovery
  orderService.js                   resolveOrderFields (pure), saveOrder, getRecentOrders, getLastOrderItem
  paymentService.js                 receiveProof, handleDonePayment, buildPaymentInstructionsUI
  postFlowHandler.js                handlePostFlowMessage — the postFlowAck state machine
  promoService.js                   validatePromoCode, applyPromoUsage
  schedulerService.js               startScheduler/stopScheduler — background cron-style jobs
  usageService.js                   incrementTenantUsage, getTenantUsageSummary
  whatsappNotificationService.js    Notifies admins of new onboarding connection requests

tests/                              node:test + node:assert/strict — see development/TESTING.md

utils/
  parseQuantity.js                  Parses "2", "two", "a couple" etc. into a number
  matchEngine.js                    findBestMatch() — fuzzy product/menu-item name matching
```
