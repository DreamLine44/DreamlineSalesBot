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
import Tenant from '../models/Tenant.js';
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

    // [CATALOG-BIZ-1] $set with a plain nested object (`waCatalog: {...}`) REPLACES
    // the entire subdocument in MongoDB rather than merging — Mongoose does not
    // expand sibling fields or reapply schema defaults on a findOneAndUpdate $set.
    // Since this endpoint is the only way tenants configure WA Catalog, a caller
    // that sends just `{ waCatalog: { catalogId: 'X' } }` to add a catalog ID would
    // silently wipe out an already-set `enabled`/`mode`, and later sending just
    // `{ waCatalog: { enabled: true } }` to flip it on would silently wipe the
    // catalogId right back out — the two calls fight each other instead of
    // composing. Flatten to dot-notation before the $set, same as the existing
    // [FIX-TONE-3] pattern below, so each sub-field updates independently and
    // untouched sibling fields are left exactly as they were.
    if (update.waCatalog && typeof update.waCatalog === 'object') {
      for (const [k, v] of Object.entries(update.waCatalog)) {
        update[`waCatalog.${k}`] = v;
      }
      delete update.waCatalog;
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

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $set: update },
      { new: true, upsert: false, runValidators: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });

    // [CATALOG-AUTOSYNC-1] This generic route can also change menuItems (via
    // the "menu" alias above) — only schedule a sync when that actually
    // happened, not on every unrelated field update (tone, hours, etc.).
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

    // [CATALOG-AUTOSYNC-1] Bulk menu replace — same debounced autosync as the
    // per-item CRUD below.
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
    const { name, price, description, available = true, showImageOnSelect = true } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    // [AUDIT-FIX-USAGE-2] Same cap as dashboardController.addMenuItem
    // (see [AUDIT-FIX-USAGE-1]) — this is a second, separate route to the
    // same underlying $push, reachable via PUT/POST /business/:tenantId/menu.
    // Without the same check here, the cap added to the dashboard route was
    // trivially bypassable through this one.
    const [tenantLimits, currentBiz] = await Promise.all([
      Tenant.findById(tenantId).select('limits.maxMenuItems').lean(),
      BusinessConfig.findOne({ tenantId }).select('menuItems').lean(),
    ]);
    const maxMenuItems = tenantLimits?.limits?.maxMenuItems ?? 10;
    const currentCount = (currentBiz?.menuItems || []).length;
    if (currentCount >= maxMenuItems) {
      return res.status(403).json({
        // [NO-SELFSERVE-1] Same wording fix as dashboardController.addMenuItem —
        // no self-serve billing exists, so point the tenant at the admin.
        error: `Menu item limit reached (${currentCount}/${maxMenuItems} on your current plan). `
             + `Contact your account admin to raise your plan limit, or remove an existing item to add a new one.`,
        limit: maxMenuItems,
        current: currentCount,
      });
    }

    // ── Parse array fields (keywords, tags) — arrive as strings from multipart ─
    let keywords = req.body.keywords ?? [];
    if (typeof keywords === 'string') {
      try { keywords = JSON.parse(keywords); } catch { keywords = keywords ? [keywords] : []; }
    }
    let tags = req.body.tags ?? [];
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags); } catch { tags = tags ? [tags] : []; }
    }
    // [FIX-VARIANTS-SCHEMA] Same string-or-array handling as keywords/tags —
    // menuItemSchema now declares `variants`, so this actually persists.
    let variants = req.body.variants ?? [];
    if (typeof variants === 'string') {
      try { variants = JSON.parse(variants); } catch { variants = variants ? [variants] : []; }
    }

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
            showImageOnSelect: showImageOnSelect === 'false' ? false : Boolean(showImageOnSelect),
            image,
          },
        },
      },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });

    // [CATALOG-AUTOSYNC-1] See waCatalogSyncScheduler.js — debounced, no-op
    // unless this tenant has WA Catalog enabled.
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

    // [CATALOG-AUTOSYNC-1] / [CATALOG-CRUD-1] Deleting an item now actually
    // removes it from Meta's catalog too — syncMenuToCatalog() diffs the
    // current menu against waCatalog.syncedRetailerIds and sends a DELETE
    // batch request for anything that dropped out.
    scheduleWaCatalogSync(tenantId);

    res.json({ ok: true });
  } catch (err) {
    logger.error('[Business] deleteMenuItem failed', { err: err.message });
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

/**
 * [CATALOG-SYNC-ROUTE-1] POST /:tenantId/wacatalog/sync
 *
 * Wires the previously-unused waCatalogService.syncMenuToCatalog() to an actual
 * endpoint — before this, the function was fully written and tested but had no
 * caller anywhere in the codebase, so there was no way for a tenant to push
 * menuItems into their Meta Commerce Catalog short of calling it manually from
 * a Node console. This is a manual "Sync Now" action (e.g. behind an admin
 * dashboard button after editing the menu), not a cron job — see the "Future
 * extension opportunities" note in waCatalogService.js for that separate,
 * still-unimplemented, automatic-trigger direction.
 *
 * Requires waCatalog.enabled + a configured catalogId (mirrors isCatalogEnabled()
 * in waCatalogConfig.js) — a tenant who hasn't opted into WA Catalog gets a
 * clear 400 rather than a confusing Graph API error further down the stack.
 */
export async function syncWaCatalog(req, res) {
  try {
    const { tenantId } = req.params;

    const business = await BusinessConfig.findOne({ tenantId }).lean();
    if (!business) return res.status(404).json({ error: 'Business not found' });

    if (!business.waCatalog?.enabled || !business.waCatalog?.catalogId) {
      return res.status(400).json({
        error: 'WA Catalog is not enabled or has no catalogId configured for this tenant. '
             + 'Set waCatalog.enabled=true and waCatalog.catalogId via PUT /:tenantId first.',
      });
    }

    // [CATALOG-SYNC-ROUTE-2] syncMenuToCatalog() decrypts tenant.whatsapp.accessToken
    // itself (see waCatalogService.js), so the full Tenant document — not a lean
    // projection missing the encrypted field — must be loaded here.
    const { default: Tenant } = await import('../models/Tenant.js');
    const tenant = await Tenant.findById(tenantId).lean();
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { syncMenuToCatalog } = await import('../modules/catalog/waCatalogService.js');
    const result = await syncMenuToCatalog(business, tenant);

    if (!result.ok) {
      // [CATALOG-SYNC-ROUTE-3] Distinguish the caller-fixable case (no access token
      // configured at all) from an actual Graph API failure, so the response tells
      // an admin what to do next instead of a bare "GRAPH_ERROR" reason code.
      const status = result.reason === 'NO_TOKEN' || result.reason === 'NO_CATALOG_ID' ? 400 : 502;
      return res.status(status).json({ ok: false, reason: result.reason, status: result.status });
    }

    res.json({ ok: true, synced: result.synced, deleted: result.deleted || 0 });
  } catch (err) {
    logger.error('[Business] syncWaCatalog failed', { err: err.message, tenantId: req.params.tenantId });
    res.status(500).json({ error: err.message });
  }
}

/**
 * [CATALOG-HEALTH-1] GET /:tenantId/wacatalog/health
 *
 * Read-only status snapshot for a "WA Catalog" widget on the admin dashboard —
 * the reviewed audit's suggestion (see delivery write-up): connection state,
 * live product count, last-sync recency, and simple data-quality counts
 * (missing images / out-of-stock items) an admin can act on without needing
 * to inspect Meta's Commerce Manager directly.
 *
 * Never triggers a sync itself — purely reads what's already stored on
 * BusinessConfig from the most recent syncMenuToCatalog() run (manual or
 * autosync-debounced). Use POST /:tenantId/wacatalog/sync to actually sync.
 */
export async function getWaCatalogHealth(req, res) {
  try {
    const { tenantId } = req.params;
    const business = await BusinessConfig.findOne({ tenantId }).select('menuItems waCatalog').lean();
    if (!business) return res.status(404).json({ error: 'Business not found' });

    const connected = !!(business.waCatalog?.enabled && business.waCatalog?.catalogId);
    const menu = business.menuItems || [];

    // [CATALOG-HEALTH-2] "products" reflects what's actually LIVE in Meta's
    // catalog right now (the last successful sync's snapshot), not just
    // menuItems.length — those can drift apart between an edit and the next
    // debounced/manual sync, and syncedRetailerIds is the source of truth for
    // what Meta was actually told about.
    const productsLive = (business.waCatalog?.syncedRetailerIds || []).length;

    const missingImages = menu.filter(i => i.available !== false && !i.image?.url).length;
    const outOfStock    = menu.filter(i => i.available === false).length;

    const lastSyncedAt = business.waCatalog?.lastSyncedAt || null;
    const hoursSinceSync = lastSyncedAt ? (Date.now() - new Date(lastSyncedAt).getTime()) / 3_600_000 : null;

    // [CATALOG-HEALTH-4] Debounced-but-not-yet-fired sync (waCatalogSyncScheduler.js
    // — a menu edit landed in the last WA_CATALOG_AUTOSYNC_DEBOUNCE_MS window and is
    // still waiting to fire) and the most recent failure (if the last *attempted*
    // sync — manual or auto — didn't succeed). Together these are what actually
    // answer "is what customers see in WhatsApp current right now?" — lastSyncedAt
    // alone can't distinguish "nothing's changed since" from "changed, but every
    // sync attempt since has failed."
    const { hasScheduledSync } = await import('../modules/catalog/waCatalogSyncScheduler.js');
    const pendingSync = connected && hasScheduledSync(tenantId);
    const lastSyncError = (business.waCatalog?.lastSyncError?.reason) ? business.waCatalog.lastSyncError : null;

    // [CATALOG-HEALTH-3] Simple, explainable status ladder rather than a
    // single opaque boolean — mirrors the "✅ Healthy / ⚠ Needs Sync" states
    // from the audit's dashboard mockup.
    let status;
    if (!connected) status = 'not_connected';
    else if (pendingSync) status = 'sync_pending';
    else if (lastSyncError) status = 'sync_failed';
    else if (!lastSyncedAt) status = 'never_synced';
    else if (hoursSinceSync > 24) status = 'needs_sync';
    else status = 'healthy';

    res.json({
      connected,
      status,
      products: productsLive,
      lastSyncedAt,
      pendingSync,
      lastSyncError,
      missingImages,
      outOfStock,
      mode: business.waCatalog?.mode || null,
    });
  } catch (err) {
    logger.error('[Business] getWaCatalogHealth failed', { err: err.message, tenantId: req.params.tenantId });
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
