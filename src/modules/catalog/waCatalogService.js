/**
 * modules/catalog/waCatalogService.js
 *
 * Graph API calls for WA Catalog. Message SENDING goes exclusively through
 * core/whatsapp/dispatcher.js — the documented "ISOLATED TRANSPORT ADAPTER —
 * the ONLY file that talks to Meta API" for outbound WhatsApp messages. This
 * file never calls fetch() against the /messages endpoint itself; it builds
 * a `ui` object and hands it to dispatchMessage(), exactly like every other
 * module in src/modules.
 *
 * [CATALOG-SVC-1] Product *sync* (uploading/updating items in the Meta
 * Commerce/Product Catalog) is a DIFFERENT Graph API resource than sending
 * WhatsApp messages — it hits graph.facebook.com/{catalog_id}/items_batch
 * (the Catalog Batch API), not graph.facebook.com/{phone_number_id}/messages.
 * Routing it through dispatcher.js would mean teaching a phone-number-scoped
 * message sender about an unrelated Graph resource — exactly the kind of
 * scope creep dispatcher.js's own header comment guards against ("the ONLY
 * file that talks to Meta API" refers to WhatsApp *messaging* traffic; see
 * ARCHITECTURE discrepancy note in the delivery write-up). syncMenuToCatalog()
 * below is therefore the one narrow, explicitly-documented exception, and it
 * reuses the exact same tenant-credential decrypt pattern as dispatcher.js
 * ([AUDIT-P2-A]) so there is still exactly one way tokens are decrypted
 * anywhere in this codebase.
 */

import { createHash } from 'crypto';
import logger from '../../config/logger.js';
import { decryptToken } from '../../controllers/tenantController.js';
import { dispatchMessage } from '../../core/whatsapp/dispatcher.js';
import { buildRetailerId, buildCategorizedSections, isSyncableForCatalog } from './waCatalogHelpers.js';

// [CATALOG-UX-SIZE] Above this many sellable catalog rows, an up-front
// product_list (every item visible before the first tap) turns into a wall
// of options rather than a help — a full catalog_message browse-all (Meta's
// own searchable/scrollable catalog UI, one extra tap to open) is the better
// default at that scale. Below it, showing everything up front tends to
// convert better since there's no extra tap between "here's what we sell"
// and "here's the thing I want." 30 rows is one full Meta product_list
// section — a reasonable, easy-to-reason-about cutoff for "small enough to
// show inline" that doesn't require guessing at conversion-rate data this
// codebase has no way to measure.
const INLINE_LIST_ROW_THRESHOLD = 30;

// [CATALOG-DELTA-1] Stable content hash for a single catalog line item's
// upload payload. Same `data` in → same hash out, regardless of key
// insertion order (buildItemData always builds keys in the same order, but
// JSON.stringify is used here rather than relying on that, since it's a
// one-line, dependency-free way to get a deterministic digest).
function hashItemData(data) {
  return createHash('sha1').update(JSON.stringify(data)).digest('hex');
}

/**
 * sendCatalogMessage(to, business, tenant, { productRetailerIds, sectionTitle } = {})
 *
 * Three possible outbound shapes, chosen in this order:
 *   1. Caller passed an explicit `productRetailerIds` list → curated
 *      single-section product_list (unchanged from before — a caller asking
 *      for specific products always gets exactly those products).
 *   2. No curated list, and the tenant's sellable menu fits within
 *      INLINE_LIST_ROW_THRESHOLD rows → a product_list built from
 *      buildCategorizedSections() (waCatalogHelpers.js), grouped by
 *      menuItems[].category so a tenant with distinct categories (mains/
 *      drinks/desserts, shirts/shoes/accessories) gets a categorized browse
 *      experience instead of one flat list, and the customer sees everything
 *      up front with no extra tap.
 *   3. Neither of the above (menu too large, or nothing categorizable came
 *      back) → the original full catalog_message browse-all, which opens
 *      Meta's own searchable/scrollable catalog UI in one extra tap — the
 *      right default once a tenant's catalog is too big to usefully show
 *      inline.
 * All via dispatcher.js, exactly like every other outbound message type in
 * this codebase.
 *
 * [Failure handling] Returns the dispatchMessage() result, or null if the
 * catalog isn't configured or the send failed. Callers (waCatalogFlow.js)
 * MUST treat null as "fall back to the module's normal text/list product UI"
 * — WA Catalog must never become a single point of failure for a sale.
 */
export async function sendCatalogMessage(to, business, tenant, { productRetailerIds = null, sectionTitle = 'Products' } = {}) {
  const catalogId = business?.waCatalog?.catalogId;
  if (!catalogId) {
    logger.debug('[WACatalog] sendCatalogMessage skipped — no catalogId configured', { tenantId: business?.tenantId });
    return null;
  }

  const bodyText = business?.customMessages?.orderPrompt
    || `🛍 Browse our products below — tap any item to see more.`;

  // [FIX-CATALOG-HEADER-1] Meta's Cloud API REQUIRES interactive.header on a
  // 'product_list' (multi_product) message — unlike the plain 'list' type,
  // where header is optional (see dispatcher.js line ~157 vs ~222, both of
  // which only add header when ui.header is truthy). This ui object never
  // set ui.header, so every product_list send hit Graph API 400
  // "(#131009) ... interactive['header'] is required" and dispatchMessage()
  // correctly returned null on that error — which sendAndArmCatalog()
  // (waCatalogFlow.js) then correctly treated as a failure and silently fell
  // back to the tenant's plain-text/list menu ("View Menu"), exactly as the
  // [Failure handling] contract says it should. The catalog itself was never
  // broken — every product_list send was failing before it ever reached the
  // customer, so the fallback UI was ALL any tenant with <=30 sellable items
  // (the product_list branch below) could ever see. catalog_message (the
  // >30-item branch) has no header requirement and was unaffected.
  const headerText = (business?.name || 'Our Products').slice(0, 60);

  let ui;
  if (productRetailerIds?.length) {
    // Curated list — caller (e.g. a specific promo/upsell context) asked for
    // exactly these products, so they're shown exactly as asked.
    ui = {
      type: 'product_list',
      catalogId,
      header: headerText,
      body: bodyText,
      sections: [{ title: sectionTitle.slice(0, 24), productRetailerIds: productRetailerIds.slice(0, 30) }],
    };
  } else {
    const sections = buildCategorizedSections(business);
    const totalRows = sections.reduce((n, s) => n + s.productRetailerIds.length, 0);

    ui = (totalRows > 0 && totalRows <= INLINE_LIST_ROW_THRESHOLD)
      ? { type: 'product_list', catalogId, header: headerText, body: bodyText, sections }
      : { type: 'catalog_message', catalogId, body: bodyText };
  }

  try {
    const result = await dispatchMessage(to, ui, tenant);
    return result || null;
  } catch (err) {
    // [Failure handling] Never let a Graph API hiccup surface to the customer —
    // log and let the caller fall back silently.
    logger.warn('[WACatalog] sendCatalogMessage failed — caller should fall back', {
      err: err.message, tenantId: business?.tenantId,
    });
    return null;
  }
}

/**
 * syncMenuToCatalog(business, tenant)
 * [CATALOG-SVC-1] Best-effort, optional sync of BusinessConfig.menuItems into
 * the Meta Commerce Catalog via the Catalog Batch API. Single source of truth
 * stays BusinessConfig.menuItems — this only pushes a copy outward, it never
 * reads product data back from Meta.
 *
 * [CATALOG-CRUD-1] Full CRUD against Meta's catalog:
 *   CREATE / UPDATE — Meta's Catalog Batch API `UPDATE` method is upsert
 *     semantics (creates the product if `retailer_id` doesn't exist yet in
 *     the catalog, updates it if it does) — so one `UPDATE` request per
 *     current menu item covers both "new item" and "existing item changed"
 *     without needing to track which case applies.
 *   DELETE — items that were synced last time but are no longer present in
 *     menuItems (deleted, or business.menuItems replaced wholesale via
 *     updateMenu()) get an explicit `DELETE` request, diffed against
 *     business.waCatalog.syncedRetailerIds (the snapshot written by the
 *     previous successful sync — see [CATALOG-CRUD-1] on the schema field).
 *     Without this, deleting a menu item only ever stopped updating its
 *     Meta listing — it never actually disappeared from the customer-facing
 *     catalog. That's exactly what this covers.
 *
 * [CATALOG-CRUD-2] Previously this filtered out `available === false` items
 * entirely, meaning toggling an item to unavailable silently stopped syncing
 * it rather than pushing an `out of stock` update — so its Meta listing
 * stayed stale at whatever availability it last had. Now every current item
 * is sent (in stock or out of stock); only genuinely REMOVED items are
 * excluded from the UPDATE batch (and instead go in the DELETE batch above).
 *
 * Never throws outward — a sync failure must never affect messaging or any
 * other part of the platform.
 */
// [CATALOG-HEALTH-4] Best-effort write of the failure reason so
// GET /:tenantId/wacatalog/health can distinguish "hasn't changed" from
// "has been failing" — never throws outward, mirrors the lastSyncedAt write
// pattern already used on the success path below.
async function recordSyncError(businessId, reason, detail = null) {
  try {
    const { default: BusinessConfig } = await import('../../models/BusinessConfig.js');
    await BusinessConfig.updateOne(
      { _id: businessId },
      { $set: { 'waCatalog.lastSyncError': { reason, detail, at: new Date() } } },
    );
  } catch (err) {
    logger.debug('[WACatalog] recordSyncError write failed (non-fatal)', { err: err.message });
  }
}

// [CATALOG-ASYNC-VERIFY-1] Single check_batch_request_status call for one
// handle. Never throws — a network hiccup while checking is treated the
// same as "still pending," since the handle stays in pendingBatchHandles
// and gets retried on the next sync either way.
async function checkBatchRequestStatus(handle, token, version) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp  = await fetch(
      `https://graph.facebook.com/${version}/check_batch_request_status?handle=${encodeURIComponent(handle)}`,
      { signal: ctrl.signal, headers: { Authorization: `Bearer ${token}` } },
    );
    clearTimeout(timer);
    if (!resp.ok) return { resolved: false };
    const json = await resp.json().catch(() => null);
    const entry = json?.data?.[0];
    if (!entry) return { resolved: false };
    if (entry.status === 'finished' || entry.status === 'canceled' || entry.status === 'error') {
      return {
        resolved: true,
        hasErrors: (entry.errors_total_count || 0) > 0 || entry.status !== 'finished',
        errors: entry.errors || [],
        status: entry.status,
      };
    }
    // 'dispatched' / 'started' — genuinely still in progress.
    return { resolved: false };
  } catch (err) {
    logger.debug('[WACatalog] checkBatchRequestStatus failed (non-fatal, will retry)', { err: err.message });
    return { resolved: false };
  }
}

// [CATALOG-ASYNC-VERIFY-1] Self-healing check of any handles left over from
// a PREVIOUS sync attempt that hadn't resolved yet. Called at the top of
// syncMenuToCatalog() (both the manual /wacatalog/sync route and the
// debounced autosync scheduler run through it), so a tenant's catalog
// health reflects reality within one sync cycle without needing a separate
// cron job. Never throws outward.
async function resolvePendingBatchHandles(business, token, version) {
  const pending = business?.waCatalog?.pendingBatchHandles || [];
  if (!pending.length) return;

  const stillPending = [];
  let sawError = null;

  for (const p of pending) {
    const result = await checkBatchRequestStatus(p.handle, token, version);
    if (!result.resolved) {
      stillPending.push(p);
      continue;
    }
    if (result.hasErrors) {
      const firstMsg = result.errors?.[0]?.message || `batch ${result.status}`;
      sawError = `Batch ${p.handle.slice(0, 12)}… ${result.status}: ${firstMsg}`.slice(0, 500);
    }
  }

  try {
    const { default: BusinessConfig } = await import('../../models/BusinessConfig.js');
    const update = { 'waCatalog.pendingBatchHandles': stillPending };
    if (sawError) update['waCatalog.lastSyncError'] = { reason: 'BATCH_VALIDATION_ERROR', detail: sawError, at: new Date() };
    await BusinessConfig.updateOne({ _id: business._id }, { $set: update });
  } catch (err) {
    logger.debug('[WACatalog] resolvePendingBatchHandles write failed (non-fatal)', { err: err.message });
  }
}

export async function syncMenuToCatalog(business, tenant) {
  const catalogId = business?.waCatalog?.catalogId;
  if (!catalogId) return { ok: false, reason: 'NO_CATALOG_ID' };

  const rawToken = tenant?.whatsapp?.accessToken;
  const token = decryptToken(rawToken);
  if (!token) return { ok: false, reason: 'NO_TOKEN' };

  const version = tenant?.whatsapp?.apiVersion || process.env.META_API_VERSION || 'v21.0';

  // [CATALOG-ASYNC-VERIFY-1] Reconcile any handles left unresolved from the
  // previous sync BEFORE sending new ones — self-healing, no separate cron.
  await resolvePendingBatchHandles(business, token, version).catch(() => {});

  // [CATALOG-CRUD-2] All current items, available or not — availability is
  // reflected via the `availability` field below, not by omission.
  const menu = business?.menuItems || [];

  // [AUDIT-FIX-CATALOG-VARIANT-SYNC] buildRetailerId(menuItem, variantName) and
  // resolveCatalogItem()'s variant-slug branch (waCatalogHelpers.js) were built
  // and unit-tested to resolve a variant-specific retailer_id like
  // "<menuItemId>::large" back to { item, variant: 'Large' } — but this function
  // only ever called buildRetailerId(item) with NO variantName, uploading exactly
  // one plain "<menuItemId>" entry per menu item regardless of item.variants.
  // Meta's catalog never dictates a retailer_id format; it only ever echoes back
  // IDs that were actually uploaded. So a "::variant" id could never appear in a
  // real Meta 'order' webhook payload — the entire variant-resolution branch was
  // unreachable in production even though it was fully implemented and tested.
  // Fix: an item with a non-empty `variants` array is synced as one catalog entry
  // PER VARIANT (variant-specific retailer_id, variant name folded into the
  // product name so the customer can tell them apart in Meta's catalog UI/cart),
  // instead of a single ambiguous base entry. Items with no variants keep the
  // exact same plain "<menuItemId>" entry as before — zero behavioural change
  // for every non-variant item in every tenant's catalog.
  const buildItemData = (item, variantName = null) => ({
    name: variantName ? `${item.name} - ${variantName}` : item.name,
    // [FIX-CATALOG-PRICE] Meta's Catalog Batch API expects `price` as a plain
    // decimal STRING in major currency units (e.g. "10.00"), with `currency`
    // as a separate field — see the Catalog Batch API reference examples
    // ("price": "10.00", "currency": "USD"). This previously sent
    // Math.round(price * 100) — a JS number in minor units (cents) — which
    // Meta either rejects (wrong type) or reads as a price 100x too high.
    price:        (Number(item.price) || 0).toFixed(2),
    currency:     item.currency || business?.payment?.currency || 'USD',
    availability: item.available !== false ? 'in stock' : 'out of stock',
    ...(item.description ? { description: item.description } : {}),
    ...(item.image?.url  ? { image_url:  item.image.url }   : {}),
  });

  // [CATALOG-SYNC-VALIDATE-1] Validate BEFORE building sync entries — an item
  // missing an image or with an invalid/zero price is excluded from
  // allCurrentItems entirely, which has two effects for free via the
  // existing machinery below:
  //   - it's never sent as an UPDATE (never reaches Meta broken), and
  //   - if it WAS previously synced and has since regressed (bad image URL,
  //     price cleared), it now falls out of currentRetailerIds, so the
  //     existing DELETE-diff logic automatically removes the stale/broken
  //     listing from Meta's catalog on this same sync — no separate cleanup
  //     path needed.
  // Logged (not thrown) since a sync must never fail outright over one bad
  // item; the rest of the tenant's valid catalog still syncs normally.
  const invalidSkipped = [];
  const syncableMenu = menu.filter(item => {
    const { ok, reasons } = isSyncableForCatalog(item);
    if (!ok) {
      invalidSkipped.push({ id: String(item?._id || ''), name: item?.name || '(unnamed)', reasons });
    }
    return ok;
  });
  if (invalidSkipped.length) {
    logger.warn('[WACatalog] syncMenuToCatalog skipping items that would render broken in Meta catalog', {
      tenantId: business?.tenantId, count: invalidSkipped.length, items: invalidSkipped,
    });
  }

  // [CATALOG-DELTA-1] allCurrentItems holds EVERY current entry (one per plain
  // item, one per variant) regardless of whether its content changed since the
  // last sync — this full set is what DELETE-diffing and the new hash snapshot
  // below are based on. Only the subset whose hash actually differs from last
  // time (changedItems) is sent to Meta as an UPDATE, so an edit to one item
  // no longer re-uploads the tenant's entire catalog.
  const allCurrentItems = syncableMenu.flatMap(item => {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    if (!variants.length) {
      const retailer_id = buildRetailerId(item);
      if (!retailer_id) return [];
      const data = buildItemData(item);
      return [{ retailer_id, data, hash: hashItemData(data) }];
    }
    return variants
      .map(v => (v && typeof v === 'object') ? v.name : v)
      .filter(Boolean)
      .map(variantName => {
        const retailer_id = buildRetailerId(item, variantName);
        if (!retailer_id) return null;
        const data = buildItemData(item, variantName);
        return { retailer_id, data, hash: hashItemData(data) };
      })
      .filter(Boolean);
  });

  const previousHashes = business?.waCatalog?.syncedItemHashes instanceof Map
    ? business.waCatalog.syncedItemHashes
    : new Map(Object.entries(business?.waCatalog?.syncedItemHashes || {}));

  // [CATALOG-DELTA-1] An item with no prior hash entry (new item, or a tenant
  // synced before this field existed) is always treated as changed — this is
  // self-healing rather than requiring any migration.
  const changedItems = allCurrentItems.filter(
    i => previousHashes.get(i.retailer_id) !== i.hash,
  );
  const updateRequests = changedItems.map(i => ({ method: 'UPDATE', retailer_id: i.retailer_id, data: i.data }));

  const currentRetailerIds = new Set(allCurrentItems.map(i => i.retailer_id));
  const previouslySynced = business?.waCatalog?.syncedRetailerIds || [];
  const deleteRequests = previouslySynced
    .filter(id => id && !currentRetailerIds.has(id))
    .map(retailer_id => ({ method: 'DELETE', retailer_id }));

  const requests = [...updateRequests, ...deleteRequests];
  if (!requests.length) {
    // Nothing changed and nothing to delete — skip the network call entirely.
    // (Existing hash/id snapshot is already accurate, so nothing to rewrite.)
    return { ok: true, synced: 0, deleted: 0, skipped: allCurrentItems.length, invalidSkipped: invalidSkipped.length };
  }

  const url = `https://graph.facebook.com/${version}/${catalogId}/items_batch`;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp  = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // [FIX-CATALOG-ITEM-TYPE] Meta's Catalog Batch API rejects the ENTIRE
      // batch with GRAPH_ERROR (400) unless `item_type` is present as a
      // top-level field on the request body (every documented items_batch
      // example — including the HOTEL vertical — sends it alongside
      // `requests`). This field was missing here, so every sync attempt for
      // every tenant on this codebase failed with 400 regardless of menu
      // content — the exact error surfaced on the Catalog admin page
      // ("Last error: GRAPH_ERROR (400)"). Commerce/product catalogs (as
      // opposed to HOTEL/VEHICLE/FLIGHT) use 'PRODUCT_ITEM', which matches
      // every menu item this platform uploads (see buildItemData above —
      // plain retail product fields: name/price/currency/availability/
      // image_url).
      body: JSON.stringify({ item_type: 'PRODUCT_ITEM', requests }),
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      logger.error('[WACatalog] syncMenuToCatalog failed', { status: resp.status, err: errText.slice(0, 300) });
      await recordSyncError(business._id, `GRAPH_ERROR (${resp.status})`, errText.slice(0, 500));
      return { ok: false, reason: 'GRAPH_ERROR', status: resp.status };
    }

    // [CATALOG-ASYNC-VERIFY-1] A 200 here only means Meta ACCEPTED the batch
    // for async processing — it returns `handles` to check later, not proof
    // the items are live. Give each handle one quick check (batches for a
    // small menu often resolve within a second or two); anything still
    // in-flight after that is persisted to pendingBatchHandles and picked
    // up by resolvePendingBatchHandles() on the NEXT sync, rather than this
    // function blocking indefinitely or, worse, silently reporting success
    // for a batch that hasn't actually finished.
    const acceptedJson = await resp.json().catch(() => null);
    const handles = Array.isArray(acceptedJson?.handles) ? acceptedJson.handles : [];

    await new Promise(r => setTimeout(r, 1500)); // brief grace period before the first check
    const stillPending = [];
    let batchErrorDetail = null;
    for (const handle of handles) {
      const result = await checkBatchRequestStatus(handle, token, version);
      if (!result.resolved) {
        stillPending.push({ handle, at: new Date() });
      } else if (result.hasErrors) {
        const firstMsg = result.errors?.[0]?.message || `batch ${result.status}`;
        batchErrorDetail = `Batch ${handle.slice(0, 12)}… ${result.status}: ${firstMsg}`.slice(0, 500);
      }
    }

    try {
      const { default: BusinessConfig } = await import('../../models/BusinessConfig.js');
      await BusinessConfig.updateOne(
        { _id: business._id },
        {
          $set: {
            'waCatalog.lastSyncedAt': new Date(),
            // [CATALOG-CRUD-1] Snapshot exactly what's now live in Meta's
            // catalog (i.e. the current menu's retailer_ids) so the NEXT
            // sync can correctly diff what needs deleting.
            'waCatalog.syncedRetailerIds': [...currentRetailerIds],
            // [CATALOG-DELTA-1] Snapshot every CURRENT item's hash (not just
            // the ones that changed this run) so the next sync's diff is
            // accurate for the whole catalog, not just what just changed.
            'waCatalog.syncedItemHashes': Object.fromEntries(allCurrentItems.map(i => [i.retailer_id, i.hash])),
            'waCatalog.pendingBatchHandles': stillPending,
            // A batch that came back with per-item errors is a REAL failure
            // even though the POST itself returned 200 — don't clear
            // lastSyncError in that case. Otherwise a successful sync clears
            // any stale failure flag as before.
            'waCatalog.lastSyncError': batchErrorDetail
              ? { reason: 'BATCH_VALIDATION_ERROR', detail: batchErrorDetail, at: new Date() }
              : { reason: null, detail: null, at: null },
          },
        },
      );
    } catch (err) {
      // Non-fatal — the sync itself succeeded even if this timestamp write fails.
      logger.debug('[WACatalog] lastSyncedAt write failed (non-fatal)', { err: err.message });
    }

    if (batchErrorDetail) {
      return { ok: false, reason: 'BATCH_VALIDATION_ERROR', detail: batchErrorDetail };
    }

    return { ok: true, synced: updateRequests.length, deleted: deleteRequests.length, skipped: allCurrentItems.length - updateRequests.length, invalidSkipped: invalidSkipped.length, pendingVerification: stillPending.length };
  } catch (err) {
    logger.error('[WACatalog] syncMenuToCatalog network error', { err: err.message });
    await recordSyncError(business._id, 'NETWORK_ERROR');
    return { ok: false, reason: 'NETWORK_ERROR' };
  }
}
