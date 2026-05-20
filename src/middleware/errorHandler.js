/**
 * middleware/errorHandler.js — WhatSalesAgent2 (Production)
 *
 * Changes from dev:
 *  - Stack traces are NEVER sent to clients in any environment (only logged server-side).
 *  - Mongoose validation / cast errors mapped to 400 instead of 500.
 *  - Mongoose duplicate-key (11000) mapped to 409.
 *  - Every 5xx error gets a correlation ID logged alongside it for tracing.
 */
import crypto from 'crypto';
import logger  from '../config/logger.js';

export function errorHandler(err, req, res, next) {
  // Map known error types to HTTP status codes
  let status = err.status || err.statusCode || 500;

  if (err.name === 'ValidationError')     status = 400; // Mongoose schema validation
  if (err.name === 'CastError')           status = 400; // Invalid ObjectId, etc.
  if (err.code === 11000)                 status = 409; // Mongoose duplicate key

  // User-safe message — never expose internals in production
  let message;
  if (status >= 500) {
    const corrId = crypto.randomBytes(4).toString('hex');
    logger.error('[Error]', {
      corrId,
      message: err.message,
      stack:   err.stack?.slice(0, 600),
      path:    req.path,
      method:  req.method,
    });
    message = `Internal server error [ref: ${corrId}]`;
  } else {
    // 4xx errors — safe to surface the message
    message = err.message || 'Bad request';
    if (err.code === 11000) message = 'Duplicate entry — resource already exists';
    if (err.name === 'CastError') message = `Invalid value for field: ${err.path}`;
  }

  res.status(status).json({ error: message });
}
