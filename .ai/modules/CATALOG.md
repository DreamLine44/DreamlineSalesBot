# modules/CATALOG.md

Source: `modules/catalog/{waCatalogConfig,waCatalogFlow,waCatalogService,
waCatalogHelpers,waCatalogSyncScheduler}.js`.

## What this is

Integration with Meta's **WhatsApp Commerce Catalog** (WA Catalog) —
letting a tenant's WhatsApp storefront show Meta's native product-browsing
UI (catalog cards, native "Add to cart"/checkout) instead of the bot's own
text/list menu. **Opt-in per tenant** and additive — a tenant who never
enables it gets zero behavioral change; every entry point falls straight
through to the tenant's normal, always-working ORDER flow.

Naming convention: always "WA Catalog" / "Commerce Catalog" / "WhatsApp
Catalog" in code/comments — never bare "catalog," which the codebase
already uses for `BusinessConfig.menuItems` product matching
(`utils/matchEngine.js` `findBestMatch()`). Don't conflate the two.

## Config & gating (`waCatalogConfig.js`)

- `WA_CATALOG_MODES`: `AI_DECIDES` (default) | `ALWAYS_OFFER` | `MANUAL_ONLY`.
- `isCatalogEnabled(business)` — **true only when** `waCatalog.enabled &&
  waCatalog.catalogId && waCatalog.lastSyncedAt &&
  waCatalog.syncedRetailerIds.length > 0`. Deliberately requires proof of a
  successful sync, not just `enabled:true` + a pasted `catalogId` — a
  tenant who toggled the flag and pasted a catalog ID during onboarding but
  never ran a successful sync (or whose sync failed) must NOT be treated as
  catalog-ready. Meta's Send API doesn't validate `retailer_id` existence
  synchronously, so sending against an unsynced catalog can return `200 OK`
  while the customer sees a broken/empty card — a silent failure that
  bypasses every other "fall back gracefully" guard in this integration.
- `hasSellableProducts(business)` — mirrors the `available !== false` filter
  every module already applies before building its own product UI.
- `shouldOfferCatalog({ business, intent })` — the single decision point for
  whether a `START_ORDER`-routed message should open with WA Catalog.
  `BROWSE_INTENTS = {'ORDER','ADD_TO_CART'}` for `AI_DECIDES` mode — reuses
  intent values the platform already classifies via
  `core/intents/intentEngine.js`; no new keyword list or AI category was
  added for this. Deliberately excludes `CHECKOUT` (customer already
  committed to paying — don't step them backwards into browsing) and
  `REMOVE_FROM_CART` (cart management, not a fresh browse).
- `shouldShowCatalogButton(business)` — the trigger behind the explicit
  "🛍 Browse Catalog" welcome button, shown for ANY enabled+synced tenant
  regardless of mode (including `MANUAL_ONLY`, whose only trigger this is —
  `MANUAL_ONLY` tenants never get an automatic offer via
  `shouldOfferCatalog`).
- `withCatalogWelcomeOption(buttons, business)` — merges the Browse Catalog
  option into a module's welcome buttons. Since every module's
  `welcomeButtons` already fills all 3 of Meta's button slots, this
  correctly upgrades to a `list`-type UIResponse (`rows` instead of
  `buttons`) rather than silently overflowing a 4th button off the end —
  see the 3-button cap note in `.ai/modules/BUSINESS_MODULES.md`. Button
  IDs are identical either way.

## Flow (`waCatalogFlow.js`)

- `offerCatalogOnStartOrder({ session, business, tenant, intent })` — called
  from the `START_ORDER` action handler in `moduleRegistry.js` (PATH B, only
  reached when `isCatalogEnabled && hasSellableProducts`). Runs
  `shouldOfferCatalog()`; if true, dispatches the catalog message directly
  and returns `{ offered: true }` (caller returns `null` — message already
  sent). If false or on any failure, returns `{ offered: false }` and the
  caller falls back to the normal `startFlow('ORDER')` — WA Catalog can
  never become a dead end.
- `browseCatalogExplicit({ session, business, tenant })` — the
  `BROWSE_CATALOG` action's handler (explicit customer tap, independent of
  `shouldOfferCatalog`'s automatic-offer logic).
- `handleCatalogOrderMessage({ session, business, tenant, catalogOrder })` —
  handles Meta's native `type: 'order'` webhook message (the customer
  completed WhatsApp's native cart/checkout UI). Intercepted at pipeline
  step 4.6 in `webhookController.js`, **before** anything else sees the
  message — this message type does not go through normal intent detection.
- `drainCatalogQueue({ session, business, tenant })` — processes
  `session.data.pendingCatalogQueue`, the queued cart built while the
  customer was browsing the native catalog UI, converting it into real
  `Order` document(s) via the normal order-creation path
  (`services/orderService.js`). Must be called from every code path that
  can produce a non-empty `pendingCatalogQueue` — if a new entry point into
  the catalog flow is added, confirm it still reaches `drainCatalogQueue()`
  or cart items will accumulate in the session without ever becoming a real
  order.

## Service layer (`waCatalogService.js`)

- `sendCatalogMessage(to, business, tenant, { productRetailerIds, sectionTitle })`
  — builds and dispatches either a `catalog_message` (whole-catalog card) or
  a `product_list` (curated subset) UIResponse via `dispatchMessage()`.
  Self-limits to Meta's 30-total-product-items cap before choosing
  `product_list` — see `.ai/whatsapp/DISPATCHER_AND_LIMITS.md` for why this
  cap is ALSO enforced independently inside `dispatcher.js` itself (defense
  in depth against the same "per-section vs. total" miscounting bug class
  that caused the list-row 400s).
- `syncMenuToCatalog(business, tenant)` — pushes `business.menuItems` to
  Meta's Catalog Batch API. Price format must be an **integer in cents**,
  not a decimal string (a real bug: Meta's Batch API silently accepted the
  wrong format and priced items incorrectly). Items with `available: false`
  are marked out-of-stock on Meta, not filtered out of the sync entirely —
  removing them from Meta's catalog and re-adding them later is slower and
  loses Meta-side metadata; marking out-of-stock is reversible instantly.

## Sync scheduling (`waCatalogSyncScheduler.js`)

`scheduleWaCatalogSync(tenantId)` / `clearAllScheduledSyncs()` /
`hasScheduledSync(tenantId)` — debounced background re-sync triggered on
menu mutations (add/edit/delete menu item, price change, availability
toggle) so Meta's catalog doesn't drift from `BusinessConfig.menuItems`.
If you add a new menu-mutation code path (e.g. a bulk-import endpoint),
confirm it also calls into this scheduler — a menu mutation that doesn't
trigger a re-sync is a silent-drift bug, exactly the kind this codebase's
audits specifically hunt for.

## Schema fields this integration depends on

`BusinessConfig.waCatalog` (`enabled`, `catalogId`, `mode`, `lastSyncedAt`,
`lastSyncError`, `syncedRetailerIds`) and, per session,
`session.data.pendingCatalogQueue` / `session.data.multiItemCart` — **all
of these must be declared in their respective Mongoose schemas** (Rule 1 in
`.ai/README.md`). This exact field class was the site of a real, repeated
"built but never wired" bug: the flow functions were fully implemented and
referenced these fields throughout, but the fields were absent from
`BusinessConfig.js`'s schema, so Mongoose strict mode silently discarded
every write to them.
