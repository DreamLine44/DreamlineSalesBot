/**
 * middleware/onboardingValidation.js
 *
 * Dependency-free request validation for the WhatsApp onboarding module.
 *
 * [FIX-VAL-1] validateWhatsAppCredentials no longer requires wabaId and
 *   verifyToken as hard required fields. In practice:
 *   - wabaId: useful for record-keeping but not used in Meta API verification
 *     (the phone number endpoint doesn't require it). Tenants may not have it
 *     readily available. Now optional.
 *   - verifyToken: only needed if the tenant runs their own webhook server.
 *     For the WhatSales managed webhook setup this is not required upfront.
 *     Now optional.
 *   phoneNumberId and accessToken remain required — they are the only two
 *   fields actually used for Meta API verification.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function validate(body, rules) {
  const errors = [];

  for (const [field, checks] of Object.entries(rules)) {
    const value = body[field];

    if (checks.required && (value === undefined || value === null || String(value).trim() === '')) {
      errors.push({ field, message: `${field} is required` });
      continue;
    }

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const str = String(value).trim();

      if (checks.maxlength && str.length > checks.maxlength) {
        errors.push({ field, message: `${field} must be at most ${checks.maxlength} characters` });
      }

      if (checks.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
        errors.push({ field, message: `${field} must be a valid email address` });
      }

      if (checks.enum && !checks.enum.includes(str)) {
        errors.push({ field, message: `${field} must be one of: ${checks.enum.join(', ')}` });
      }

      if (checks.pattern && !checks.pattern.test(str)) {
        errors.push({ field, message: checks.patternMessage || `${field} has an invalid format` });
      }
    }
  }

  return errors;
}

// ── Exported validators ───────────────────────────────────────────────────────

/**
 * validateConnectionRequest
 * POST /api/whatsapp/request
 */
export function validateConnectionRequest(req, res, next) {
  const errors = validate(req.body, {
    businessName:     { required: true, maxlength: 120 },
    businessCategory: { required: true, maxlength: 80 },
    whatsappNumber: {
      required: true,
      maxlength: 20,
      pattern: /^\+?[1-9]\d{6,18}$/,
      patternMessage: 'whatsappNumber must be a valid phone number (e.g. +220xxxxxxx)',
    },
    contactPerson:  { required: true, maxlength: 100 },
    contactEmail:   { required: true, maxlength: 200, email: true },
    notes:          { maxlength: 1000 },
  });

  if (errors.length) return res.status(400).json({ errors });
  next();
}

/**
 * validateStatusUpdate
 * PATCH /admin/whatsapp/requests/:id/status
 */
export function validateStatusUpdate(req, res, next) {
  const VALID_STATUSES = ['pending', 'contacted', 'connecting', 'connected', 'rejected'];

  const errors = validate(req.body, {
    status:     { required: true, enum: VALID_STATUSES },
    adminNotes: { maxlength: 2000 },
  });

  if (errors.length) return res.status(400).json({ errors });
  next();
}

/**
 * validateWhatsAppCredentials
 * POST /admin/whatsapp/connect/:tenantId
 *
 * [FIX-VAL-1] wabaId and verifyToken are now optional.
 *   Only phoneNumberId and accessToken are required for Meta verification.
 */
export function validateWhatsAppCredentials(req, res, next) {
  const errors = validate(req.body, {
    phoneNumberId: { required: true, maxlength: 80 },
    wabaId:        { maxlength: 80 },        // optional — informational only
    accessToken:   { required: true, maxlength: 600 },
    verifyToken:   { maxlength: 200 },       // optional — only needed for tenant-managed webhooks
    apiVersion:    { maxlength: 10 },
  });

  if (errors.length) return res.status(400).json({ errors });
  next();
}
