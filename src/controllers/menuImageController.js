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

    logger.info('[MenuImage] Removed', { tenantId, itemId });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[MenuImage] removeMenuItemImage failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
}
