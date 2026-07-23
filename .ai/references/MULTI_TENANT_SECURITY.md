# references/MULTI_TENANT_SECURITY.md

This is a multi-tenant platform — every request must be scoped to exactly
one tenant's data, with no path for tenant A to read or write tenant B's
records. This doc covers the actual enforcement mechanism. Read this before
adding any new route or query that touches tenant-scoped data
(`BusinessConfig`, `Order`, `Booking`, `Session`, `AuditLog`, `Analytics`,
etc. — anything with a `tenantId` field).

## Auth → tenant identity (`middleware/authMiddleware.js`)

`requireApiKey(req, res, next)`:
1. Reads `x-api-key` header.
2. Constant-time-compares against `SUPER_ADMIN_API_KEY` — match →
   `req.isSuperAdmin = true`, no tenant restriction, `next()`.
3. Otherwise SHA-256-hashes the key and looks it up against
   `Tenant.apiKeyHash`. A tenant with status `ACTIVE`, `PENDING`, or
   `INACTIVE` matches (not `SUSPENDED`) — sets `req.tenant`, `req.tenantId`,
   `req.isSuperAdmin = false`.
4. No match on either → `401`.

**Why PENDING/INACTIVE are allowed here:** a freshly created tenant starts
`PENDING` and needs their API key to authenticate to `/business` and
`/dashboard` in order to configure their account and reach `ACTIVE` at all
— restricting auth to `ACTIVE` only would be a deadlock. Status-based
access restriction belongs in **individual route handlers** (e.g. the
webhook only dispatches bot replies for `ACTIVE` tenants), not at this
layer. `SUSPENDED` is the one status blocked even here, since it represents
an explicit admin disable action.

`safeCompare()` uses `crypto.timingSafeEqual` with both buffers padded to
the same max length — a naive `padEnd(64)` comparison previously crashed
for keys longer than 64 chars (`ERR_CRYPTO_TIMINGSAFE_UNEQUAL_BUFFERS`) and
would otherwise be a timing side-channel if implemented naively.

`requireSuperAdminKey` — only the master key passes; used for
`/admin/tenants/*` (see Rule 3 in `.ai/README.md` re: mount order).

## Cross-tenant isolation (`enforceTenantScope`)

**This is the actual tenant-boundary enforcement, and it is defined
separately in each router file** (`routes/businessRoutes.js`,
`routes/dashboardRoutes.js`, `routes/adminUserRoutes.js`) rather than as a
single shared middleware module. If you add a new tenant-scoped router,
you must add your own copy of this function (or extract a shared one — see
"Suggested improvement" below) — there is currently no automatic
protection for a new route file that forgets to call it.

```js
function enforceTenantScope(req, res, next) {
  if (req.isSuperAdmin) return next();                  // super-admin bypasses
  if (!req.tenantId) return res.status(401)...;          // must be authenticated as a tenant
  if (req.tenant?.status === 'SUSPENDED') return res.status(403)...;
  if (req.params.tenantId && req.params.tenantId !== req.tenantId) {
    return res.status(403).json({ error: "Forbidden — cannot access another tenant's data" });
  }
  next();
}
```

**The core check:** `req.params.tenantId !== req.tenantId` — a tenant
authenticated with their own API key can only ever hit `:tenantId` routes
matching their own ID. Super-admins bypass this (they're allowed
cross-tenant access by design, via `/admin/tenants` and the broad
`/admin` mount).

**Every route under `/business/:tenantId/*` and `/dashboard/:tenantId/*`
must have `enforceTenantScope` in its middleware chain, positioned AFTER
`requireApiKey`** (mounted at the router level in `app.js` — see
`.ai/ARCHITECTURE.md`'s "Route mount order"). Grep any new route file for
every `:tenantId`-containing path and confirm `enforceTenantScope` is
present before assuming a new endpoint is safe.

## Where tenant scoping is enforced at the DATA layer

Beyond the route-level `enforceTenantScope` check, every tenant-scoped
Mongoose query throughout `services/`, `controllers/`, and flow handlers
must filter on `tenantId` explicitly — there's no automatic global
tenant-scoping plugin. When writing a new query against `Order`, `Booking`,
`Session`, `BusinessConfig`, etc., always include `tenantId` in the filter,
even if you've already validated the request at the route level — defense
in depth, and this is also what makes internal service functions (like
`activeOrderResolver.js`, callable from multiple contexts) safe to reuse
without re-deriving tenant identity from the request each time.

`core/sessions/sessionService.js`'s composite key
(`sessionKey(customerPhone, tenantId) = "${customerPhone}_${tenantId}"`)
plus an explicit `tenantId` filter on every session query is a deliberate
belt-and-suspenders approach — the composite key alone would already
prevent cross-tenant collision in virtually all cases, but the explicit
filter guards against the edge case of a phone number containing an
underscore.

## Webhook-side tenant resolution

Inbound WhatsApp messages don't carry an API key — tenant identity is
resolved from Meta's `phoneNumberId` in the webhook payload (matched
against `Tenant.whatsapp.phoneNumberId` / `BusinessConfig.phoneNumberId`).
Webhook signature verification (`middleware/webhookSignature.js`
`verifyMetaSignature`) additionally validates the HMAC using the resolved
tenant's own `webhookSecret`/`meta.appSecret` — see
`_verifyTenantWebhookSignature()` in `webhookController.js`.

## Suggested improvement (flagged, not yet done)

`enforceTenantScope` is currently duplicated across at least 3 route
files. Extracting it into `middleware/authMiddleware.js` (or a new
`middleware/tenantScope.js`) as a single shared export would remove the
risk of the three copies silently drifting apart, and would make it
impossible for a future route file to simply forget to define it. If you
touch tenant-scope enforcement, consider doing this consolidation as a
dedicated, isolated refactor (see `.ai/prompts/SAFE_REFACTOR.md`) rather
than as a side effect of an unrelated change.
