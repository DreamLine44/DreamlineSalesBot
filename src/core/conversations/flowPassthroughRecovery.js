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
import { normalizeCustomerPhone } from '../../utils/customerPhone.js';

const BOOKING_PARTY_RE = /^PARTY_\d+$/;
const BOOKING_TIME_RE  = /^TIME_(M_\d+|\d+(AM|PM))$/;
const BOOKING_DATE_RE  = /^DATE_/;
const BOOKING_BUTTON_IDS = new Set(['CONFIRM', 'DATE_BACK', 'TIME_BACK']);

const ORDER_SUMMARY_PROMPT_RE = /\b(order summary|confirm this order|would you like to confirm)\b/i;
const ORDER_CONFIRM_BUTTON_IDS = new Set(['CONFIRM', 'ADD_MORE_ITEMS', 'ADD_ANOTHER_ITEM', 'EDIT_CART']);
const ORDER_ACTIVE_STEPS = new Set([
  'CONFIRM', 'ITEM_ADDED', 'EDIT_CART_MENU', 'EDIT_CART_PICK', 'QUANTITY', 'SUGGESTION_CONFIRM',
]);

const PARTY_SIZE_PROMPT_RE = /\b(how many guests|number of guests|guests will be dining)\b/i;
const DATE_PROMPT_RE = /\b(what date|choose a date|did you mean|date would you like|select a date|pick a date)\b/i;
const TIME_PROMPT_RE = /\b(what time|choose a time|confirm time|time works for you)\b/i;
const DATE_CONFIRM_PROMPT_RE = /\b(just to confirm|did you mean)\b/i;
const TIME_CONFIRM_PROMPT_RE = /\bconfirm time\b/i;
const BOOKING_SUMMARY_PROMPT_RE = /\b(booking summary|shall we confirm)\b/i;

const BOOKING_DATE_STEPS = new Set(['DATE', 'DATE_CONFIRM', 'DATE_MONTH', 'DATE_DAY']);
const BOOKING_TIME_STEPS = new Set(['TIME', 'TIME_CONFIRM']);
const BOOKING_ACTIVE_STEPS = new Set([
  'PARTY_SIZE', 'DATE', 'DATE_CONFIRM', 'DATE_MONTH', 'DATE_DAY', 'TIME', 'TIME_CONFIRM', 'BOOKING_CONFIRM',
]);

export function isBookingPassthroughRecoveryId(id) {
  const upper = String(id || '').trim().toUpperCase();
  return BOOKING_PARTY_RE.test(upper) || BOOKING_TIME_RE.test(upper) || BOOKING_DATE_RE.test(upper);
}

function isRestaurantMode(business) {
  return (business?.businessMode || '').toUpperCase() === 'RESTAURANT';
}

function hasBookingDataInSession(session) {
  const data = session?.data || {};
  return !!(data.partySize || data.date || data.parsedDate || data.bookingDateIso || data.time);
}

function hasPartySizePromptContext(session) {
  if ((session?.step || '').toUpperCase() === 'PARTY_SIZE') return true;
  return PARTY_SIZE_PROMPT_RE.test(String(session?.lastBotMessage || ''));
}

function hasCartInSession(session) {
  const cart = session?.data?.cart;
  return Array.isArray(cart) && cart.length > 0;
}

/** CONFIRM / add-more / edit-cart after an order summary when flow was lost. */
export function isOrderButtonRecoveryInput(messageText, session) {
  const upper = String(messageText || '').trim().toUpperCase();
  if (!ORDER_CONFIRM_BUTTON_IDS.has(upper)) return false;

  const lastBot = String(session?.lastBotMessage || '');
  if (ORDER_SUMMARY_PROMPT_RE.test(lastBot)) return true;
  if (hasCartInSession(session)) return true;

  const step = (session?.step || '').toUpperCase();
  return ORDER_ACTIVE_STEPS.has(step);
}

function inferOrderStepFromContext(session) {
  const step = (session?.step || '').toUpperCase();
  if (ORDER_ACTIVE_STEPS.has(step)) return step;
  if (ORDER_SUMMARY_PROMPT_RE.test(String(session?.lastBotMessage || ''))) return 'CONFIRM';
  if (hasCartInSession(session)) return 'CONFIRM';
  return 'CONFIRM';
}

/** CONFIRM / DATE_BACK / TIME_BACK after a booking prompt when flow was lost. */
export function isBookingButtonRecoveryInput(messageText, session, business) {
  if (!isRestaurantMode(business)) return false;
  const upper = String(messageText || '').trim().toUpperCase();
  if (!BOOKING_BUTTON_IDS.has(upper)) return false;

  const lastBot = String(session?.lastBotMessage || '');
  // Order summary also uses a CONFIRM button — do not hijack into booking recovery.
  if (ORDER_SUMMARY_PROMPT_RE.test(lastBot)) return false;
  if (hasCartInSession(session) && !hasBookingDataInSession(session)) return false;

  if (DATE_CONFIRM_PROMPT_RE.test(lastBot)) return true;
  if (TIME_CONFIRM_PROMPT_RE.test(lastBot)) return true;
  if (BOOKING_SUMMARY_PROMPT_RE.test(lastBot)) return true;
  if (hasBookingDataInSession(session)) return true;

  const step = (session?.step || '').toUpperCase();
  return BOOKING_ACTIVE_STEPS.has(step);
}

function inferBookingStepFromContext(session) {
  const step = (session?.step || '').toUpperCase();
  if (BOOKING_ACTIVE_STEPS.has(step)) return step;

  const lastBot = String(session?.lastBotMessage || '');
  if (TIME_CONFIRM_PROMPT_RE.test(lastBot)) return 'TIME_CONFIRM';
  if (BOOKING_SUMMARY_PROMPT_RE.test(lastBot)) return 'BOOKING_CONFIRM';
  if (DATE_CONFIRM_PROMPT_RE.test(lastBot)) return 'DATE_CONFIRM';

  const data = session?.data || {};
  if (data.time && (data.date || data.parsedDate)) return 'TIME_CONFIRM';
  if (data.date || data.parsedDate) return 'DATE_CONFIRM';
  if (data.partySize) return 'DATE';
  return 'PARTY_SIZE';
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

export function shouldRecoverLostOrderPassthrough({
  messageText, session, isInteractive,
}) {
  const raw = String(messageText || '').trim();
  if (!raw || !isInteractive) return false;
  return isOrderButtonRecoveryInput(raw, session);
}

export function shouldRecoverLostBookingPassthrough({
  messageText, session, business, isInteractive,
}) {
  const upper = String(messageText || '').trim().toUpperCase();
  const raw = String(messageText || '').trim();
  if (!raw) return false;

  if (isInteractive && isBookingPassthroughRecoveryId(upper)) return true;
  if (isInteractive && isBookingButtonRecoveryInput(raw, session, business)) return true;
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
  const phone = normalizeCustomerPhone(from);
  const upper = String(messageText || '').trim().toUpperCase();
  const raw = String(messageText || '').trim();
  const isPassthroughId = isBookingPassthroughRecoveryId(upper);

  const isBookingButton = isInteractive && isBookingButtonRecoveryInput(raw, session, business);
  const isTypedPartySize = !isPassthroughId && !isInteractive
    && isTypedPartySizeRecoveryInput(raw, session, business);
  const isTypedDate = !isPassthroughId && !isInteractive
    && isTypedBookingDateRecoveryInput(raw, session, business);
  const isTypedTime = !isPassthroughId && !isInteractive
    && isTypedBookingTimeRecoveryInput(raw, session, business);

  if (!isPassthroughId && !isTypedDate && !isTypedPartySize && !isTypedTime && !isBookingButton) {
    return null;
  }

  // Merge booking fields from the canonical session row (phone variants may have
  // split state across legacy +220… vs 220… keys before normalization).
  const canonicalSession = await getSession(phone, tenantId).catch(() => null);
  const mergedSession = {
    ...(session || {}),
    ...(canonicalSession && typeof canonicalSession.toObject === 'function'
      ? canonicalSession.toObject()
      : canonicalSession),
    lastBotMessage: session?.lastBotMessage || canonicalSession?.lastBotMessage,
    data: { ...(canonicalSession?.data || {}), ...(session?.data || {}) },
  };

  const activeBooking = (isTypedPartySize || isBookingButton)
    ? null
    : await findLatestActiveBooking(phone, tenantId);
  // Do not auto-cancel an active booking here — recovery only restores UI state.
  // Explicit RESCHEDULE / cancel handlers own booking cancellation.

  const data = mergeActiveBookingFields(mergedSession?.data || {}, activeBooking);
  let step = 'DATE';

  if (isBookingButton) {
    step = inferBookingStepFromContext(mergedSession);
  } else if (BOOKING_PARTY_RE.test(upper) || isTypedPartySize) {
    step = 'PARTY_SIZE';
  } else if (BOOKING_TIME_RE.test(upper) || isTypedTime) {
    step = (data.date || data.parsedDate) ? 'TIME' : 'DATE';
  } else if (BOOKING_DATE_RE.test(upper) || isTypedDate) {
    step = 'DATE';
  }

  await updateSession(phone, tenantId, {
    currentFlow: 'BOOKING',
    step,
    data,
    postFlowAck: null,
    postFlowData: null,
  });
  const fresh = await getSession(phone, tenantId) || session;

  return advance({
    session: { ...fresh, customerPhone: phone, tenantId, currentFlow: 'BOOKING', step, data },
    message: messageText,
    business,
    tenant,
    isInteractive,
  });
}

export async function recoverLostOrderPassthrough({
  from, tenantId, session, messageText, business, tenant, isInteractive,
}) {
  const phone = normalizeCustomerPhone(from);
  const raw = String(messageText || '').trim();

  if (!isInteractive || !isOrderButtonRecoveryInput(raw, session)) {
    return null;
  }

  const canonicalSession = await getSession(phone, tenantId).catch(() => null);
  const mergedSession = {
    ...(session || {}),
    ...(canonicalSession && typeof canonicalSession.toObject === 'function'
      ? canonicalSession.toObject()
      : canonicalSession),
    lastBotMessage: session?.lastBotMessage || canonicalSession?.lastBotMessage,
    data: { ...(canonicalSession?.data || {}), ...(session?.data || {}) },
  };

  const data = { ...(mergedSession?.data || {}) };
  if (!Array.isArray(data.cart) || !data.cart.length) return null;

  const step = inferOrderStepFromContext(mergedSession);

  await updateSession(phone, tenantId, {
    currentFlow: 'ORDER',
    step,
    data,
    orderChannel: data.orderChannel || 'menu',
    menuViewed:   true,
    postFlowAck:  null,
    postFlowData: null,
  });
  const fresh = await getSession(phone, tenantId) || mergedSession;

  return advance({
    session: {
      ...fresh,
      customerPhone: phone,
      tenantId,
      currentFlow:   'ORDER',
      step,
      data,
      orderChannel: data.orderChannel || 'menu',
    },
    message: messageText,
    business,
    tenant,
    isInteractive,
  });
}
