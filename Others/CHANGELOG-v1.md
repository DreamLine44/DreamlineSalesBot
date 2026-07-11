# WhatSales Backend — v1

This build merges the two most recent branches:
- `whatsales-backend-v42-CATALOG-CART-1` (adds multi-item WA Catalog cart consolidation)
- `whatsales-backend-MERGED-audited` (prior audited baseline, pre-CATALOG-CART-1)

Per the project's version history (v36 → v38 → v39 → v40 → v41 → v42 merges),
this merged-and-audited result is renamed **v1** — the start of a new naming
sequence going forward.

## Merge resolution
The two source trees were identical except:
- `src/modules/catalog/waCatalogFlow.js` and `waCatalogHelpers.js` — v42's
  versions were kept (superset: adds `handleMultiItemCatalogOrder()` /
  `buildCatalogCartItems()` for the multi-item cart feature; the audited
  branch was missing this feature entirely).
- `src/tests/waCatalogCartConsolidation.test.mjs` — only present in v42; kept.

## Bugs found and fixed in this audit

1. **`Order.items[].menuItemId` silently dropped by Mongoose strict mode**
   (`src/models/Order.js`). Every cart-line builder
   (`waCatalogHelpers.buildCatalogCartItems()`, and the `menuItemId` every
   per-vertical `orderFlow.js` already passes for CATALOG-STOCK-1) produces a
   `menuItemId` field, but the `items[]` subdocument schema never declared
   it — so it was never persisted to Mongo. Currently masked because
   `orderService.saveOrder()`'s stock-decrement path reads `menuItemId` off
   the raw input before saving, not off the saved document — but any future
   reader (dashboard order detail, repeat-order-by-line, analytics) would
   silently get `undefined`. Same recurring bug class as
   `variants`/`customerName`/`notes`/`addOns`/`staff` earlier in this
   codebase's history. **Fixed**: field now declared on the schema.
   Verified with a direct Mongoose cast test (not just source matching).

2. **Missing sync-time validation in `syncMenuToCatalog()`**
   (`src/modules/catalog/waCatalogService.js`) — a menu item with no image or
   an invalid/zero price could be pushed straight to Meta's Commerce
   Catalog, rendering as a broken listing (no photo, missing/$0 price) in
   front of real customers. Added `isSyncableForCatalog(item)` (pure, in
   `waCatalogHelpers.js`) and filtered the menu through it before building
   sync entries. A previously-synced item that regresses into invalid falls
   out of `currentRetailerIds` automatically, so the existing DELETE-diff
   logic removes the stale/broken listing from Meta on the same sync — no
   separate cleanup path needed. Skips are logged (never thrown), and the
   result object now reports `invalidSkipped` count.

3. **Consolidated cash catalog orders bypassed the admin-confirmation workflow entirely**
   (`src/modules/catalog/waCatalogFlow.js`, `handleMultiItemCatalogOrder()`). Every
   per-vertical `orderFlow.js`'s own "payment not enabled" branch (restaurant,
   bakery, etc.) parks the session at `AWAIT_ADMIN_CONFIRM` and sends the admin
   an interactive `APPROVE_<shortId>`/`REJECT_<shortId>` card — this is how the
   whole order lifecycle (webhookController's AWAIT_ADMIN_CONFIRM guard, the
   PENDING ORDER LOCK, `adminCommandService.confirmPayment()`/`rejectPayment()`)
   actually gets engaged. The new multi-item WA Catalog cart order, when no
   payment was configured, instead cleared the session immediately and sent
   only a plain-text admin notice with no buttons — meaning: the customer could
   start a second order before the first was ever confirmed, and the admin had
   no one-tap way to approve or reject it at all (only a manually-typed
   command). **Fixed**: the cash branch now parks at `AWAIT_ADMIN_CONFIRM` and
   sends the same `APPROVE_`/`REJECT_` card every other module sends — both
   admin-side handlers are already fully generic (keyed off `shortId`, reading
   `session.step === 'AWAIT_ADMIN_CONFIRM'`), so no changes were needed there.
   The payment-required branch was already correct (unchanged).

## Test suite
All 335 tests pass (`node --test src/tests/`), including 11 new tests added
for the three fixes above. `package.json` was added (none was present in
either source zip) with the minimal runtime dependencies actually imported
by the codebase (mongoose, express, express-rate-limit, cors, dotenv,
helmet, multer, cloudinary, fast-levenshtein).
