/**
 * parseBookingTime.js — natural time parsing for booking (extends bare HH:MM / am-pm).
 */

import { parseQuantity } from './parseQuantity.js';

function formatMinutesAsLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${period}` : `${h12}:00 ${period}`;
}

function applyMeridiem(hour, meridiem) {
  let h = hour;
  const m = (meridiem || '').toLowerCase();
  if (m === 'pm' && h < 12) h += 12;
  if (m === 'am' && h === 12) h = 0;
  if (h > 23) return null;
  return h * 60 + (m ? 0 : 0);
}

function inferMeridiemFromContext(hour, context) {
  const c = String(context || '').toLowerCase();
  if (/\bmorning|breakfast\b/.test(c)) return 'am';
  if (/\b(?:evening|night|tonight|dinner|afternoon|lunch|pm)\b/.test(c)) return 'pm';
  if (hour >= 7 && hour <= 11) return 'pm';
  if (hour >= 1 && hour <= 6) return 'pm';
  if (hour === 12) return 'pm';
  return 'pm';
}

/**
 * parseBookingTimeToMinutes — minutes since midnight, or null.
 */
export function parseBookingTimeToMinutes(timeStr, { context = '' } = {}) {
  if (!timeStr) return null;
  const s = String(timeStr).trim().toLowerCase();
  const ctx = `${context} ${s}`;

  if (s === 'noon' || s === 'midday') return 12 * 60;
  if (s === 'midnight') return 0;

  const hhmm = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (hhmm) {
    let h = parseInt(hhmm[1], 10);
    const mins = parseInt(hhmm[2], 10);
    const meridiem = hhmm[3] || inferMeridiemFromContext(h, ctx);
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    if (h > 23 || mins > 59) return null;
    return h * 60 + mins;
  }

  const ham = s.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (ham) {
    return applyMeridiem(parseInt(ham[1], 10), ham[2]);
  }

  const oclock = s.match(/^(\d{1,2})\s*o'?clock\s*(?:in the )?(morning|afternoon|evening|night|tonight)?$/i);
  if (oclock) {
    const h = parseInt(oclock[1], 10);
    const meridiem = oclock[2] || inferMeridiemFromContext(h, ctx);
    return applyMeridiem(h, meridiem);
  }

  const contextual = s.match(/^(\d{1,2})\s*(?:in the )?(morning|afternoon|evening|night|tonight)$/i)
    || s.match(/^(\d{1,2})\s+(morning|afternoon|evening|night|tonight)$/i);
  if (contextual) {
    const h = parseInt(contextual[1], 10);
    const meridiem = inferMeridiemFromContext(h, contextual[2] || ctx);
    return applyMeridiem(h, meridiem);
  }

  const bare = s.match(/^(\d{1,2})$/);
  if (bare) {
    const h = parseInt(bare[1], 10);
    if (h > 23) return null;
    return applyMeridiem(h, inferMeridiemFromContext(h, ctx));
  }

  return null;
}

export function looksLikeBookingTime(input) {
  if (!input) return false;
  const s = String(input).trim();
  const stripped = s.replace(/^(?:around|about|at)\s+/i, '').trim();
  if (/^(noon|midday|midnight)$/i.test(stripped)) return true;
  if (/^(\d{1,2})(:\d{2})?\s*(am|pm)?$/i.test(stripped)) return true;
  if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(stripped)) return true;
  if (/^\d{1,2}\s*o'?clock/i.test(stripped)) return true;
  if (/^\d{1,2}\s*(?:in the )?(morning|afternoon|evening|night|tonight)$/i.test(stripped)) return true;
  if (parseBookingTimeToMinutes(stripped) !== null) return true;
  return false;
}

export function resolveBookingTimeInput(raw, { context = '' } = {}) {
  let s = String(raw || '').trim();
  s = s.replace(/^(?:actually|make it|change(?: it)? to|i meant|instead|no,?|around|about)\s+/i, '').trim();
  const minutes = parseBookingTimeToMinutes(s, { context: `${context} ${raw}` });
  if (minutes === null) return null;
  return { minutes, label: formatMinutesAsLabel(minutes), raw: s };
}

/** Pull a time phrase from a longer booking message. */
export function extractBookingTimeFromText(text) {
  const raw = String(text || '');
  const patterns = [
    /\b(at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
    /\b(at\s+|around\s+|about\s+)?(\d{1,2})\s*o'?clock\s*(?:in the )?(morning|afternoon|evening|night|tonight)?\b/i,
    /\b(at\s+|around\s+|about\s+)?(\d{1,2})\s+(?:in the )?(morning|afternoon|evening|night|tonight)\b/i,
    /\b(at\s+|around\s+|about\s+)?(\d{1,2}:\d{2})\b/,
    /\b(at\s+|around\s+|about\s+)?(noon|midday|midnight)\b/i,
    /\b(at\s+|around\s+|about\s+)(\d{1,2})(?!\s*(?:people|guests|persons|pax|of us))\b/i,
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    const phrase = (m[2] || m[1] || m[0]).trim();
    const resolved = resolveBookingTimeInput(phrase, { context: raw });
    if (resolved) return resolved;
  }
  return null;
}

export { formatMinutesAsLabel };
