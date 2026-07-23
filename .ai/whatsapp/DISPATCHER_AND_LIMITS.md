# whatsapp/DISPATCHER_AND_LIMITS.md

Source: `core/whatsapp/dispatcher.js`.

**This is the only file allowed to call the Meta Graph API.** See Rule 4 in
`.ai/README.md`.

## UIResponse shapes → Meta payload (`buildPayload(to, ui)`)

| `ui.type` | Produces | Notes |
|---|---|---|
| `text` | `{ type: 'text', text: { body } }` | Default/fallback shape. |
| `buttons` | Interactive reply buttons | Max 3 buttons (`.slice(0,3)`), each id ≤256 chars, title ≤20 chars. Zero buttons → silently degrades to plain text. `footer` (≤60 chars) is valid here — was previously dropped for non-`list` types. |
| `list` | Interactive list message | See row/section cap below. |
| `catalog_message` | WA Commerce single-catalog interactive message | Requires `ui.catalogId`, else returns `null`. |
| `product_list` | WA Commerce multi-product interactive message | Requires `ui.catalogId` and ≥1 non-empty section, else `null`. See item cap below. |
| `image` | Outbound image | Requires `ui.url`, else `null`. Caption ≤1024 chars. |
| `template` | Pre-approved WhatsApp template (24h+ outbound) | Requires `ui.name`. Used by `schedulerService.js`. |

## Meta's REAL hard limits (verified against production 400 errors — do not
"fix" these back to a per-section interpretation)

- **Interactive list: 10 rows TOTAL across ALL sections combined**, not 10
  rows per section. A prior implementation assumed 10-per-section with up
  to 10 sections (100 rows) and chunked overflowing sections into
  "Category (cont.)" — that produced a hard Meta 400
  (`Total row count exceed max allowed count: 10`) for any menu/category
  list with more than 10 real entries. The current `buildPayload()`
  collects rows across sections IN ORDER and hard-caps at 10 total,
  dropping anything past row 10 (never sending a payload that would be
  rejected outright) and surfacing a footer notice
  ("Showing 10 items — type what you're looking for to see more") when
  truncated and no explicit footer was already provided.
- **`product_list` message: 30 product items TOTAL across the whole
  message**, not 30 per section. Same "per-section" misreading pattern.
  Enforced in the transport layer itself (not just in the one current
  caller, `waCatalogService.sendCatalogMessage`) so no future caller can
  trigger a 400 by combining several sections that each look fine
  individually but blow the combined ceiling.
- **Button title:** 20 chars. **Body:** 1024 chars. **Footer:** 60 chars.
  **List button label:** 20 chars. **List row title:** 24 chars. **List row
  description:** 72 chars. **Header text:** 60 chars.

If you're adding a new interactive message anywhere in the codebase, build
its `ui` object and let `dispatcher.js` enforce these caps — do not
pre-truncate in the flow handler using a different (and possibly wrong)
assumption about the limit.

## Silent-failure guards

- `buildPayload()` intentionally returns `null` for malformed payloads
  (empty list after normalisation, missing catalogId, missing image url,
  etc.) rather than sending something Meta would reject. `dispatchMessage()`
  catches this: logs loudly, and if the original `ui` had any `body`/`text`,
  falls back to sending that as a plain text message so the customer always
  gets *something* instead of the tap simply producing no reply.
- On a Meta 4xx/5xx response, `dispatchMessage()` returns `null` explicitly
  — **never** a truthy `Response` object. Callers like
  `sendCatalogMessage()` treat any truthy return as "message actually sent"
  and skip their own fallback logic; returning the raw (non-ok) `Response`
  object used to defeat that check because it's truthy even for a 4xx.
- Guards against dispatching with missing/placeholder credentials: no
  token/phoneNumberId → logged + no-op; `phoneNumberId` starting with
  `SIM_` (a simulation placeholder) → refused in live mode, logged loudly.
- 10-second `AbortController` timeout on the live Graph API call.

## Simulation mode

When `SIMULATION_MODE === 'true'` and not production, `dispatchMessage()`
resolves a per-user "sim slot" (`_registerSimSlot` / `_resolveSlot`) instead
of calling Meta, so `controllers/simulateController.js` can synchronously
return the bot's reply to a `POST /api/message` test call. Image-type
messages deliberately don't resolve the slot immediately — the
quantity-prompt buttons message that follows is more useful to return.
`_resolveSimSlotIfPending()` is called by `simulateController` after
`handleIncomingMessage()` completes to avoid hanging the full 10s timeout
when no reply was ever produced (e.g. humanMode, guard bail-out).

## Credentials

`tenant.whatsapp.accessToken` is decrypted via
`tenantController.decryptToken()` before use — transparently handles both
`enc:`-prefixed encrypted tokens and legacy plaintext (pre-encryption-
migration or dev environments). API version defaults to
`tenant.whatsapp.apiVersion || META_API_VERSION env || 'v21.0'`.
