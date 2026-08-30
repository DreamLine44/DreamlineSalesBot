inspect this entire project and rearrange it completely into simpler and clean way/version. do not make any changes the logics of the codebases, just the files and folders structures, but merge the related files into a single one instead scattering the same function/feature (you should know what i want to say) into multiple files. and use the es6+ (arrow functions etc) ways of writting codes because its more shorter and cleaner.


**Refactor request: consolidate scattered logic into single files per feature**

Reorganize the codebase so that each distinct feature or piece of business logic lives entirely in **one file**, instead of being split across multiple files or folders. Specifically:

1. **One file per feature.** For every feature/domain (e.g. booking, order handling, admin commands, a specific business module), merge all of its related logic into a single file. If two files currently implement pieces of the same feature, combine them.
2. **Clear internal organization.** Within each merged file, separate the originally-distinct pieces with clear section markers or comments (e.g. banner comments noting which original file each block came from), so the file stays navigable even though it's now larger.
3. **Import, don't duplicate.** When one feature's file needs functionality from another feature, import it from that feature's file rather than re-implementing or copying logic.
4. **Preserve the existing top-level folder structure** under `src/` (e.g. `controllers/`, `services/`, `modules/`, `core/`, etc.) — consolidation happens *within* each area, not by flattening the whole project.
5. **Modern ES6+ style throughout.** Write (and where you're touching code anyway, rewrite) using clean, modern JavaScript conventions — arrow functions instead of `function` expressions where appropriate, `try/catch` for error handling instead of callback-style error checks, `const`/`let` (never `var`), template literals over string concatenation, destructuring, optional chaining/nullish coalescing, and other idiomatic ES6+ patterns that make the code shorter and easier to read.
6. **Goal:** if a bug needs fixing, I should be able to fix it in one file instead of hunting across several.

Do the full reorganization without pausing to ask for approval at each step. Rewire every import across the codebase to point at the new file locations, and verify nothing breaks (e.g. run the test suite) before considering it done. **Do not commit or push these changes** — leave them staged locally until I say so.

If the file tree below isnt good then you choose the structure if posible:

WhatSalesAgent/
├── .env.example
├── package.json
├── package-lock.json
└── src/
    ├── app.js
    │
    ├── config/
    │   ├── cloudinary.js
    │   ├── database.js
    │   ├── env.js
    │   ├── logger.js
    │   └── modes.js
    │
    ├── controllers/
    │   ├── adminUserController.js
    │   ├── businessController.js
    │   ├── dashboardController.js
    │   ├── menuImageController.js
    │   ├── simulateController.js
    │   ├── tenantController.js
    │   ├── webhookController.js
    │   └── whatsappOnboardingController.js
    │
    ├── core/                          # platform-level, module-agnostic engine
    │   ├── ai/
    │   │   └── providers/
    │   │       ├── aiRouter.js
    │   │       ├── groqProvider.js
    │   │       └── mockProvider.js
    │   ├── analytics/
    │   │   └── analyticsService.js
    │   ├── conversations/
    │   │   ├── bookingFlow.js
    │   │   ├── flowEngine.js
    │   │   ├── flowPassthroughRecovery.js
    │   │   └── moduleRouter.js
    │   ├── intents/
    │   │   ├── intentEngine.js
    │   │   ├── menuIntentDetector.js
    │   │   ├── negationGuard.js
    │   │   └── patterns.js
    │   ├── memory/
    │   │   └── customerMemory.js
    │   ├── nlu/
    │   │   ├── enhancedNlu.js
    │   │   └── nluContext.js
    │   ├── sentiment/
    │   │   └── emotionEngine.js
    │   ├── sessions/
    │   │   └── sessionService.js
    │   ├── shared/
    │   │   ├── cartEngine.js
    │   │   ├── confirmationMatcher.js
    │   │   ├── moduleRegistry.js
    │   │   └── uiOptionsHelper.js
    │   └── whatsapp/
    │       └── dispatcher.js
    │
    ├── middleware/
    │   ├── authMiddleware.js
    │   ├── errorHandler.js
    │   ├── onboardingValidation.js
    │   ├── rateLimiter.js
    │   ├── uploadMiddleware.js
    │   └── webhookSignature.js
    │
    ├── models/
    │   ├── AdminNotification.js
    │   ├── AdminUser.js
    │   ├── Analytics.js
    │   ├── AuditLog.js
    │   ├── Booking.js
    │   ├── BusinessConfig.js
    │   ├── Order.js
    │   ├── ProcessedMessage.js
    │   ├── Session.js
    │   ├── Tenant.js
    │   ├── UserProfile.js
    │   ├── WhatsAppConnectionRequest.js
    │   └── index.js
    │
    ├── modules/                       # one folder per business vertical
    │   ├── bakery/
    │   │   └── flows/
    │   │       ├── index.js
    │   │       └── orderFlow.js
    │   ├── catalog/                   # WhatsApp Catalog integration (cross-module)
    │   │   ├── waCatalogConfig.js
    │   │   ├── waCatalogFlow.js
    │   │   ├── waCatalogHelpers.js
    │   │   ├── waCatalogService.js
    │   │   └── waCatalogSyncScheduler.js
    │   ├── cosmetics/
    │   │   └── flows/
    │   │       ├── index.js
    │   │       └── orderFlow.js
    │   ├── delivery/
    │   │   └── flows/
    │   │       └── index.js
    │   ├── electronics/
    │   │   ├── configs/
    │   │   │   └── index.js
    │   │   ├── flows/
    │   │   │   ├── index.js
    │   │   │   └── orderFlow.js
    │   │   └── handlers/
    │   │       └── uiBuilders.js
    │   ├── fashion/
    │   │   └── flows/
    │   │       └── index.js
    │   ├── general/
    │   │   └── flows/
    │   │       └── index.js
    │   ├── restaurant/
    │   │   ├── configs/
    │   │   │   └── index.js
    │   │   ├── flows/
    │   │   │   └── orderFlow.js
    │   │   └── handlers/
    │   │       └── uiBuilders.js
    │   ├── retail/
    │   │   └── flows/
    │   │       └── index.js
    │   ├── salon/
    │   │   ├── flows/
    │   │   │   └── index.js
    │   │   └── salonHelpers.js
    │   └── services/
    │       └── flows/
    │           └── index.js
    │
    ├── routes/
    │   ├── adminRoutes.js
    │   ├── adminUserRoutes.js
    │   ├── businessRoutes.js
    │   ├── dashboardRoutes.js
    │   ├── simulateRoutes.js
    │   ├── tenantRoutes.js
    │   ├── webhookRoutes.js
    │   └── whatsappOnboardingRoutes.js
    │
    ├── scripts/
    │   ├── audit_menu_match_quality.js
    │   ├── genKey.js
    │   ├── health.js
    │   ├── migrate_backfill_payment_enabled.js
    │   ├── migrate_remove_raw_api_keys.js
    │   ├── migrate_reset_optimistic_catalog_confirm.js
    │   ├── migrate_set_meta_fields.js
    │   ├── migrate_unset_null_email.js
    │   ├── publishBookingDateFlow.mjs
    │   └── seed.js
    │
    ├── services/
    │   ├── activity/
    │   │   ├── activityLifecycleService.js
    │   │   ├── activityLookupService.js
    │   │   └── activityStatusService.js
    │   ├── admin/
    │   │   ├── adminAuthService.js
    │   │   ├── adminCommandService.js
    │   │   └── auditService.js
    │   ├── booking/
    │   │   ├── bookingDateFlow.js
    │   │   ├── bookingDateFlowProvisioner.js
    │   │   ├── bookingDateParser.js
    │   │   ├── bookingDatePickerUI.js
    │   │   ├── bookingInterpretation.js
    │   │   ├── bookingService.js
    │   │   └── bookingState.js
    │   ├── order/
    │   │   ├── activeOrderResolver.js
    │   │   ├── orderService.js
    │   │   └── promoService.js
    │   ├── question/
    │   │   ├── questionAnswerService.js
    │   │   └── questionModeHelper.js
    │   ├── whatsapp/
    │   │   ├── metaCredentialService.js
    │   │   ├── whatsappNotificationService.js
    │   │   └── whatsappOnboardingService.js
    │   ├── leadCaptureService.js
    │   ├── paymentService.js
    │   ├── postFlowHandler.js
    │   ├── schedulerService.js
    │   └── usageService.js
    │
    ├── tests/                         # flat folder, ~130 files, one .test.mjs per feature/bugfix
    │   └── <featureOrBug>.test.mjs    # naming: camelCase description, or vNN prefix for audit-driven fixes
    │       (e.g. cartEngine.test.mjs, bookingFlow.test.mjs, v23RestaurantFlowAudit.test.mjs)
    │
    └── utils/
        ├── businessHoursUtils.js
        ├── customerPhone.js
        ├── formatCurrency.js
        ├── formatPhone.js
        ├── itemLabel.js
        ├── matchEngine.js
        ├── parseBookingTime.js
        ├── parsePartySize.js
        └── parseQuantity.js
