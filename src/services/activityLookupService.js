/**
 * activityLookupService.js
 *
 * Reference-first activity lookup for orders and bookings.
 * Used by status tracking, Q&A mode, and admin commands.
 */

import Order from '../models/Order.js';
import Booking from '../models/Booking.js';
import { resolveActiveOrder } from './activeOrderResolver.js';
import { getActiveBookings, getBookingByShortId } from './bookingService.js';
import { customerPhoneQueryVariants } from '../utils/customerPhone.js';

const SHORT_ID_RE = /#?([A-Z0-9]{4,24})\b/i;

/** Words that must never be parsed as activity reference IDs. */
const RESERVED_REF_WORDS = new Set([
  'CANCEL', 'ORDER', 'BOOKING', 'BOOK', 'STATUS', 'TRACK', 'REF', 'ACTIVITY', 'ALL',
]);

/** Extract a shortId from customer or admin text (#F921EB or F921EB). */
export function extractShortId(message, session = null) {
  const raw = String(message || '').trim();
  if (!raw) return null;

  // Real order/payment references are DSB-MMDD-XXXXXX (e.g. DSB-0818-782DF2).
  // Earlier logic matched the middle numeric segment (0818) because it is the
  // first 4-digit alphanumeric token in the string. Always prefer the last
  // segment after the date prefix when a DSB reference is present.
  const paymentRefMatch = raw.match(/\bDSB[-\s]*\d{2,8}[-\s]*([A-Z0-9]{4,24})\b/i);
  if (paymentRefMatch) return paymentRefMatch[1].toUpperCase();

  const hashMatch = raw.match(/#\s*([A-Z0-9]{4,24})\b/i);
  if (hashMatch) return hashMatch[1].toUpperCase();

  const explicit = raw.match(/\b(?:order|booking|ref(?:erence)?|activity)\s*#?\s*([A-Z0-9]{4,24})\b/i);
  if (explicit) return explicit[1].toUpperCase();

  const bare = raw.match(SHORT_ID_RE);
  if (bare && /\b(track|status|cancel|order|booking|ref)\b/i.test(raw)) {
    const candidate = bare[1].toUpperCase();
    if (!RESERVED_REF_WORDS.has(candidate)) return candidate;
  }

  // Bare ref reply while in tracking context (e.g. customer sends "F921EB" after prompt).
  const ctx = session?.data?._questionCtx;
  if (ctx?.lastTopic?.includes('TRACKING') && /^[A-Z0-9]{4,24}$/i.test(raw)) {
    return raw.toUpperCase();
  }

  return null;
}

export function isValidShortIdFormat(shortId) {
  return Boolean(shortId && /^[A-Z0-9]{4,24}$/.test(String(shortId).toUpperCase()));
}

/** Lookup order by shortId within tenant. */
export async function getOrderByShortId(shortId, tenantId) {
  if (!shortId || !tenantId) return null;
  return Order.findOne({ shortId: String(shortId).toUpperCase(), tenantId }).lean();
}

/**
 * Search for an activity by reference with phone-based recovery.
 * @returns {{ order, booking, checks: string[], scope: 'ORDER'|'BOOKING'|'BOTH' }}
 */
export async function lookupActivityByReference({
  shortId,
  tenantId,
  customerPhone = null,
  scope = 'BOTH',
}) {
  const checks = [];
  const ref = String(shortId || '').toUpperCase();
  let order = null;
  let booking = null;

  if (!isValidShortIdFormat(ref)) {
    return { order: null, booking: null, checks: ['invalid reference format'], scope };
  }

  if (scope === 'ORDER' || scope === 'BOTH') {
    order = await getOrderByShortId(ref, tenantId).catch(() => null);
    checks.push(order ? 'order by reference' : 'order reference (not found)');
  }

  if (scope === 'BOOKING' || scope === 'BOTH') {
    booking = await getBookingByShortId(ref, tenantId).catch(() => null);
    checks.push(booking ? 'booking by reference' : 'booking reference (not found)');
  }

  if (customerPhone && !order && (scope === 'ORDER' || scope === 'BOTH')) {
    const phoneOrders = await Order.find({
      customerPhone,
      tenantId,
      shortId: ref,
    }).limit(1).lean().catch(() => []);
    if (phoneOrders[0]) {
      order = phoneOrders[0];
      checks.push('order by reference + phone');
    }
  }

  if (customerPhone && !booking && (scope === 'BOOKING' || scope === 'BOTH')) {
    const variants = customerPhoneQueryVariants(customerPhone);
    const phoneClause = variants.length > 1
      ? { customerPhone: { $in: variants } }
      : { customerPhone: variants[0] || customerPhone };
    const phoneBooking = await Booking.findOne({
      ...phoneClause,
      tenantId,
      shortId: ref,
    }).lean().catch(() => null);
    if (phoneBooking) {
      booking = phoneBooking;
      checks.push('booking by reference + phone');
    }
  }

  return { order, booking, checks, scope };
}

/**
 * Broader recovery when reference lookup fails — recent phone-scoped activities.
 */
export async function recoverRecentActivities({ customerPhone, tenantId, scope = 'BOTH' }) {
  const checks = [];
  let orderResolution = null;
  let bookings = [];

  if (customerPhone && (scope === 'ORDER' || scope === 'BOTH')) {
    orderResolution = await resolveActiveOrder(customerPhone, tenantId, null, null).catch(() => null);
    checks.push('active orders by phone');
    if (!orderResolution?.order) {
      const recent = await Order.find({ customerPhone, tenantId })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean()
        .catch(() => []);
      if (recent.length) checks.push(`recent orders (${recent.length})`);
    }
  }

  if (customerPhone && (scope === 'BOOKING' || scope === 'BOTH')) {
    bookings = await getActiveBookings(customerPhone, tenantId).catch(() => []);
    checks.push('active bookings by phone');
  }

  return { orderResolution, recentOrders: [], bookings, checks };
}

/** Build a human-readable summary of lookup attempts. */
export function formatLookupFailureMessage({ shortId, checks = [], adminPhone = null }) {
  const ref = shortId ? `#${shortId}` : 'that reference';
  const checked = checks.length
    ? checks.join(', ')
    : 'your active and previous activities';
  let body =
    `I couldn't find an activity with reference *${ref}*. ` +
    `I checked ${checked} but couldn't locate it.\n\n` +
    `Please verify the reference or send another one if available.`;
  if (adminPhone) body += `\n\n_Need help?_ 📞 *${adminPhone}*`;
  return body;
}
