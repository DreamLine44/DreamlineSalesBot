/**
 * Consolidated NLU feature entry point.
 *
 * Original source files kept in their layer subfolder so logic stays
 * untouched, but the public surface is centralized here so the whole
 * "understand what the customer typed" pipeline can be traced from one
 * import location — mirrors the existing *Feature.js convention used by
 * services/booking/bookingFeature.js, services/order/orderFeature.js, etc.
 *
 *   extraction/     — raw text in, AI-extracted spans/replies out
 *   classification/ — routing decision (which intent/flow this message is)
 *   resolution/      — validating/matching extracted spans against real
 *                       tenant data (fuzzy match, date parsing, confirm/deny)
 *
 * NOTE ON PROVIDER INTERNALS: groqProvider.js and mockProvider.js both
 * export getReply/generateGreeting/healthCheck — aiRouter.js is documented
 * as "THE ONLY AI ENTRY POINT for all business logic" and wraps both behind
 * getAIReply/generateGreeting/aiHealthCheck, so only aiRouter's wrapped
 * surface is re-exported here for those three. groqProvider.js's other
 * exports (prompt building, structured classification, date parsing) don't
 * go through aiRouter and are re-exported directly by name below.
 *
 * Source files:
 * - extraction/aiRouter.js
 * - extraction/groqProvider.js
 * - extraction/mockProvider.js       (provider internal — import directly if ever needed standalone)
 * - extraction/nluContext.js
 * - extraction/enhancedNlu.js
 * - classification/intentEngine.js
 * - classification/patterns.js
 * - classification/negationGuard.js
 * - resolution/matchEngine.js
 * - resolution/parseQuantity.js
 * - resolution/confirmationMatcher.js
 * - resolution/bookingDateParser.js
 * - resolution/cartMessageParser.js
 */

// ===== extraction/aiRouter.js =====
// THE ONLY AI ENTRY POINT for all business logic (getAIReply, generateGreeting, aiHealthCheck).
export * from './extraction/aiRouter.js';

// ===== extraction/groqProvider.js =====
// Named (not *) — getReply/generateGreeting/healthCheck are provider
// internals already wrapped by aiRouter.js above; re-exporting them here
// too would collide with mockProvider.js's identically-named exports.
export {
  buildSystemPrompt,
  classifyMessageStructured,
  classifyIntent,
  parseBookingDate,
} from './extraction/groqProvider.js';

// ===== extraction/nluContext.js =====
export * from './extraction/nluContext.js';

// ===== extraction/enhancedNlu.js =====
// Named (not *) — isEnhancedNluEnabled is re-exported here from nluContext.js
// already covered by the `export *` above; listing it again is redundant,
// not a conflict, but named keeps this file's own additions explicit.
export {
  resolveProductEntities,
  classifyMessageEnhanced,
} from './extraction/enhancedNlu.js';

// ===== classification/intentEngine.js =====
export * from './classification/intentEngine.js';

// ===== classification/patterns.js =====
export * from './classification/patterns.js';

// ===== classification/negationGuard.js =====
export * from './classification/negationGuard.js';

// ===== resolution/matchEngine.js =====
export * from './resolution/matchEngine.js';

// ===== resolution/parseQuantity.js =====
export * from './resolution/parseQuantity.js';

// ===== resolution/confirmationMatcher.js =====
export * from './resolution/confirmationMatcher.js';

// ===== resolution/bookingDateParser.js =====
export * from './resolution/bookingDateParser.js';

// ===== resolution/cartMessageParser.js =====
export * from './resolution/cartMessageParser.js';
