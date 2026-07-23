# references/ANALYTICS_AND_UTILS.md

## Analytics events (`core/analytics/analyticsService.js`)

`EVENT` constants → `Analytics.type` enum mapping (the schema's `type`
enum is `["ORDER", "BOOKING", "FAILED", "REVENUE"]` — narrower than the
event vocabulary, deliberately, since `type` drives dashboard aggregation
buckets):

| `EVENT.*` | Stored as `type` | Written by |
|---|---|---|
| `ORDER_PLACED` | `ORDER` | `trackOrderAnalytics()` |
| `BOOKING_MADE` | `BOOKING` | `trackBookingAnalytics()` |
| `PAYMENT_MADE` | `ORDER` (payment events counted as order events) | |
| `REVENUE` | `REVENUE` | `recordRevenue()` |
| `ABANDONED_CART` | `FAILED` | |
| `USER_MESSAGE` | `FAILED` | **Was `ORDER` before a fix** — every inbound message was inflating order-analytics counts even though no order occurred. If you add a new `EVENT`, think carefully about which bucket it actually belongs in; don't default to `ORDER` just because that's the first enum value. |
| `FAILED_INTENT` | `FAILED` | `trackFailedInteraction()` |

`track(event, data)` is the internal writer — maps event → type, strips
the legacy `timestamp` field (schema uses `timestamps: true`, which
auto-sets `createdAt`), and is itself wrapped in try/catch so an
analytics-write failure is never allowed to break the customer-facing
response (`logger.debug`, not `error` — analytics failures are
non-critical by design).

**If you add a new event type**, add it to `EVENT`, add its
`EVENT_TO_TYPE` mapping, and confirm the mapping is one of the 4 real
schema enum values — don't invent a 5th `type` value without also adding
it to `models/Analytics.js`'s schema (Rule 2 in `.ai/README.md`).

## Fuzzy matching (`utils/matchEngine.js`)

`findBestMatch(items, query)` — used for menu/catalog item resolution from
free-text customer input (e.g. matching "burger" or a slight misspelling
against `business.menuItems`). Combines:
- **Exact match** (normalised) → instant `HIGH`, score `1`.
- **Substring match** (either direction) → `HIGH`, score `0.85`–`1.0`
  weighted by length-ratio closeness.
- Otherwise: `trigramSimilarity * 0.6 + normalisedLevenshtein * 0.4`.

Confidence thresholds: `score >= 0.72` → `HIGH`, `score >= 0.45` → `LOW`,
else `NONE`. **Callers decide what to do with `LOW`** — the function itself
never auto-selects a low-confidence match; this mirrors the "AI never
triggers a flow directly, only suggests" principle in
`.ai/flows/INTENT_DETECTION.md`. When using this in a new flow, follow the
same pattern: `HIGH` can proceed automatically, `LOW` should prompt a "did
you mean X?" confirmation, `NONE` should fall through to a normal
browse/list UI, never a guess.

## Quantity parsing (`utils/parseQuantity.js`)

Parses customer free-text quantity replies ("2", "two", "a couple", etc.)
into a number. Used at every module's `QUANTITY` step. If you add a new
recognized quantity phrase, add it here rather than duplicating parsing
logic inside an individual module's flow handler — every vertical's
`QUANTITY` step should behave identically for the same input.

## Rate limits (`middleware/rateLimiter.js`)

All limiters are **never skipped in production**, regardless of
`SIMULATION_MODE` — only skipped in non-production + `SIMULATION_MODE=true`
(dev/test convenience). `keyGenerator` uses `X-Forwarded-For` (works
because `app.set('trust proxy', 1)` in `app.js`).

| Limiter | Window | Max | Used by |
|---|---|---|---|
| `webhookLimiter` | 60s | 600 | `/webhook` — generous because Meta sends bursts; auth here is `X-Hub-Signature-256`, not rate limiting. |
| `adminLimiter` | 60s | 30 | `/admin/*`, `/admin/tenants/*` — tight because these are authentication-sensitive. |
| `overviewLimiter` | 60s | 30 | High-frequency frontend polling endpoints (`GET /dashboard/:tenantId/overview` every ~120s, `GET /admin/sessions/:tenantId` every ~60s). Generous for one browser tab, blocks runaway loops/scrapers. |
| `catalogSyncLimiter` | 60s | 5 | `POST /:tenantId/wacatalog/sync` — each call hits Meta's Graph API batch endpoint; kept tight regardless of the tenant's other limits. |
| `humanModeLimiter` | 60s | 5 | `PATCH /:tenantId/conversations/:phone/human` — extra-strict because rapid toggling could expose the bot to a customer mid-human-mode. |
| `createRateLimiter(maxPerMinute)` | 60s | caller-specified | Generic factory — `/business` and `/dashboard` use 120/min, `/api` (simulation) uses 300/min. |

**If you add a new endpoint that's either security-sensitive (admin-tier)
or hits an external API with its own rate limits (like Meta's Graph API),
give it its own dedicated limiter rather than reusing a generic one** — the
existing limiters are deliberately tuned per-endpoint-class, not uniform.
