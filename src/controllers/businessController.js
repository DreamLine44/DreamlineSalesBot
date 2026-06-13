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
 */
import BusinessConfig from '../models/BusinessConfig.js';
import { getModeConfig, getSupportedModes } from '../config/modes.js';
import logger from '../config/logger.js';
import { uploadMenuImage, deleteMenuImage, CLOUDINARY_ENABLED } from '../config/cloudinary.js';

export async function getBusinessConfig(req, res) {
  try {
    const { tenantId } = req.params;
    const biz = await BusinessConfig.findOne({ tenantId }).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
    res.json({ business: biz });
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

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId },
      { $set: update },
      { new: true, upsert: false, runValidators: true },
    ).lean();
    if (!biz) return res.status(404).json({ error: 'Not found' });
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

    // ── Parse array fields (keywords, tags) — arrive as strings from multipart ─
    let keywords = req.body.keywords ?? [];
    if (typeof keywords === 'string') {
      try { keywords = JSON.parse(keywords); } catch { keywords = keywords ? [keywords] : []; }
    }
    let tags = req.body.tags ?? [];
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags); } catch { tags = tags ? [tags] : []; }
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
            showImageOnSelect: showImageOnSelect === 'false' ? false : Boolean(showImageOnSelect),
            image,
          },
        },
      },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Not found' });
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

export async function listSupportedModes(_req, res) {
  try {
    res.json({ modes: getSupportedModes() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
