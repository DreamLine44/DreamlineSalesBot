/**
 * config/cloudinary.js — WhatSalesAgent2
 *
 * Cloudinary integration for menu item images.
 * All image operations (upload, delete, transform) go through this module.
 *
 * Required env vars:
 *   CLOUDINARY_CLOUD_NAME   — e.g. my-cloud
 *   CLOUDINARY_API_KEY      — numeric key from Cloudinary dashboard
 *   CLOUDINARY_API_SECRET   — secret from Cloudinary dashboard
 *
 * Optional:
 *   CLOUDINARY_UPLOAD_PRESET — unsigned upload preset (for client-side uploads)
 *
 * All vars are optional at startup — Cloudinary features simply return
 * { enabled: false } when unconfigured, so the bot keeps working with no images.
 */

import { v2 as cloudinary } from 'cloudinary';
import logger from './logger.js';

const {
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

export const CLOUDINARY_ENABLED = !!(
  CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET
);

if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key:    CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure:     true,
  });
  logger.info('[Cloudinary] Configured — image uploads enabled');
} else {
  logger.warn('[Cloudinary] Not configured — image uploads disabled (set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)');
}

/**
 * Upload a menu item image to Cloudinary.
 *
 * @param {string} filePathOrDataUri  Absolute file path OR base64 data URI
 * @param {object} options
 * @param {string} options.tenantId   Used to organise assets in a folder
 * @param {string} [options.publicId] Optional stable public_id (for replacement)
 * @returns {{ url: string, public_id: string }}
 */
export async function uploadMenuImage(filePathOrDataUri, { tenantId, publicId } = {}) {
  if (!CLOUDINARY_ENABLED) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.');
  }

  const uploadOptions = {
    folder:        `whatsalesagent/tenants/${tenantId}/menu`,
    resource_type: 'image',
    // Resize to max 800px wide, keep aspect ratio — stored at this size
    width:         800,
    crop:          'limit',
    // quality and format are top-level delivery options, NOT inside transformation[]
    // (transformation[] only accepts geometric/colour ops; quality/format are upload params)
    quality:       'auto:good',
    // Overwrite if same public_id (replace existing image cleanly)
    ...(publicId ? { public_id: publicId, overwrite: true, invalidate: true } : {}),
  };

  const result = await cloudinary.uploader.upload(filePathOrDataUri, uploadOptions);

  return {
    url:       result.secure_url,
    public_id: result.public_id,
  };
}

/**
 * Delete a menu item image from Cloudinary by public_id.
 * Non-fatal: logs a warning on failure instead of throwing.
 *
 * @param {string} publicId  Cloudinary public_id to delete
 */
export async function deleteMenuImage(publicId) {
  if (!CLOUDINARY_ENABLED || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
    logger.info('[Cloudinary] Deleted image', { publicId });
  } catch (err) {
    logger.warn('[Cloudinary] Failed to delete image (non-fatal)', { publicId, err: err.message });
  }
}

/**
 * Build a resized/optimised Cloudinary URL for WhatsApp delivery.
 * WhatsApp images: max 5 MB; 1600px is a safe upper bound.
 *
 * Only inserts a transformation if the URL doesn't already contain one
 * (i.e., no existing /upload/<params>/ segment). Prevents double-transformation
 * when the stored URL already has width/quality from uploadMenuImage.
 *
 * @param {string} url  Original Cloudinary URL
 * @param {object} [opts]
 * @param {number} [opts.width=1600]
 * @returns {string}
 */
export function buildWhatsAppImageUrl(url, { width = 1600 } = {}) {
  if (!url || !url.includes('cloudinary.com')) return url;
  // If the URL already has a transformation segment (e.g. /upload/w_800,.../)
  // don't add another one — return as-is.
  if (/\/upload\/[^/]+,[^/]+\//.test(url)) return url;
  return url.replace('/upload/', `/upload/w_${width},q_auto:good,f_auto/`);
}

export default cloudinary;
