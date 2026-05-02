import logger from "../config/logger.js";

/**
 * Express error handler.
 * NEVER exposes internal error messages to HTTP clients in production.
 * All details go to the logger only.
 */
export const errorHandler = (err, req, res, next) => {
  logger.error("[ErrorHandler] Unhandled error", {
    err: err.message,
    stack: err.stack,
    path: req?.path,
    method: req?.method,
  });

  if (res.headersSent) return next(err);

  const isProd = process.env.NODE_ENV === "production";

  res.status(err.status || 500).json({
    success: false,
    // In production: generic message only — never expose internals.
    // In development: include message for faster debugging.
    message: isProd
      ? "An unexpected error occurred. Please try again later."
      : err.message || "Internal Server Error",
  });
};
