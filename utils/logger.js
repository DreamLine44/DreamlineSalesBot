/**
 * utils/logger.js — re-exports config/logger.js for backward compatibility.
 * Use config/logger.js directly in all new code.
 */
import logger from '../config/logger.js';

export const log   = (msg, meta) => logger.info(msg, meta);
export const error = (msg, meta) => logger.error(msg, meta);
export default logger;
