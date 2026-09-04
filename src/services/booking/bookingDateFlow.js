/**
 * bookingDateFlow.js
 *
 * WhatsApp Flow calendar date picker (Option B) — one tap opens a full calendar
 * inside WhatsApp. Requires a published Flow ID (Meta Business Manager).
 */

import crypto from 'crypto';
import {
  getLocalNow,
  resolveBookingDateInput,
  MAX_BOOKING_MONTHS_AHEAD,
} from '../../core/nlu/resolution/bookingDateParser.js';

export const BOOKING_DATE_FLOW_SCREEN = 'BOOKING_DATE';

/** Resolve Flow ID: per-business config → tenant → env fallback. */
export const resolveBookingDateFlowId = (business, tenant) => {
  return (
    business?.whatsappFlows?.bookingDateFlowId?.trim() ||
    tenant?.whatsapp?.bookingDateFlowId?.trim() ||
    process.env.BOOKING_DATE_FLOW_ID?.trim() ||
    null
  );
}

/** Flow calendar is opt-in — default is the standard list + typed-date picker. */
export const shouldUseBookingDateFlow = (business, tenant) => {
  if (process.env.BOOKING_DATE_FLOW_ENABLED !== 'true') return false;
  return Boolean(resolveBookingDateFlowId(business, tenant));
}

export const isBookingDateFlowConfigured = (business, tenant) => {
  return shouldUseBookingDateFlow(business, tenant);
}

/** YYYY-MM-DD bounds for Flow DatePicker (v5.0+). */
export const getBookingDateFlowBounds = (tz = 'UTC') => {
  const now = getLocalNow(tz);
  const min = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const max = new Date(min);
  max.setUTCMonth(max.getUTCMonth() + MAX_BOOKING_MONTHS_AHEAD);

  const fmt = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  return { min_date: fmt(min), max_date: fmt(max) };
}

export const buildBookingDateFlowToken = (customerPhone) => {
  const safe = String(customerPhone || 'guest').replace(/\W/g, '').slice(-12);
  return `bkdt_${safe}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Build interactive Flow message UI for dispatcher.
 * Opens a calendar grid when the customer taps the CTA button.
 */
export const buildBookingDateFlowMessage = ({
  heading = null,
  tz = 'UTC',
  flowId,
  customerPhone,
  flowToken = null,
} = {}) => {
  if (!flowId) return null;

  const bounds = getBookingDateFlowBounds(tz);
  const body = heading
    ? `${heading}\n\nPlease select your preferred date.`
    : `What date would you like? 📅\n\nPlease select your preferred date.`;

  const draftMode = process.env.BOOKING_DATE_FLOW_DRAFT === 'true';

  return {
    type:       'flow',
    body,
    header:     '📅 Choose date',
    flowId:     String(flowId),
    flowToken:  flowToken || buildBookingDateFlowToken(customerPhone),
    flowCta:    '📅 Pick date',
    flowScreen: BOOKING_DATE_FLOW_SCREEN,
    flowData:   bounds,
    ...(draftMode ? { flowMode: 'draft' } : {}),
  };
}

/** Parse nfm_reply payload from WhatsApp Flow completion. */
export const parseBookingDateFlowReply = (flowReply) => {
  if (!flowReply || typeof flowReply !== 'object') return null;
  const iso = flowReply.booking_date || flowReply.date;
  if (!iso) return null;
  return String(iso).trim();
}

/**
 * Turn Flow YYYY-MM-DD into the same resolved shape as typed date input.
 */
export async function resolveFlowBookingDate(isoDate, tz = 'UTC') {
  const iso = String(isoDate || '').trim();
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    return { ok: false, error: 'invalid', message: `Invalid date from calendar: *${iso}*` };
  }

  const parsed = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  const human = `${parsed.getUTCDate()} ${parsed.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })} ${parsed.getUTCFullYear()}`;

  return resolveBookingDateInput(human, tz);
}
