/**
 * parseBookingTime.js — natural time parsing for booking (extends bare HH:MM / am-pm).
 * Typed times must include AM/PM (or clear words like "noon", "7 tonight") to avoid confusion.
 */

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
  return h * 60;
}

function inferMeridiemFromContext(hour, context) {
  const c = String(context || '').toLowerCase();
  if (/\bmorning|breakfast\b/.test(c)) return 'am';
  if (/\b(?:evening|night|tonight|dinner|afternoon|lunch)\b/.test(c)) return 'pm';
  if (/\bpm\b/.test(c)) return 'pm';
  if (/\bam\b/.test(c)) return 'am';
  return null;
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

  const hhmm = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (hhmm) {
    let h = parseInt(hhmm[1], 10);
    const mins = parseInt(hhmm[2], 10);
    const meridiem = hhmm[3].toLowerCase();
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
    if (!meridiem) return null;
    return applyMeridiem(h, meridiem);
  }

  const contextual = s.match(/^(\d{1,2})\s*(?:in the )?(morning|afternoon|evening|night|tonight)$/i)
    || s.match(/^(\d{1,2})\s+(morning|afternoon|evening|night|tonight)$/i);
  if (contextual) {
    const h = parseInt(contextual[1], 10);
    const meridiem = inferMeridiemFromContext(h, contextual[2] || ctx);
    if (!meridiem) return null;
    return applyMeridiem(h, meridiem);
  }

  // Bare hour only when caller supplied booking/time context (e.g. "around 8" in a sentence).
  const bareHour = s.match(/^(\d{1,2})$/);
  if (bareHour && String(context || '').trim()) {
    const h = parseInt(bareHour[1], 10);
    const meridiem = inferMeridiemFromContext(h, ctx)
      || (/\b(around|about|at|book|table|reserve|dinner|lunch|tonight|time)\b/i.test(ctx) && h >= 1 && h <= 11 ? 'pm' : null);
    if (meridiem) return applyMeridiem(h, meridiem);
  }

  return null;
}

export function looksLikeBookingTime(input) {
  if (!input) return false;
  const s = String(input).trim();
  const stripped = s.replace(/^(?:around|about|at)\s+/i, '').trim();
  if (/^(noon|midday|midnight)$/i.test(stripped)) return true;
  if (/^(\d{1,2})(:\d{2})?\s*(am|pm)$/i.test(stripped)) return true;
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
    /\b(at\s+|around\s+|about\s+)?(\d{1,2}:\d{2}\s*(?:am|pm))\b/i,
    /\b(?:at|around|about)\s+(\d{1,2})(?!\s*(?:am|pm|:|\d))\b/i,
    /\b(at\s+|around\s+|about\s+)?(noon|midday|midnight)\b/i,
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
