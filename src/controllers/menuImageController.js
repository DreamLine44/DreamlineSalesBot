/**
 * controllers/menuImageController.js — WhatSalesAgent2
 *
 * Dedicated endpoints for uploading and removing a menu item image.
 *
 * POST   /:tenantId/menu/:itemId/image  — multipart/form-data, field "image"
 * DELETE /:tenantId/menu/:itemId/image  — clears image from DB + Cloudinary
 *
 * These endpoints exist alongside the PATCH /:itemId route so callers can
 * update text fields and images independently (useful for dashboards that
 * handle the image picker separately from the detail form).
 */

import BusinessConfig from '../models/BusinessConfig.js';
import { uploadMenuImage, deleteMenuImage, CLOUDINARY_ENABLED } from '../config/cloudinary.js';
import logger from '../config/logger.js';
// [FIX-CATALOG-IMAGE-AUTOSYNC] Every other menu-mutating endpoint
// (addMenuItem/updateMenuItem/deleteMenuItem in dashboardController.js,
// PATCH /:itemId in businessController.js) calls scheduleWaCatalogSync()
// after a successful write. This file — the dedicated image upload/remove
// endpoints — never did, so attaching or removing a menu item's photo
// through this route silently never reached Meta's catalog on its own; it
// only synced once some OTHER field on the item happened to change too.
// Since the image is very often the ONLY thing being changed (exactly the
// case that motivated this endpoint's existence per the module header
// above), that gap meant the single most catalog-relevant field update had
// no automatic sync path at all.
import { scheduleWaCatalogSync } from '../modules/catalog/waCatalogSyncScheduler.js';

/**
 * POST /:tenantId/menu/:itemId/image
 * Body: multipart/form-data with field "image" (file)
 * Optional body fields:
 *   showImageOnSelect (boolean, default true) — whether the bot auto-sends this image
 */
export async function uploadMenuItemImage(req, res) {
  try {
    const { tenantId, itemId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided. Send a JPEG/PNG/WebP/GIF as multipart field "image".' });
    }

    if (!CLOUDINARY_ENABLED) {
      return res.status(503).json({
        error: 'Image uploads are not configured on this server. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
      });
    }

    // Fetch existing public_id so we replace cleanly (no orphaned assets)
    const existing = await BusinessConfig.findOne(
      { tenantId, 'menuItems._id': itemId },
      { 'menuItems.$': 1 },
    ).lean();

    if (!existing) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    const oldPublicId = existing.menuItems?.[0]?.image?.public_id || null;

    // Upload to Cloudinary
    let uploaded;
    try {
      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      uploaded = await uploadMenuImage(dataUri, {
        tenantId,
        publicId: oldPublicId || undefined,
      });
    } catch (uploadErr) {
      logger.error('[MenuImage] Cloudinary upload failed', { err: uploadErr.message });
      return res.status(502).json({ error: `Image upload failed: ${uploadErr.message}` });
    }

    const showImageOnSelect = req.body?.showImageOnSelect !== 'false' && req.body?.showImageOnSelect !== false;

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'menuItems._id': itemId },
      {
        $set: {
          'menuItems.$.image':            { url: uploaded.url, public_id: uploaded.public_id },
          'menuItems.$.showImageOnSelect': showImageOnSelect,
        },
      },
      { new: true },
    );

    if (!biz) return res.status(404).json({ error: 'Menu item not found' });

    const updatedItem = biz.menuItems.find(i => String(i._id) === itemId);
    logger.info('[MenuImage] Uploaded', { tenantId, itemId, public_id: uploaded.public_id });

    // [FIX-CATALOG-IMAGE-AUTOSYNC] See import comment above — this is the
    // write that was previously never followed by a sync trigger.
    scheduleWaCatalogSync(tenantId);

    res.json({
      ok: true,
      image: uploaded,
      menuItem: updatedItem,
    });
  } catch (err) {
    logger.error('[MenuImage] uploadMenuItemImage failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

// [FEAT-MULTI-IMAGE] Same cap enforced on the schema (menuItemSchema.images
// validator, BusinessConfig.js) — checked again here BEFORE any Cloudinary
// upload happens so a request that would exceed it is rejected as a whole,
// with nothing partially uploaded and orphaned on Cloudinary.
const MAX_GALLERY_IMAGES = 10;

/**
 * POST /:tenantId/menu/:itemId/images
 * Body: multipart/form-data with repeated field "images" (1–10 files)
 *
 * Appends to the item's `images` gallery array — does not touch the
 * separate, single `image` (cover photo) field at all, so this is purely
 * additive and never affects what waCatalogService.buildItemData() uses as
 * the primary `image_link` for Meta catalog sync. Newly-added images DO
 * still trigger a resync (scheduleWaCatalogSync below), since they change
 * what buildItemData() writes into `additional_image_urls` for this item.
 */
export async function uploadMenuItemGalleryImages(req, res) {
  try {
    const { tenantId, itemId } = req.params;

    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No image files provided. Send one or more JPEG/PNG/WebP/GIF files as multipart field "images".' });
    }

    if (!CLOUDINARY_ENABLED) {
      return res.status(503).json({
        error: 'Image uploads are not configured on this server. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
      });
    }

    const existing = await BusinessConfig.findOne(
      { tenantId, 'menuItems._id': itemId },
      { 'menuItems.$': 1 },
    ).lean();

    if (!existing) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    const currentCount = (existing.menuItems?.[0]?.images || []).length;
    if (currentCount + req.files.length > MAX_GALLERY_IMAGES) {
      return res.status(400).json({
        error: `This item already has ${currentCount} gallery image(s) — uploading ${req.files.length} more would exceed the ${MAX_GALLERY_IMAGES}-image limit. Remove some first or upload fewer at once.`,
      });
    }

    // Upload sequentially rather than Promise.all — keeps Cloudinary load
    // predictable and, if one file fails partway through, leaves a clear
    // partial-success point rather than an unpredictable interleaving.
    const uploaded = [];
    try {
      for (const file of req.files) {
        const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        const result = await uploadMenuImage(dataUri, { tenantId });
        uploaded.push({ url: result.url, public_id: result.public_id });
      }
    } catch (uploadErr) {
      logger.error('[MenuImage] Gallery Cloudinary upload failed', { err: uploadErr.message, uploadedSoFar: uploaded.length });
      // Clean up any images that DID upload before the failure, so a
      // half-succeeded request doesn't leave orphaned Cloudinary assets
      // with no DB record pointing at them.
      for (const img of uploaded) await deleteMenuImage(img.public_id);
      return res.status(502).json({ error: `Image upload failed: ${uploadErr.message}` });
    }

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'menuItems._id': itemId },
      { $push: { 'menuItems.$.images': { $each: uploaded } } },
      { new: true },
    );

    if (!biz) return res.status(404).json({ error: 'Menu item not found' });

    const updatedItem = biz.menuItems.find(i => String(i._id) === itemId);
    logger.info('[MenuImage] Gallery images added', { tenantId, itemId, count: uploaded.length });

    scheduleWaCatalogSync(tenantId);

    res.status(201).json({
      ok: true,
      images: uploaded,
      menuItem: updatedItem,
    });
  } catch (err) {
    logger.error('[MenuImage] uploadMenuItemGalleryImages failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /:tenantId/menu/:itemId/images/:imageId
 * Removes one gallery image by its own subdocument _id (not its Cloudinary
 * public_id, which often contains '/' from its folder path and can't safely
 * round-trip through a URL path segment).
 */
export async function removeMenuItemGalleryImage(req, res) {
  try {
    const { tenantId, itemId, imageId } = req.params;

    const existing = await BusinessConfig.findOne(
      { tenantId, 'menuItems._id': itemId },
      { 'menuItems.$': 1 },
    ).lean();

    if (!existing) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    const target = (existing.menuItems?.[0]?.images || []).find(img => String(img._id) === imageId);
    if (!target) {
      return res.status(404).json({ error: 'Gallery image not found on this item' });
    }

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'menuItems._id': itemId },
      { $pull: { 'menuItems.$.images': { _id: imageId } } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Menu item not found' });

    // Delete from Cloudinary (non-fatal — DB is already the source of truth)
    if (target.public_id) await deleteMenuImage(target.public_id);

    scheduleWaCatalogSync(tenantId);

    const updatedItem = biz.menuItems.find(i => String(i._id) === itemId);
    logger.info('[MenuImage] Gallery image removed', { tenantId, itemId, imageId });
    res.json({ ok: true, menuItem: updatedItem });
  } catch (err) {
    logger.error('[MenuImage] removeMenuItemGalleryImage failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /:tenantId/menu/:itemId/image
 * Removes the image from the DB record and deletes from Cloudinary.
 */
export async function removeMenuItemImage(req, res) {
  try {
    const { tenantId, itemId } = req.params;

    // Fetch existing public_id for Cloudinary cleanup
    const existing = await BusinessConfig.findOne(
      { tenantId, 'menuItems._id': itemId },
      { 'menuItems.$': 1 },
    ).lean();

    if (!existing) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    const publicId = existing.menuItems?.[0]?.image?.public_id;

    const biz = await BusinessConfig.findOneAndUpdate(
      { tenantId, 'menuItems._id': itemId },
      { $set: { 'menuItems.$.image': { url: null, public_id: null } } },
      { new: true },
    );
    if (!biz) return res.status(404).json({ error: 'Menu item not found' });

    // Delete from Cloudinary (non-fatal)
    if (publicId) await deleteMenuImage(publicId);

    // [FIX-CATALOG-IMAGE-AUTOSYNC] See import comment above.
    scheduleWaCatalogSync(tenantId);

    logger.info('[MenuImage] Removed', { tenantId, itemId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[MenuImage] removeMenuItemImage failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}
