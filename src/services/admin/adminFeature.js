/**
 * Consolidated admin feature entry point.
 *
 * Original source blocks stay in their own files and keep the same logic,
 * while the main admin feature surface is exported in one file for easier
 * maintenance and debugging.
 *
 * Source files:
 * - adminAuthService.js
 * - adminCommandService.js
 * - auditService.js
 */

// ===== adminAuthService.js =====
export * from './adminAuthService.js';

// ===== adminCommandService.js =====
export * from './adminCommandService.js';

// ===== auditService.js =====
export * from './auditService.js';
