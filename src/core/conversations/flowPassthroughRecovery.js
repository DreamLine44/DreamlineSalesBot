/**
 * Recover in-progress booking when a flow-internal list/button tap arrives
 * but session.currentFlow was lost (TTL, admin action, post-flow reset, etc.).
 * Without this, PARTY_* / TIME_* taps map to CONTINUE_FLOW and dump the
 * customer on the welcome menu mid-booking.
 */

import { advance } from './flowEngine.js';
import { getSession, updateSession } from '../sessions/sessionService.js';
import { parsePartySizeFromText } from '../../utils/parsePartySize.js';
import { looksLikeDate } from '../../services/bookingDateParser.js';
import { buildActiveBookingFilter } from '../../services/activityLifecycleService.js';
import { bookingDateIsoFromParsed } from '../../services/bookingState.js';
import { looksLikeBookingTime } from '../../utils/parseBookingTime.js';

const BOOKING_PARTY_RE = /^PARTY_\d+$/;
const BOOKING_TIME_RE  = /^TIME_(M_\d+|\d+(AM|PM))$/;
const BOOKING_DATE_RE  = /^DATE_/;

const PARTY_SIZE_PROMPT_RE = /\b(how many guests|number of guests|guests will be dining)\b/i;
const DATE_PROMPT_RE = /\b(what date|choose a date|did you mean|date would you like|select a date|pick a date)\b/i;
const TIME_PROMPT_RE = /\b(what time|choose a time|confirm time|time works for you)\b/i;

const BOOKING_DATE_STEPS = new Set(['DATE', 'DATE_CONFIRM', 'DATE_MONTH', 'DATE_DAY']);
const BOOKING_TIME_STEPS = new Set(['TIME', 'TIME_CONFIRM']);

export function isBookingPassthroughRecoveryId(id) {
  const upper = String(id || '').trim().toUpperCase();
  return BOOKING_PARTY_RE.test(upper) || BOOKING_TIME_RE.test(upper) || BOOKING_DATE_RE.test(upper);
}

function isRestaurantMode(business) {
  return (business?.businessMode || '').toUpperCase() === 'RESTAURANT';
}

function hasPartySizePromptContext(session) {
  if ((session?.step || '').toUpperCase() === 'PARTY_SIZE') return true;
  return PARTY_SIZE_PROMPT_RE.test(String(session?.lastBotMessage || ''));
}

/** Typed guest count after a party-size prompt (or orphaned PARTY_SIZE step). */
export function isTypedPartySizeRecoveryInput(messageText, session, business) {
  const raw = String(messageText || '').trim();
  if (!raw || !isRestaurantMode(business)) return false;
  if (!hasPartySizePromptContext(session)) return false;

  const partySize = parsePartySizeFromText(raw);
  return !!(partySize && partySize >= 1 && partySize <= 50);
}

/** Typed date after a booking date prompt — works even for first-time bookers. */
export function isTypedBookingDateRecoveryInput(messageText, session, business) {
  const raw = String(messageText || '').trim();
  if (!raw || !looksLikeDate(raw)) return false;
  if (!isRestaurantMode(business)) return false;

  const step = (session?.step || '').toUpperCase();
  if (BOOKING_DATE_STEPS.has(step)) return true;

  const lastBot = String(session?.lastBotMessage || '');
  if (DATE_PROMPT_RE.test(lastBot)) return true;

  const data = session?.data || {};
  if (data.partySize && DATE_PROMPT_RE.test(lastBot)) return true;

  return false;
}

/** Typed time after a booking time prompt when session was lost. */
export function isTypedBookingTimeRecoveryInput(messageText, session, business) {
  const raw = String(messageText || '').trim();
  if (!raw || !isRestaurantMode(business)) return false;

  const step = (session?.step || '').toUpperCase();
  if (BOOKING_TIME_STEPS.has(step)) return looksLikeBookingTime(raw);

  const lastBot = String(session?.lastBotMessage || '');
  if (!TIME_PROMPT_RE.test(lastBot)) return false;

  return looksLikeBookingTime(raw);
}

export function shouldRecoverLostBookingPassthrough({
  messageText, session, business, isInteractive,
}) {
  const upper = String(messageText || '').trim().toUpperCase();
  const raw = String(messageText || '').trim();
  if (!raw) return false;

  if (isInteractive && isBookingPassthroughRecoveryId(upper)) return true;
  if (isInteractive) return false;

  return isTypedPartySizeRecoveryInput(raw, session, business)
    || isTypedBookingDateRecoveryInput(raw, session, business)
    || isTypedBookingTimeRecoveryInput(raw, session, business);
}

async function findLatestActiveBooking(customerPhone, tenantId) {
  const { default: Booking } = await import('../../models/Booking.js');
  return Booking.findOne(buildActiveBookingFilter(customerPhone, tenantId))
    .sort({ createdAt: -1 })
    .lean()
    .catch(() => null);
}

function mergeActiveBookingFields(data, activeBooking) {
  if (!activeBooking) return data;
  const merged = { ...data };
  if (activeBooking.service && !merged.service) merged.service = activeBooking.service;
  if (activeBooking.partySize && !merged.partySize) merged.partySize = activeBooking.partySize;
  if (activeBooking.staff && !merged.staff) {
    merged.staff = activeBooking.staff;
    merged.stylist = activeBooking.staff;
  }
  if (activeBooking.date && !merged.date) merged.date = activeBooking.date;
  if (activeBooking.time && !merged.time) merged.time = activeBooking.time;
  if (activeBooking.parsedDate && !merged.parsedDate) {
    merged.parsedDate = activeBooking.parsedDate;
    merged.bookingDateIso = bookingDateIsoFromParsed(activeBooking.parsedDate);
  }
  return merged;
}

export async function recoverLostBookingPassthrough({
  from, tenantId, session, messageText, business, tenant, isInteractive,
}) {
  const upper = String(messageText || '').trim().toUpperCase();
  const raw = String(messageText || '').trim();
  const isPassthroughId = isBookingPassthroughRecoveryId(upper);

  const isTypedPartySize = !isPassthroughId && !isInteractive
    && isTypedPartySizeRecoveryInput(raw, session, business);
  const isTypedDate = !isPassthroughId && !isInteractive
    && isTypedBookingDateRecoveryInput(raw, session, business);
  const isTypedTime = !isPassthroughId && !isInteractive
    && isTypedBookingTimeRecoveryInput(raw, session, business);

  if (!isPassthroughId && !isTypedDate && !isTypedPartySize && !isTypedTime) return null;

  const activeBooking = isTypedPartySize
    ? null
    : await findLatestActiveBooking(from, tenantId);
  // Do not auto-cancel an active booking here — recovery only restores UI state.
  // Explicit RESCHEDULE / cancel handlers own booking cancellation.

  const data = mergeActiveBookingFields(session?.data || {}, activeBooking);
  let step = 'DATE';

  if (BOOKING_PARTY_RE.test(upper) || isTypedPartySize) {
    step = 'PARTY_SIZE';
  } else if (BOOKING_TIME_RE.test(upper) || isTypedTime) {
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
