# business/DATA_MODELS.md

Source: `models/*.js`. Mongoose, `strict` mode (default = `true`).

## THE recurring bug pattern in this codebase

**Any field written via `$set`/`updateSession`/`.save()` that isn't
declared in its schema is silently dropped — no error, no log, nothing.**
Any value written to an `enum` field that isn't in the enum list either
throws a `ValidationError` (sometimes swallowed by an upstream `.catch()`)
or, for non-required enum fields without a matching default path, silently
becomes `null`. This has been the single most common bug class found across
every audit pass in this project's history:

- `Session.currentFlow` — has an explicit maintenance-rule comment IN THE
  SCHEMA (see below) precisely because this bit the project repeatedly.
- `pendingCatalogQueue` / `multiItemCart` — written throughout the WA
  Catalog flow, absent from `BusinessConfig` → all cart data silently
  discarded.
- `BusinessConfig.menuItems[].variants` — written throughout the
  variant-selection flow, absent from `menuItemSchema` → all variant writes
  silently discarded.
- `BusinessConfig.address` — read by `ABOUT` handlers, absent from the
  schema → operator's configured address never actually saved.
- `BusinessConfig.customMessages.reopened` — read by `webhookController`,
  absent from `customMessages` schema → custom reopen message never
  persisted.

**Before writing any new field anywhere in this codebase, grep the relevant
model file first and confirm the field is declared. If it isn't, declare it
in the same change — don't defer it.**

## `Session` (`models/Session.js`)

Composite lookup key: `phone = "${customerPhone}_${tenantId}"` (see
`sessionKey()` in `core/sessions/sessionService.js`). TTL-indexed via
`expiresAt` (dynamic TTL — see `.ai/business/SESSION_RULES.md`).

Key fields: `customerPhone`, `customerName`, `phoneNumberId`, `currentFlow`
(strict enum — **has an explicit in-schema maintenance-rule comment**: every
flow name passed to `startFlow({ flowName })` or written directly to
`session.currentFlow` must be added to this enum at the same time it's
registered in `moduleRegistry.js`, "failure to do so = silent null write =
broken flow, no error logged"), `step`, `data` (freeform `Object` — flow
handlers store step-specific working data here), `suggestion`,
`pendingIntent`, `previousStep`/`previousFlow`, `lastMessage`/`lastWamid`/
`lastBotMessage`/`lastIntent`/`lastSeen`, `tenantId`, `isCompleted`,
`humanMode`/`humanModeNotified`, `loopCount`/`lastLoopMessage`/
`lastLoopStep` (loop-prevention), `lastRapidMessage`/`lastRapidMessageAt`
(rapid-duplicate suppression), `lastOrderStatusAckAt`, `lastAorInterceptAt`
(AOR throttle), `mode`, `stepHistory`, `upsellSent`, `pendingAddOn`,
`menuViewed`, `postFlowAck`/`postFlowData`, `paymentRetryCount`,
`messageCount`, `abandonedAt`/`abandonedFlow`/`abandonedItem`,
`closedMsgSent`, `expiresAt`.

## `BusinessConfig` (`models/BusinessConfig.js`)

Per-tenant storefront config. Sub-schemas:
- `menuItemSchema` — `name`, `price`, `description`, `keywords[]`,
  `available`, `category`, `currency`, `duration`, `prep`,
  `image: { url, public_id }`, `tags[]`, `showImageOnSelect`, `variants`
  (`Mixed[]`, max 20 — intentionally `Mixed` because both plain strings and
  `{ name }` objects are written across the codebase; every reader accepts
  `v.name || v`).
- `serviceSchema` — `name`, `duration`, `price`, `description`, `available`.
- `faqSchema` — `trigger`, `reply`.

Top-level: `tenantId`, `name`, `description`, `address`, `phoneNumberId`
(unique/sparse), `businessMode` (enum — see
`.ai/PROJECT_OVERVIEW.md` for the vertical list; **add here whenever adding
a new vertical**), `mode` (`ORDER`|`BOOKING`|`BOTH`), `botEnabled`,
`wavePhone`/`adminPhone`, `payment { enabled, wavePhone, currency,
requireProof, channels }`, `addOns[]`, `hours { enabled, timezone, days,
open, close }` (timezone-aware — see `.ai/references/RECURRING_BUG_PATTERNS.md`),
`menuItems[]`, `services[]`, `staff[]`, `waCatalog { enabled, catalogId,
mode, syncedRetailerIds[], syncedItemHashes (Map), lastSyncedAt,
lastSyncError }` (see `.ai/modules/CATALOG.md`), `customMessages { ... }`
(operator overrides for bot copy — checked FIRST by `config/modes.js`
`getLabel()`, before module defaults), `leadCapture { enabled, triggerOn,
fields[], promptMessage, thankYouMsg }` (off by default, no behavior change
until a tenant opts in), `settings { autoSuggestions, enableLearning,
sessionTimeout, allowAfterHoursOrders, maxOrderQuantity, estimatedDeliveryMinutes,
vipThreshold, ... }`.

## `Order` (`models/Order.js`)

`tenantId`/`businessId`, `customerPhone` (+ legacy `phone` alias),
`customerName`, `idempotencyKey` (dedupe guard for double-submits), `item`
(single-item legacy string field), `quantity`, `addOns[]`, **`items[]`**
(the current multi-item cart array — `{ name, quantity, price, addOns,
variant, ... }` shape; see MULTICART-v39/v40 in
`.ai/references/RECURRING_BUG_PATTERNS.md`), `totalPrice`, `status` (enum:
pending → confirmed → preparing → ready → out_for_delivery → delivered, plus
terminal states), `paymentMethod` (enum incl. `wave`, `gt_bank`, `ecobank`,
`trust_bank`, `cash`, `card`, `other`, `null`), `paymentStatus` (enum),
`paymentProof`, `paymentInitiatedAt`/`proofReceivedAt`,
`paymentReviewedBy`/`paymentReviewedAt`, `verifiedBy`/`verifiedAt`,
`rejectedNote`, `notes`, `paymentReference`, `paymentReminderSentAt`,
`abandonedCartAt`, per-status timestamp fields
(`preparingAt`/`readyAt`/`outForDeliveryAt`/`completedAt`/`deliveredAt`),
`cancelledBy`/`cancelledAt`, `shortId` (customer-facing short order
reference).

**`resolveOrderFields()`** (`services/orderService.js`) is a pure,
independently-testable function that decides whether an order is
single-item (`item`+`quantity`) or multi-item (`items[]`) shape and
computes `totalPrice` consistently — this is the one place that logic
lives; don't recompute order totals ad hoc elsewhere.

## `Booking` (`models/Booking.js`)

`tenantId`/`businessId`, `customerPhone`/`phone`, `date`/`parsedDate`/`time`,
`service`, `duration`, `staff`, `bookingType` (`appointment`|`walkin`|`null`),
`customerName`, `partySize`, `notes`, `status` (`pending`|`confirmed`|
`completed`|`cancelled`), `notifiedAt`,
`adminConfirmedAt`/`adminConfirmedBy`, `adminDeclinedAt`/`adminDeclinedBy`,
`adminNote`, `cancelledBy`/`cancelledAt`, `shortId`,
`reminderSentAt`/`followUpSentAt`.

## `Tenant` (`models/Tenant.js`)

The SaaS account. `name`, `email`, `apiKeyHash` (never store the raw key),
`whatsapp { phone, phoneNumberId, wabaId, accessToken, verifyToken,
webhookSecret, apiVersion, connected, tokenUpdatedAt, connectedAt,
lastVerifiedAt }` — secrets encrypted via `ENCRYPTION_KEY` (see
`.ai/references/RAILWAY_ENV.md`; falls back to plaintext with a loud boot
warning if unset), `plan` (`FREE`|`STARTER`|`PRO`|`ENTERPRISE`), `limits {
messagesPerMonth, maxMenuItems, maxAdmins }`, `usage { messagesThisMonth,
resetDate }`, `status` (`ACTIVE`|`SUSPENDED`|`PENDING`|`INACTIVE`),
`onboardingStep`, `adminPhone`, `meta { appId, appSecret }` (tenant's own
dedicated Meta app credentials, also encrypted), `notes`.

## Other models

- `ProcessedMessage` — dedupe guard keyed on Meta `wamid` (pipeline step 1).
- `UserProfile`, `AuditLog` (written by `services/auditService.js`'s
  `logAudit()` for `order_created`/`payment_approved`/`payment_rejected`),
  `Analytics` (written by `core/analytics/analyticsService.js`),
  `WhatsAppConnectionRequest` (onboarding handshake),
  `AdminUser`/`AdminNotification` (dashboard admin accounts + alerts).

## Adding a new field — checklist

1. Declare it in the relevant schema file in `models/`, with an explicit
   `default` (Mongoose won't infer one).
2. If it's an enum-constrained field, add every value you intend to write
   to the `enum` array in the same change.
3. Grep the codebase for every place that will read/write it and confirm
   they agree on the shape (plain value vs. nested object vs. array).
4. If it needs to survive a session reset, check whether `createSession()`
   in `sessionService.js` should preserve it explicitly (like
   `customerName`/`humanMode` do) or should be wiped on reset (the default).
5. Write a regression test that would fail on the old (undeclared-field)
   code — see `.ai/development/TESTING.md`.
