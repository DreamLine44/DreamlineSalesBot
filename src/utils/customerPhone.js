/**
 * Canonical WhatsApp customer phone normalization.
 * Store and query using digits-only; tolerate + prefix variants at lookup time.
 */

/** Digits-only canonical form (e.g. 2203532423). */
export function normalizeCustomerPhone(phone) {
  if (phone == null || phone === '') return '';
  return String(phone).replace(/\D/g, '');
}

/** Lookup variants for legacy rows saved with + prefix or mixed formatting. */
export function customerPhoneQueryVariants(phone) {
  const norm = normalizeCustomerPhone(phone);
  if (!norm) return [];
  const variants = new Set([norm, `+${norm}`]);
  return [...variants];
}

/** Canonical phone for session read/write — matches webhook `from` when normalized. */
export function resolveSessionPhone(session, fallbackPhone) {
  const raw = session?.customerPhone || session?.phone?.split('_')?.[0] || fallbackPhone;
  return normalizeCustomerPhone(raw);
}
