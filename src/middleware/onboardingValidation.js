/**
 * middleware/onboardingValidation.js
 *
 * express-validator–free, dependency-free request validation helpers
 * for the WhatsApp onboarding module.
 *
 * Each validator is a standard Express middleware that calls next() on
 * success or returns 400 with a structured error list on failure.
 *
 * Deliberately no external libraries — keeps the onboarding module
 * isolated and adds zero new dependencies to the project.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect field-level errors from a body object and a rule map. */
function validate(body, rules) {
  const errors = [];

  for (const [field, checks] of Object.entries(rules)) {
    const value = body[field];

    if (checks.required && (value === undefined || value === null || String(value).trim() === '')) {
      errors.push({ field, message: `${field} is required` });
      continue; // skip further checks for this field if missing
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

// ── Exported validators ──────────────────────────────────────────────────────

/**
 * validateConnectionRequest
 * Used by: POST /api/whatsapp/request
 */
export function validateConnectionRequest(req, res, next) {
  const errors = validate(req.body, {
    businessName:     { required: true, maxlength: 120 },
    businessCategory: { required: true, maxlength: 80 },
    whatsappNumber:   {
      required: true,
      maxlength: 20,
      pattern: /^\+?[1-9]\d{6,18}$/,
      patternMessage: 'whatsappNumber must be a valid phone number (e.g. +220xxxxxxx)',
    },
    contactPerson:    { required: true, maxlength: 100 },
    contactEmail:     { required: true, maxlength: 200, email: true },
    notes:            { maxlength: 1000 },
  });

  if (errors.length) return res.status(400).json({ errors });
  next();
}

/**
 * validateStatusUpdate
 * Used by: PATCH /admin/whatsapp/requests/:id/status
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
 * Used by: POST /admin/whatsapp/connect/:tenantId
 */
export function validateWhatsAppCredentials(req, res, next) {
  const errors = validate(req.body, {
    phoneNumberId: { required: true, maxlength: 80 },
    wabaId:        { required: true, maxlength: 80 },
    accessToken:   { required: true, maxlength: 600 },
    verifyToken:   { required: true, maxlength: 200 },
    apiVersion:    { maxlength: 10 },
  });

  if (errors.length) return res.status(400).json({ errors });
  next();
}
