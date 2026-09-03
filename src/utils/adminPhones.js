/**
 * utils/adminPhones.js
 *
 * [FEAT-MULTI-ADMIN] Tenants can configure up to two admin/notification phone
 * numbers instead of one. This module is the single place that:
 *   1. Parses raw tenant/frontend input (one text field, numbers separated by
 *      `,` `/` or `;`) into a clean array — parseAdminPhonesInput().
 *   2. Resolves the effective admin numbers for a business — getAdminPhones().
 *      Business-level numbers win over tenant-level numbers (mirrors the
 *      pre-existing `business?.adminPhone || tenant?.adminPhone` precedence
 *      used everywhere before this change), never a mix of both.
 *   3. Checks whether an inbound WhatsApp sender is one of those admins —
 *      isAdminPhoneMatch() — so BOTH configured numbers can approve/reject/
 *      confirm, not just the first one.
 *
 * Every existing single-admin call site read/wrote a scalar `adminPhone`
 * field on Tenant/BusinessConfig. That scalar is kept as-is and now always
 * mirrors adminPhones[0] (see applyAdminPhonesUpdate()) so every untouched
 * customer-facing "call us at ..." display line keeps working unchanged —
 * only the notification-dispatch and admin-command-authorization call sites
 * needed to become multi-number aware.
 */

const MAX_ADMIN_PHONES = 2;

// Recommended/accepted separators for the single admin-phone text field:
// comma (recommended in the UI), slash, or semicolon. Deliberately NOT plain
// whitespace — a single number may legitimately contain internal spaces
// (e.g. "220 353 2423" or "+220 353 2423").
const SEPARATOR_REGEX = /[,/;]+/;

function normalizeDigits(phone) {
  return String(phone || '').replace(/^\+/, '').replace(/[^\d]/g, '');
}

/**
 * Parse the raw string (or array) a tenant submits from the dashboard's
 * single "Admin Phone" field into a clean, deduped array of at most
 * MAX_ADMIN_PHONES entries. Returns [] for empty input, never null/undefined,
 * so callers can always safely spread/iterate the result.
 *
 * Invalid fragments (fewer than 6 digits — clearly not a phone number) are
 * silently dropped rather than rejecting the whole input, so a stray typo
 * like "220 353 2423, " doesn't block saving the valid first number.
 */
export function parseAdminPhonesInput(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(SEPARATOR_REGEX);

  const seen = new Set();
  const out = [];

  for (const part of parts) {
    const cleaned = String(part ?? '').trim();
    if (!cleaned) continue;

    const digits = normalizeDigits(cleaned);
    if (digits.length < 6) continue; // not enough digits to be a real number

    if (seen.has(digits)) continue; // dedupe (e.g. "220...", "+220..." same number)
    seen.add(digits);

    out.push(cleaned);
    if (out.length >= MAX_ADMIN_PHONES) break;
  }

  return out;
}

/**
 * Given a create/update request body that may contain a raw `adminPhone`
 * string (possibly holding 1-2 numbers), return the { adminPhone, adminPhones }
 * pair to persist: adminPhones is the full parsed array, adminPhone mirrors
 * its first entry (or null) for every existing single-number reader.
 *
 * Returns null when body.adminPhone is undefined (field not being updated),
 * so callers can `if (result) Object.assign(updates, result);`.
 */
export function applyAdminPhonesUpdate(rawAdminPhoneInput) {
  if (rawAdminPhoneInput === undefined) return null;
  const adminPhones = parseAdminPhonesInput(rawAdminPhoneInput);
  return {
    adminPhones,
    adminPhone: adminPhones[0] || null,
  };
}

/**
 * Resolve the effective admin phone numbers for a business/tenant pair.
 * Business-level config wins over tenant-level (same precedence every call
 * site already used for the single-number field). Falls back to the legacy
 * scalar `adminPhone` field when `adminPhones` isn't populated yet (e.g. a
 * document saved before this feature existed, or a caller's .select()
 * projection that only pulled adminPhone) so nothing regresses for tenants
 * who haven't re-saved their settings.
 */
export function getAdminPhones(business, tenant) {
  const bizPhones = Array.isArray(business?.adminPhones) && business.adminPhones.length
    ? business.adminPhones
    : (business?.adminPhone ? [business.adminPhone] : []);
  if (bizPhones.length) return bizPhones;

  const tenantPhones = Array.isArray(tenant?.adminPhones) && tenant.adminPhones.length
    ? tenant.adminPhones
    : (tenant?.adminPhone ? [tenant.adminPhone] : []);
  return tenantPhones;
}

/** First/primary admin number — for customer-facing "call us at ..." display text. */
export function getPrimaryAdminPhone(business, tenant) {
  return getAdminPhones(business, tenant)[0] || null;
}

/** True if senderPhone matches ANY configured admin number for this business/tenant. */
export function isAdminPhoneMatch(senderPhone, business, tenant) {
  const norm = normalizeDigits(senderPhone);
  if (!norm) return false;
  return getAdminPhones(business, tenant).some((p) => normalizeDigits(p) === norm);
}
