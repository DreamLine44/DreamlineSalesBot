# controllers/ADMIN_APIS.md

Covers the three controllers backing the dashboard frontend
(`whatsales-frontend`, separate repo) and the platform admin surface:
`dashboardController.js`, `tenantController.js`,
`whatsappOnboardingController.js`. All routes here require
`enforceTenantScope` (dashboard/business) or `requireSuperAdminKey`
(tenant CRUD) — see `.ai/references/MULTI_TENANT_SECURITY.md`. For which of
these response fields the frontend actually renders (and therefore
shouldn't be renamed/removed without coordination), see
`.ai/references/FRONTEND_CONTRACT.md`.

## `dashboardController.js` — tenant-scoped operational API (`/dashboard/:tenantId/*`)

The full surface the dashboard frontend polls/mutates against, mounted
behind `enforceTenantScope` for every route (`routes/dashboardRoutes.js`):

| Function | Route | Notes |
|---|---|---|
| `getDashboardOverview` | `GET /overview` | Polled by the frontend every ~120s (`overviewLimiter`) |
| `getOrders` / `getCustomerOrderHistory` | `GET /orders`, `GET /orders/customer/:customerPhone` | |
| `updateOrderStatus` | `PATCH /orders/:orderId/status` | **Notifies the customer via WhatsApp** on confirm/complete/cancel-reject — a prior version updated the DB with zero customer notification, a real regression this fix addresses (`[FIX-6a]`). Any new status-transition endpoint you add should notify the customer the same way, not silently update the DB. |
| `notifyOrderReady` | `POST /orders/:orderId/notify-ready` | |
| `getBookings` / `updateBookingStatus` | `GET /bookings`, `PATCH /bookings/:bookingId/status` | |
| `getAnalytics` / `getAnalyticsTimeseriesHandler` | `GET /analytics`, `GET /analytics/timeseries` | Backed by `core/analytics/analyticsService.js` |
| `getConversations` / `setHumanMode` | `GET /conversations`, `PATCH /conversations/:phone/human` | `setHumanMode` is the dashboard-side toggle for the same `humanMode` field the bot checks — see `.ai/business/SESSION_RULES.md`. Rate-limited via `humanModeLimiter` (5/min) specifically because rapid toggling could expose the bot to a customer mid-human-mode. |
| `getCustomers` | `GET /customers` | |
| `getBusinessSettings` / `updateBusinessSettings` | `GET /settings`, `PATCH /settings` | `BusinessConfig.settings` — see `.ai/business/DATA_MODELS.md` |
| `getMenu` / `addMenuItem` / `updateMenuItem` / `deleteMenuItem` | `/menu*` | Menu mutations here should trigger a WA Catalog re-sync if the tenant has catalog enabled — see `.ai/modules/CATALOG.md`'s sync-scheduler section; confirm any new menu-mutation endpoint calls into `scheduleWaCatalogSync()`. |
| `uploadMenuItemImage` / `removeMenuItemImage` | `/menu/:itemId/image` | Cloudinary-backed (`config/cloudinary.js`) |
| `getServices` / `addService` / `updateService` / `deleteService` | `/services*` | |
| `getFaqs` / `addFaq` / `updateFaq` / `deleteFaq` | `/faqs*` | `faqSchema` (`trigger`, `reply`) in `BusinessConfig.js` |

**Pattern to follow for any new dashboard endpoint:** if it changes
something the bot pipeline reads live (menu availability, hours, human
mode, order/booking status), make sure the write path is the SAME code
path the rest of the app uses (e.g. route status changes through
`flowEngine`/`adminCommandService` semantics where applicable) rather than
a raw `$set` that bypasses side effects like customer notification, catalog
sync scheduling, or session TTL implications.

## `tenantController.js` — platform-level tenant CRUD (`/admin/tenants/*`, super-admin only)

| Function | Notes |
|---|---|
| `createTenant` / `listTenants` / `getTenant` / `updateTenant` / `deleteTenant` | Standard CRUD. `deleteTenant` **purges ALL tenant-scoped data** (`[FIX-TENANT-1]`) — Sessions, Orders, Bookings, Analytics, AuditLogs, etc. Confirm any new tenant-scoped model is added to this purge list, or deleting a tenant will leave orphaned records. |
| `updateTenantStatus` | Accepts `ACTIVE`/`SUSPENDED`/`INACTIVE`/`PENDING` (`[FIX-G]`) — must match `Tenant.status` enum exactly. |
| `verifyWhatsApp` | Credential verification against Meta (`[AUDIT-P2-C]`) — delegates to `services/metaCredentialService.js`. |
| `rotateApiKey` | Generates and stores a new `apiKeyHash` for a tenant (`[AUDIT-P2-D]`) — the OLD key stops working immediately (no grace-period overlap); communicate this to whoever's rotating keys operationally. |
| `getPlatformStats` | Cross-tenant aggregate stats — legitimately the one place cross-tenant querying without `enforceTenantScope` is correct, since it's super-admin-only. |
| **`encryptToken(plaintext)` / `decryptToken(stored)`** | **Exported and reused elsewhere** — `core/whatsapp/dispatcher.js` calls `decryptToken()` on every outbound message to decrypt `tenant.whatsapp.accessToken`. Falls back to plaintext pass-through when `ENCRYPTION_KEY` is unset (with a loud boot warning elsewhere — see `.ai/references/RAILWAY_ENV.md`) or when the stored value doesn't have the `enc:` prefix (pre-migration data). If you touch encryption, remember this function has callers outside this controller. |

## `whatsappOnboardingController.js` — connection handshake

Two audiences, explicitly isolated from the rest of the bot
(`ISOLATION` comment in the file header: "does NOT import or reference any
existing bot controller, flow engine, session service, or webhook
handler"):

**Tenant-facing** (`/api/whatsapp/*`):
- `submitConnectionRequest()` — `POST /api/whatsapp/request`
- `getTenantRequestStatus()` — `GET /api/whatsapp/request/status`

**Admin-facing** (`/admin/whatsapp/*`, super-admin key):
- `getAllConnectionRequests()` — `GET /admin/whatsapp/requests`
- `getConnectionRequestById()` — `GET /admin/whatsapp/requests/:id`
- `updateConnectionRequestStatus()` — `PATCH /admin/whatsapp/requests/:id/status`
- `saveTenantWhatsAppCredentials()` — `POST /admin/whatsapp/connect/:tenantId`
  — also advances `Tenant.onboardingStep` to 2 when credentials are saved,
  consistent with what `PATCH /admin/tenants/:id` does elsewhere; keep
  these two credential-saving paths in sync if you touch either.
- `testTenantWhatsAppConnection()` — `POST /admin/whatsapp/test/:tenantId`
  — decrypts the stored `accessToken` via `decryptToken()` before calling
  `verifyCredentials()` (a raw possibly-`enc:`-prefixed token sent straight
  to Meta previously caused a confusing 190 "invalid token" error even when
  credentials were actually valid). Rejects `SIM_`-prefixed placeholder
  `phoneNumberId`s with a clear 422 before making any real Meta call.

Backed by `services/whatsappOnboardingService.js` (business logic) and
`models/WhatsAppConnectionRequest.js`. Mounted before the broad `/admin`
catch-all in `app.js` (Rule 3 in `.ai/README.md`) — don't move this mount.
