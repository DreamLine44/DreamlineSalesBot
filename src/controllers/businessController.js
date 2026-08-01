/**
 * controllers/businessController.js — WhatSalesAgent2
 *
 * [FIX-BIZ-1] All handlers now wrapped in try/catch — previously updateBusinessConfig,
 *             addMenuItem, and deleteMenuItem had no error handling; any DB or validation
 *             error threw an unhandled exception that crashed the response with a raw
 *             Mongoose stack trace instead of a clean 500 JSON response.
 * [FIX-BIZ-2] deleteMenuItem now matches by _id (not name) to be consistent with the
 *             dashboard CRUD and avoid accidental deletion of same-named items.
 *             The old route was DELETE /:tenantId/menu/:itemName — replaced with
 *             DELETE /:tenantId/menu/:itemId for precision.
 * [FIX-BIZ-3] updateBusinessConfig now strips protected fields (_id, tenantId, __v)
 *             AND rejects a completely empty body with a 400 instead of silently
 *             no-opping.
 * [AUDIT-FIX-17] getBusinessConfig now also returns a `tenantStatus` block sourced
 *             from req.tenant (attached by requireApiKey — see authMiddleware.js).
 *             Previously this endpoint ONLY returned the BusinessConfig document,
 *             which has no status/onboardingStep/whatsapp.connected fields — those
 *             live exclusively on the Tenant document, which no tenant-accessible
 *             route ever returned. The tenant dashboard was forced to *guess* setup
 *             progress from BusinessConfig.phoneNumberId alone (see frontend
 *             AuthContext.buildUserFromResponse), so an admin-onboarded tenant could
 *             never actually reach "Bot Activated" client-side even after the admin
 *             fully activated it server-side.
 *             req.tenant comes from a `.lean()` query, so Mongoose's toJSON
 *             transform (which strips accessToken/verifyToken/webhookSecret/
 *             apiKeyHash/meta.appSecret) does NOT run on it automatically — do not
 *             spread req.tenant directly into a response. Build tenantStatus as an
 *             explicit whitelist instead.
 */
import BusinessConfig from '../models/BusinessConfig.js';
import { getModeConfig, getSupportedModes } from '../config/modes.js';
import logger from '../config/logger.js';
import { uploadMenuImage, deleteMenuImage, CLOUDINARY_ENABLED } from '../config/cloudinary.js';
import { scheduleWaCatalogSync } from '../modules/catalog/waCatalogSyncScheduler.js';

// [AUDIT-FIX-17] Explicit whitelist — req.tenant is a lean object (no toJSON
// stripping), so never spread it wholesale into a tenant-facing response.
function safeTenantStatus(tenant) {
  if (!tenant) return null;
  return {
    status:         tenant.status,
    onboardingStep: tenant.onboardingStep,
    plan:           tenant.plan,
    whatsapp: {
      connected:      !!tenant.whatsapp?.connected,
      phone:          tenant.whatsapp?.phone || null,
      phoneNumberId:  tenant.whatsapp?.phoneNumberId || null,
      wabaId:         tenant.whatsapp?.wabaId || null,
      connectedAt:    tenant.whatsapp?.connectedAt || null,
      lastVerifiedAt: tenant.whatsapp?.lastVerifiedAt || null,
      // accessToken / verifyToken / webhookSecret intentionally omitted
    },
  };
}

export async function getBusinessConfig(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId }).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    // [AUDIT-FIX-17] Super-admin callers hit this route with req.params.tenantId
    // but no req.tenant (that's only set for tenant-key auth) — tenantStatus will
    // be null in that case, which is fine; the admin UI reads /admin/tenants/:id.
    res.json({ business: biz, tenantStatus: safeTenantStatus(req.tenant) });
  } catch (err) {
    logger.error('[Business] getBusinessConfig failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateBusinessConfig(req, res) {
  try {
    const { tenantId } = req.params;
    const update = { ...req.body };

    // [FIX-BIZ-1,3] Strip immutable fields and validate body
    delete update._id;
    delete update.tenantId;
    delete update.__v;
    // [FIX-BIZ-4] Strip phoneNumberId — it is the webhook routing key and must only
    // be changed via PATCH /admin/tenants/:id which syncs both Tenant and BusinessConfig
    // atomically. Allowing it to be overwritten here creates a split-brain where
    // Tenant.whatsapp.phoneNumberId and BusinessConfig.phoneNumberId diverge and
    // business-config lookups return stale data after the next credential update.
    delete update.phoneNumberId;

    // [FIX-MENU-ALIAS] Accept "menu" as an alias for "menuItems".
    // The API doc and Bruno collection use "menuItems", but a natural body key is "menu".
    // Mongoose strict mode silently drops "menu" since the schema field is "menuItems" —
    // the PUT appears to succeed (200 OK) but menuItems stays empty in the DB.
    if (update.menu !== undefined && update.menuItems === undefined) {
      update.menuItems = update.menu;
    }
    delete update.menu;

    // Same alias for services/faq common alternate key names
    if (update.servicesList !== undefined && update.services === undefined) {
      update.services = update.servicesList;
      delete update.servicesList;
    }

    if (!update || Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Request body is empty — nothing to update' });
    }

    // [FIX-TONE-3] findOneAndUpdate bypasses Mongoose pre('save') hooks, so the
    // tone-sync logic in businessConfigSchema.pre('save') never runs on update paths.
    // When businessMode is changing, compute and inline the tone fields here so they
    // stay consistent without requiring a separate save() round-trip.
    if (update.businessMode) {
      const toneMap = {
        RESTAURANT:  { style: 'FRIENDLY',     industry: 'RESTAURANT'  },
        BAKERY:      { style: 'FRIENDLY',     industry: 'BAKERY'      },
        RETAIL:      { style: 'PROFESSIONAL', industry: 'RETAIL'      },
        FASHION:     { style: 'PREMIUM',      industry: 'FASHION'     },
        ELECTRONICS: { style: 'PROFESSIONAL', industry: 'ELECTRONICS' },
        SALON:       { style: 'PROFESSIONAL', industry: 'SALON'       },
        BARBERSHOP:  { style: 'FRIENDLY',     industry: 'BARBERSHOP'  },
        COSMETICS:   { style: 'PREMIUM',      industry: 'COSMETICS'   },
        DELIVERY:    { style: 'FRIENDLY',     industry: 'DELIVERY'    },
        SERVICES:    { style: 'PROFESSIONAL', industry: 'SERVICES'    },
        GENERAL:     { style: 'FRIENDLY',     industry: 'GENERAL'     },
      };
      const t = toneMap[update.businessMode.toUpperCase()];
      if (t) {
        update['tone.style']    = t.style;
        update['tone.industry'] = t.industry;
      }
    }

    // [CATALOG-BIZ-1] MongoDB's $set on a plain (non-dot-path) nested field
    // REPLACES the whole subdocument rather than merging it — Mongoose doesn't
    // expand sibling fields or reapply schema defaults on an update-path $set.
    // Since this generic PUT is the only way tenants configure WA Catalog,
    // sending { waCatalog: { catalogId: 'X' } } to add a catalog ID would
    // silently wipe an already-set enabled/mode, and vice versa. Flatten to
    // waCatalog.<key> dot-notation so each sub-field updates independently,
    // mirroring the pre-existing [FIX-TONE-3] pattern above.
    if (update.waCatalog && typeof update.waCatalog === 'object') {
      for (const [k, v] of Object.entries(update.waCatalog)) {
        update[`waCatalog.${k}`] = v;
      }
      delete update.waCatalog;
    }

    // [FIX-MULTIITEMCART-BIZ-1] Same $set-replaces-whole-subdocument hazard
    // as [CATALOG-BIZ-1] above applies to multiItemCart and settings — flatten
    // both to dot-notation so a partial payload from any future caller can't
    // wipe sibling fields it didn't intend to touch. PreferencesPage.jsx
    // currently always sends the full object for each, so this is
    // defense-in-depth rather than a fix for an active symptom.
    for (const key of ['multiItemCart', 'settings']) {
      if (update[key] && typeof update[key] === 'object') {
        for (const [k, v] of Object.entries(update[key])) {
          update[`${key}.${k}`] = v;
        }
        delete update[key];
      }
    }

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $set: update },
      { new: true, upsert: false, runValidators: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    // [CATALOG-AUTOSYNC-1] Only worth scheduling a sync if the menu itself
    // changed — every other BusinessConfig edit (hours, tone, payment, etc.)
    // has no effect on what's listed in the Meta Commerce Catalog.
    if (update.menuItems !== undefined) scheduleWaCatalogSync(tenantId);
    res.json({ business: biz });
  } catch (err) {
    logger.error('[Business] updateBusinessConfig failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function getMenu(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId }).select('menuItems services').lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ menuItems: biz.menuItems || [], services: biz.services || [] });
  } catch (err) {
    logger.error('[Business] getMenu failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function updateMenu(req, res) {
  try {
    const { tenantId } = req.params;
    // [FIX-MENU-ALIAS] Accept "menu" as alias for "menuItems"
    const menuItems = req.body.menuItems ?? req.body.menu;
    if (!Array.isArray(menuItems)) {
      return res.status(400).json({ error: 'menuItems (or menu) must be an array' });
    }
    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $set: { menuItems } },
      { new: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    scheduleWaCatalogSync(tenantId);
    res.json({ menuItems: biz.menuItems });
  } catch (err) {
    logger.error('[Business] updateMenu failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function addMenuItem(req, res) {
  try {
    const { tenantId } = req.params;
    const {
      name, price, description, available = true, showImageOnSelect = true,
      category = null, currency = null, duration = null, prep = null,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // ── Parse array fields (keywords, tags, variants) — arrive as strings from multipart ─
    let keywords = req.body.keywords ?? [];
    if (typeof keywords === 'string') {
      try { keywords = JSON.parse(keywords); } catch { keywords = keywords ? [keywords] : []; }
    }
    let tags = req.body.tags ?? [];
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags); } catch { tags = tags ? [tags] : []; }
    }
    // [FIX-ADDMENUITEM-FIELDS] category/stockCount/currency/duration/prep/variants
    // are all schema-supported (see menuItemSchema) and sent by MenuPage.jsx's
    // create form's "Advanced options" section, but were previously never read
    // from req.body here — silently omitted from the $push object below, not
    // even reaching Mongoose (a plain JS gap, not a strict-mode drop). A tenant
    // filling out variants/stock/duration/etc. on item CREATION had all of it
    // discarded; only the edit path (separate handler) may have honored them.
    let variants = req.body.variants ?? [];
    if (typeof variants === 'string') {
      try { variants = JSON.parse(variants); } catch { variants = variants ? [variants] : []; }
    }
    const stockCountRaw = req.body.stockCount;
    const stockCount = (stockCountRaw === undefined || stockCountRaw === null || stockCountRaw === '')
      ? null : Number(stockCountRaw);

    // ── Cloudinary image upload (optional) ────────────────────────────────────
    let image = { url: null, public_id: null };
    if (req.file) {
      if (!CLOUDINARY_ENABLED) {
        return res.status(503).json({ error: 'Image uploads are not configured on this server.' });
      }
      try {
        const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        image = await uploadMenuImage(dataUri, { tenantId });
        logger.info('[Business] Menu image uploaded', { tenantId, public_id: image.public_id });
      } catch (uploadErr) {
        logger.error('[Business] Cloudinary upload failed', { err: uploadErr.message });
        return res.status(502).json({ error: `Image upload failed: ${uploadErr.message}` });
      }
    }

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      {
        $push: {
          menuItems: {
            name:             name.trim(),
            price:            Number(price) || 0,
            description,
            available:        available === 'false' ? false : Boolean(available),
            keywords,
            tags,
            variants,
            category:   typeof category === 'string' ? (category.trim() || null) : category,
            currency:   typeof currency === 'string' ? (currency.trim() || null) : currency,
            duration:   (duration === '' || duration === null || duration === undefined) ? null : Number(duration),
            prep:       typeof prep === 'string' ? (prep.trim() || null) : prep,
            stockCount,
            showImageOnSelect: showImageOnSelect === 'false' ? false : Boolean(showImageOnSelect),
            image,
          },
        },
      },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
    scheduleWaCatalogSync(tenantId);
    res.status(201).json({ menuItems: biz.menuItems });
  } catch (err) {
    logger.error('[Business] addMenuItem failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// [FIX-BIZ-2] Match by _id (not name) — precise, safe, consistent with dashboard CRUD
// [FIX #13]  Kept in sync with dashboardController.deleteMenuItem: both now check
//            modifiedCount so callers can detect a stale/wrong itemId.
// [FIX-BIZ-4] Cloudinary cleanup on delete — previously orphaned assets on Cloudinary
//             when a menu item with an image was deleted via this route.
export async function deleteMenuItem(req, res) {
  try {
    const { tenantId, itemId } = req.params;

    // Fetch image public_id BEFORE deleting so we can clean up Cloudinary
    const existing = await BusinessConfig.findOne(
      { tenantId, 'menuItems._id': itemId },
      { 'menuItems.$': 1 },
    ).lean();
    const imagePublicId = existing?.menuItems?.[0]?.image?.public_id;

    const result = await BusinessConfig.updateOne(
      { tenantId },
      { $pull: { menuItems: { _id: itemId } } },
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Business not found' });
    if (result.modifiedCount === 0) return res.status(404).json({ error: 'Menu item not found' });

    // Clean up Cloudinary asset (non-fatal — item is already removed from DB)
    if (imagePublicId) await deleteMenuImage(imagePublicId);

    scheduleWaCatalogSync(tenantId);
    res.json({ ok: true });
  } catch (err) {
    logger.error('[Business] deleteMenuItem failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// [CATALOG-SYNC-ROUTE-1] Wires the previously-unused
// waCatalogService.syncMenuToCatalog() to a real endpoint. Before this,
// syncMenuToCatalog() was fully written and unit-tested but had zero callers
// anywhere in the app — a tenant had no way to push menuItems into their Meta
// Commerce Catalog short of calling the function manually from a Node console.
export async function syncWaCatalog(req, res) {
  try {
    const { tenantId } = req.params;

    const business = await BusinessConfig.findOne({ tenantId }).lean();
    if (!business) return res.status(404).json({ error: 'Not found' });

    // [FIX-CATALOG-UNSYNCED] Deliberately checks only enabled+catalogId here,
    // NOT the full isCatalogEnabled() bar — that function now also requires
    // a completed sync (lastSyncedAt + syncedRetailerIds), which this
    // endpoint's whole job is to produce. Reusing isCatalogEnabled() here
    // would make a tenant's very first sync unreachable: 400 forever because
    // no sync has ever succeeded yet. This check MUST run before the Tenant
    // document is fetched: a misconfigured tenant gets a clear 400, not an
    // unnecessary DB round-trip followed by a confusing downstream Graph API
    // failure.
    if (!business.waCatalog?.enabled || !business.waCatalog?.catalogId) {
      return res.status(400).json({ error: 'WA Catalog is not enabled or has no catalogId configured for this tenant.' });
    }

    // .lean() is required here — Tenant's toJSON transform strips
    // accessToken, and syncMenuToCatalog() needs the raw encrypted token to
    // decrypt and call the Graph API, exactly as dashboardController's
    // loadTenant() already does for the same reason.
    const { default: Tenant } = await import('../models/Tenant.js');
    const tenant = await Tenant.findById(tenantId).lean();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { syncMenuToCatalog } = await import('../modules/catalog/waCatalogService.js');
    const result = await syncMenuToCatalog(business, tenant);

    if (!result.ok) {
      // NO_TOKEN/NO_CATALOG_ID are caller-fixable configuration gaps (400);
      // anything else (GRAPH_ERROR, NETWORK_ERROR) is an upstream failure (502).
      const status = result.reason === 'NO_TOKEN' || result.reason === 'NO_CATALOG_ID' ? 400 : 502;
      return res.status(status).json({ error: result.reason || 'Sync failed', detail: result.detail || undefined });
    }

    // [AUDIT-FIX-CATALOG-INVISIBLE-SKIPS] syncMenuToCatalog() validates every
    // item BEFORE syncing (isSyncableForCatalog — waCatalogHelpers.js) and
    // silently excludes anything missing an image or with an invalid/zero
    // price, logging the count + reasons server-side. That count was computed
    // but never returned to the caller — a tenant whose whole catalog was
    // skipped for "missing_image" saw `{ ok: true, synced: 0 }` with zero
    // indication of why nothing showed up on WhatsApp. Now surfaced.
    res.json({
      ok: true,
      synced: result.synced,
      deleted: result.deleted || 0,
      skippedInvalid: result.invalidSkipped || 0,
    });
  } catch (err) {
    logger.error('[Business] syncWaCatalog failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /:tenantId/wacatalog/health
 *
 * [AUDIT-FIX-CATALOG-HEALTH] waCatalogService.js's syncMenuToCatalog() has
 * written `waCatalog.lastSyncError` / `waCatalog.lastSyncedAt` since
 * [CATALOG-HEALTH-4], with a comment saying this exact endpoint would read
 * them — but the endpoint was never actually added to any route file. That
 * left admins with genuinely zero way to see WHY a tenant's catalog wasn't
 * showing products/images on WhatsApp (not enabled, no catalogId, never
 * synced, last sync failed, or synced but every item was skipped for
 * missing an image / invalid price) short of reading server logs directly.
 *
 * Read-only and side-effect-free: does NOT trigger a sync. `itemsReady` /
 * `itemsSkipped` are a live re-check of the CURRENT menu against the exact
 * same isSyncableForCatalog() gate syncMenuToCatalog() itself uses, so this
 * reflects "what would happen on the next sync," not stale data from the
 * last one.
 *
 * [FIX-CATALOG-HEALTH-ISLIVE] Before this fix, a tenant could have
 * `catalogId` set, `lastSyncedAt` set, `lastSyncError: null`, and
 * `itemsReady > 0` — every field this endpoint returned looking green —
 * and STILL fail `isCatalogEnabled()` (waCatalogConfig.js) if
 * `waCatalog.syncedRetailerIds` was empty, because that field was never
 * exposed here. That's exactly the gate every send path (shouldOfferCatalog,
 * shouldShowCatalogButton) actually checks, so the health check could show
 * "all clear" while the real answer was "not live." This endpoint now runs
 * the literal `isCatalogEnabled()` function tenants' sends are gated on
 * (not a re-derived approximation of it) and returns it as `isLive`, plus
 * `blockedBy` naming every failing precondition by key so there's no gap
 * between what this reports and what actually decides whether catalog shows.
 */
export async function getWaCatalogHealth(req, res) {
  try {
    const { tenantId } = req.params;
    const business = await BusinessConfig.findOne({ tenantId }).lean();
    if (!business) return res.status(404).json({ error: 'Not found' });

    const { isSyncableForCatalog } = await import('../modules/catalog/waCatalogHelpers.js');
    const { isCatalogEnabled, hasSellableProducts } = await import('../modules/catalog/waCatalogConfig.js');
    const menu = business.menuItems || [];
    const skipped = menu
      .map(item => ({ item, check: isSyncableForCatalog(item) }))
      .filter(({ check }) => !check.ok)
      .map(({ item, check }) => ({
        id:      String(item._id),
        name:    item.name || '(unnamed)',
        reasons: check.reasons,
      }));

    const wc = business.waCatalog || {};
    const syncedRetailerCount = Array.isArray(wc.syncedRetailerIds) ? wc.syncedRetailerIds.length : 0;

    // Named individually (not just re-run isCatalogEnabled()) so the caller
    // sees exactly which precondition(s) are failing, not just that one is.
    const blockedBy = [];
    if (!wc.enabled) blockedBy.push('not_enabled');
    if (!wc.catalogId) blockedBy.push('no_catalog_id');
    if (!wc.lastSyncedAt) blockedBy.push('never_synced');
    if (syncedRetailerCount === 0) blockedBy.push('no_synced_retailer_ids');
    if (!hasSellableProducts(business)) blockedBy.push('no_sellable_products');

    res.json({
      // The literal boolean every send path (shouldOfferCatalog,
      // shouldShowCatalogButton) actually gates on — not a re-derived copy.
      isLive:         isCatalogEnabled(business),
      blockedBy,
      enabled:        !!wc.enabled,
      catalogId:      wc.catalogId || null,
      lastSyncedAt:   wc.lastSyncedAt || null,
      lastSyncError:  wc.lastSyncError?.reason || null,
      lastSyncErrorDetail: wc.lastSyncError?.detail || null,
      // [FIX-CATALOG-SEND-HEALTH] The SYNC (items_batch upload) and the SEND
      // (customer-facing catalog_message/product_list) hit different Graph
      // API resources and can fail independently — a tenant can have a
      // perfectly clean sync (products live in Commerce Manager, no
      // lastSyncError) while every send still fails, most commonly because
      // the catalog isn't connected to this WABA in WhatsApp Manager yet.
      // See dispatcher.js [FIX-CATALOG-SEND-HEALTH] for where this is written.
      lastSendError:       wc.lastSendError?.reason || null,
      lastSendErrorDetail: wc.lastSendError?.detail || null,
      syncedRetailerIds: syncedRetailerCount,
      pendingVerification: (wc.pendingBatchHandles || []).length,
      totalItems:     menu.length,
      itemsReady:     menu.length - skipped.length,
      itemsSkipped:   skipped.length,
      skippedDetail:  skipped,
    });
  } catch (err) {
    logger.error('[Business] getWaCatalogHealth failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function getModeInfo(req, res) {
  try {
    const { mode } = req.query;
    const fakeBiz = { businessMode: mode || 'RESTAURANT' };
    const cfg = getModeConfig(fakeBiz);
    res.json({ mode: cfg.businessMode, flows: cfg.flows, steps: cfg.steps, ui: cfg.ui });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listSupportedModes(_req, res) {
  try {
    res.json({ modes: getSupportedModes() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
