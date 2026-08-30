/**
 * Consolidated order feature entry point.
 *
 * Original source blocks kept in their domain files so logic stays untouched,
 * but this file becomes the canonical import surface for the order domain.
 *
 * Source files:
 * - orderService.js
 * - activeOrderResolver.js
 * - promoService.js
 */

// ===== orderService.js =====
export * from './orderService.js';

// ===== activeOrderResolver.js =====
export * from './activeOrderResolver.js';

// ===== promoService.js =====
export * from './promoService.js';
