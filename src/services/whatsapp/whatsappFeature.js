/**
 * Consolidated WhatsApp feature entry point.
 *
 * [FIX-BARREL-EXPORT-COLLISION] metaCredentialService.js and
 * whatsappOnboardingService.js both define a `verifyCredentials` function —
 * different signatures, different return shapes, genuinely different checks
 * (one is the general Meta Graph API credential check, the other is the
 * onboarding-flow-specific check used by whatsappOnboardingController.js).
 * A blind `export *` from both makes the name AMBIGUOUS, which ES modules
 * resolve by silently dropping it from the barrel's namespace — not a
 * compile error, just a confusing "not exported" failure for whoever tries
 * to import it through here later. Named re-export below keeps the
 * onboarding-flow version (the one live app code actually uses) under the
 * bare name, and exposes the other under an explicit alias so both stay
 * reachable without the collision.
 *
 * Source files:
 * - metaCredentialService.js
 * - whatsappNotificationService.js
 * - whatsappOnboardingService.js
 */

// ===== metaCredentialService.js =====
// Named (not *) — verifyCredentials aliased to avoid colliding with
// whatsappOnboardingService.js's own verifyCredentials below.
export {
  verifyCredentials as verifyMetaCredentials,
  getWABADetails,
  getPhoneNumbers,
  getBusinessDetails,
  autoDiscoverTenantCredentials,
} from './metaCredentialService.js';

// ===== whatsappNotificationService.js =====
export * from './whatsappNotificationService.js';

// ===== whatsappOnboardingService.js =====
export * from './whatsappOnboardingService.js';
