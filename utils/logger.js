/**
 * utils/logger.js — DEPRECATED
 *
 * Previously used winston directly. All code now uses config/logger.js.
 * This file is a thin re-export for backward-compat only.
 * Import from '../config/logger.js' in all new code.
 */
import logger from '../config/logger.js';

export const log   = (msg, meta) => logger.info(msg, meta);
export const error = (msg, meta) => logger.error(msg, meta);
export default logger;
