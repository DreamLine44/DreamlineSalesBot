/**
 * Recover in-progress booking when a flow-internal list/button tap arrives
 * but session.currentFlow was lost (TTL, admin action, post-flow reset, etc.).
 * Without this, PARTY_* / TIME_* taps map to CONTINUE_FLOW and dump the
 * customer on the welcome menu mid-booking.
 */

import { advance } from './flowEngine.js';
import { getSession, updateSession } from '../sessions/sessionService.js';

const BOOKING_PARTY_RE = /^PARTY_\d+$/;
const BOOKING_TIME_RE  = /^TIME_(M_\d+|\d+(AM|PM))$/;
const BOOKING_DATE_RE  = /^DATE_/;

export function isBookingPassthroughRecoveryId(id) {
  const upper = String(id || '').trim().toUpperCase();
  return BOOKING_PARTY_RE.test(upper) || BOOKING_TIME_RE.test(upper) || BOOKING_DATE_RE.test(upper);
}

async function cancelLatestBookingForReschedule(customerPhone, tenantId) {
  try {
    const { default: Booking } = await import('../models/Booking.js');
    return Booking.findOneAndUpdate(
      {
        customerPhone,
        tenantId,
        status:      { $in: ['pending', 'confirmed'] },
        bookingType: { $ne: 'walkin' },
      },
      { $set: { status: 'cancelled', cancelledBy: 'customer', cancelledAt: new Date() } },
      { sort: { createdAt: -1 } },
    ).catch(() => null);
  } catch {
    return null;
  }
}

export async function recoverLostBookingPassthrough({
  from, tenantId, session, messageText, business, tenant, isInteractive,
}) {
  const upper = String(messageText || '').trim().toUpperCase();
  const raw = String(messageText || '').trim();
  const isPassthroughId = isBookingPassthroughRecoveryId(upper);

  let isTypedDate = false;
  if (!isPassthroughId && !isInteractive && raw) {
    const { looksLikeDate } = await import('../services/bookingDateParser.js');
    if (looksLikeDate(raw)) {
      const { default: Booking } = await import('../models/Booking.js');
      const active = await Booking.findOne({
        customerPhone: from,
        tenantId,
        status:        { $in: ['pending', 'confirmed'] },
        bookingType:   { $ne: 'walkin' },
      }).sort({ createdAt: -1 }).lean().catch(() => null);
      isTypedDate = !!active;
    }
  }

  if (!isPassthroughId && !isTypedDate) return null;

  const { default: Booking } = await import('../models/Booking.js');
  const activeBooking = await Booking.findOne({
    customerPhone: from,
    tenantId,
    status:        { $in: ['pending', 'confirmed'] },
    bookingType:   { $ne: 'walkin' },
  }).sort({ createdAt: -1 }).lean().catch(() => null);
  if (activeBooking) await cancelLatestBookingForReschedule(from, tenantId);

  const data = {
    ...(session?.data || {}),
    ...(activeBooking?.service ? { service: activeBooking.service } : {}),
    ...(activeBooking?.partySize ? { partySize: activeBooking.partySize } : {}),
    ...(activeBooking?.staff ? { stylist: activeBooking.staff, staff: activeBooking.staff } : {}),
  };
  let step = 'DATE';

  if (BOOKING_PARTY_RE.test(upper)) {
    step = 'PARTY_SIZE';
  } else if (BOOKING_TIME_RE.test(upper)) {
    step = (data.date || data.parsedDate) ? 'TIME' : 'DATE';
  } else if (BOOKING_DATE_RE.test(upper) || isTypedDate) {
    step = 'DATE';
  }

  await updateSession(from, tenantId, {
    currentFlow: 'BOOKING',
    step,
    data,
    postFlowAck: null,
    postFlowData: null,
  });
  const fresh = await getSession(from, tenantId) || session;

  return advance({
    session: { ...fresh, currentFlow: 'BOOKING', step, data },
    message: messageText,
    business,
    tenant,
    isInteractive,
  });
}
