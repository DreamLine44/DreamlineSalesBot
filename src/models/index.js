/**
 * models/index.js — WhatSalesAgent2
 * Re-exports all models from one place.
 */
export { default as Session }        from './Session.js';
export { default as Tenant }         from './Tenant.js';
export { default as BusinessConfig } from './BusinessConfig.js';
export { default as Order }          from './Order.js';
export { default as Booking }        from './Booking.js';
export { default as UserProfile }    from './UserProfile.js';
export { default as Analytics }      from './Analytics.js';
export { default as ProcessedMessage } from './ProcessedMessage.js';
export { default as AuditLog }        from './AuditLog.js';    // [FIX-MODEL-1] Was missing from re-export — auditService imports this directly, but any consumer that uses models/index.js would get a missing export.
