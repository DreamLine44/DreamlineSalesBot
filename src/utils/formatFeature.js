/**
 * Consolidated small-format-utils entry point.
 *
 * These three tiny helpers are frequently imported together across the
 * vertical order flows (phone display, item/variant labels, money display),
 * so this barrel centralizes them the same way *Feature.js does for the
 * larger domains (services/booking/bookingFeature.js, core/nlu/nluFeature.js,
 * etc). Original files kept as-is — this only re-exports.
 *
 * Source files:
 * - formatPhone.js
 * - itemLabel.js
 * - formatCurrency.js
 */

export * from './formatPhone.js';
export * from './itemLabel.js';
export * from './formatCurrency.js';
