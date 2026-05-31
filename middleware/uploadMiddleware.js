/**
 * middleware/uploadMiddleware.js — WhatSalesAgent2
 *
 * Multer-based middleware for menu item image uploads.
 *
 * - Accepts: JPEG, PNG, WebP, GIF
 * - Max file size: 5 MB (WhatsApp image limit)
 * - Files are stored in memory (Buffer) then streamed to Cloudinary.
 *   No temp files are written to disk.
 *
 * Usage:
 *   import { uploadSingle } from '../middleware/uploadMiddleware.js';
 *   router.post('/route', uploadSingle, handler);
 *
 *   In handler: req.file → { buffer, mimetype, originalname, size }
 */

import multer from 'multer';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP, GIF.`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_SIZE_BYTES },
});

/**
 * Single-file upload middleware — field name "image".
 * Attaches req.file on success; responds 400 on validation failure.
 */
export function uploadSingle(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image too large — maximum size is 5 MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    // fileFilter rejection or unknown error
    return res.status(400).json({ error: err.message });
  });
}
