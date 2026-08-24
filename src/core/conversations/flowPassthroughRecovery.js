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

export async function recoverLostBookingPassthrough({
  from, tenantId, session, messageText, business, tenant, isInteractive,
}) {
  const upper = String(messageText || '').trim().toUpperCase();
  if (!isBookingPassthroughRecoveryId(upper)) return null;

  const data = { ...(session?.data || {}) };
  let step = 'DATE';

  if (BOOKING_PARTY_RE.test(upper)) {
    step = 'PARTY_SIZE';
  } else if (BOOKING_TIME_RE.test(upper)) {
    step = (data.date || data.parsedDate) ? 'TIME' : 'DATE';
  } else if (BOOKING_DATE_RE.test(upper)) {
    step = 'DATE';
  }

  await updateSession(from, tenantId, { currentFlow: 'BOOKING', step, data });
  const fresh = await getSession(from, tenantId) || session;

  return advance({
    session: { ...fresh, currentFlow: 'BOOKING', step, data },
    message: messageText,
    business,
    tenant,
    isInteractive,
  });
}
