/**
 * bookingDateParser.js
 *
 * Robust booking-date parsing: deterministic NLU first, Groq AI fallback,
 * then past-date / far-future validation in the business timezone.
 */

import { parseQuantity } from '../utils/parseQuantity.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTH_MAP = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Max booking horizon — reject dates beyond this many months from today. */
export const MAX_BOOKING_MONTHS_AHEAD = 12;

export function getLocalNow(tz) {
  const safeZone = (() => {
    if (!tz) return 'UTC';
    try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; }
    catch { return 'UTC'; }
  })();

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
}

function toUtcMidnight(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}

function addLocalDays(now, n) {
  return toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n);
}

function resolveMonthToken(token) {
  if (!token) return null;
  return MONTH_MAP[String(token).toLowerCase().trim()] ?? null;
}

function parseNumericDate(raw, now) {
  const m = String(raw).trim().match(/^(\d{1,2})[\/\.\-](\d{1,2})(?:[\/\.\-](\d{2,4}))?$/);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  let year = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
  if (year < 100) year += 2000;

  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  const d = toUtcMidnight(year, month, day);
  if (d.getUTCDate() !== day || d.getUTCMonth() !== month) return null;
  return d;
}

function parseDayOfMonthInMonth(day, month, year, now) {
  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  let y = year ?? now.getUTCFullYear();
  let d = toUtcMidnight(y, month, day);
  if (d.getUTCDate() !== day) return null;

  const localMidnight = toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!year && d < localMidnight) {
    d = toUtcMidnight(y + 1, month, day);
    if (d.getUTCDate() !== day) return null;
  }
  return d;
}

function parseWeekday(lower, now) {
  const normalized = lower
    .replace(/^on\s+(?:the\s+)?/, '')
    .replace(/^this\s+/, '')
    .trim();
  const bare = normalized.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
  if (!bare) return null;

  const target = WEEKDAYS.indexOf(bare[1]);
  if (target === -1) return null;

  const todayDow = now.getUTCDay();
  const diff = (target - todayDow + 7) % 7;
  return addLocalDays(now, diff);
}

function containsWeekdayName(s) {
  return /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(String(s || ''));
}

function looksLikeNativeDateFragment(s) {
  return /\d/.test(s)
    || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s);
}

function parseOrdinalDayPhrase(lower, now) {
  const m = lower.match(/(?:on\s+the\s+|the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+(?:this\s+)?month)?$/);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const localMidnight = toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let d = toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), day);
  if (d.getUTCDate() !== day) return null;
  if (d < localMidnight) {
    d = toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, day);
    if (d.getUTCDate() !== day) return null;
  }
  return d;
}

function parseDayMonthPhrase(lower, now) {
  const dayFirst = lower.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)(?:\s+(\d{4}))?$/);
  if (dayFirst) {
    const day = parseInt(dayFirst[1], 10);
    const month = resolveMonthToken(dayFirst[2]);
    const year = dayFirst[3] ? parseInt(dayFirst[3], 10) : null;
    if (month === null) return null;
    return parseDayOfMonthInMonth(day, month, year, now);
  }

  const monthFirst = lower.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
  if (monthFirst) {
    const month = resolveMonthToken(monthFirst[1]);
    const day = parseInt(monthFirst[2], 10);
    const year = monthFirst[3] ? parseInt(monthFirst[3], 10) : null;
    if (month === null) return null;
    return parseDayOfMonthInMonth(day, month, year, now);
  }

  return null;
}

function parseRelativeOffsetDays(lower, now) {
  const inDays = lower.match(/^in\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+days?$/);
  if (inDays) {
    const n = parseQuantity(inDays[1]);
    if (n) return addLocalDays(now, n);
  }
  const inWeeks = lower.match(/^in\s+(\d+|one|two|three|four)\s+weeks?$/);
  if (inWeeks) {
    const n = parseQuantity(inWeeks[1]);
    if (n) return addLocalDays(now, n * 7);
  }
  return null;
}

function parseRelativeMonthDay(lower, now) {
  const s = lower.replace(/['']/g, '').replace(/\s+/g, ' ').trim();

  if (/^next\s+months?\s+(?:first|1st)(?:\s+day)?$/.test(s)) {
    return toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  }
  // "first day of next month" OR "first of next month" / "the first of next month"
  if (/^(?:the\s+)?(?:first|1st)(?:\s+day)?\s+of\s+next\s+month$/.test(s)) {
    return toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  }
  if (/^next\s+month(?:'?s)?\s+(?:first|1st)(?:\s+day)?$/.test(s)) {
    return toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  }
  // last day of next month
  if (/^(?:the\s+)?last\s+day\s+of\s+next\s+month$/.test(s)) {
    return toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 2, 0);
  }
  // end of (this) month
  if (/^end\s+of\s+(?:this\s+)?month$/.test(s)) {
    return toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth() + 1, 0);
  }
  // first of September / the first of September 2026
  const firstOfNamedMonth = s.match(/^(?:the\s+)?(?:first|1st)\s+of\s+([a-z]+)(?:\s+(\d{4}))?$/);
  if (firstOfNamedMonth) {
    const month = resolveMonthToken(firstOfNamedMonth[1]);
    const year = firstOfNamedMonth[2] ? parseInt(firstOfNamedMonth[2], 10) : null;
    if (month !== null) return parseDayOfMonthInMonth(1, month, year, now);
  }
  // September first / September the first
  const namedMonthFirst = s.match(/^([a-z]+)\s+(?:the\s+)?(?:first|1st)(?:\s+(\d{4}))?$/);
  if (namedMonthFirst) {
    const month = resolveMonthToken(namedMonthFirst[1]);
    const year = namedMonthFirst[2] ? parseInt(namedMonthFirst[2], 10) : null;
    if (month !== null) return parseDayOfMonthInMonth(1, month, year, now);
  }
  return null;
}

/**
 * tryParseDate — deterministic parse only (no AI).
 */
export function tryParseDate(dateStr, tz) {
  if (!dateStr) return null;
  try {
    const now = getLocalNow(tz);
    const raw = String(dateStr).trim();
    let lower = raw.toLowerCase().trim();
    if (lower.startsWith('on next ')) lower = lower.replace(/^on\s+/, '');

    if (lower === 'today' || lower === 'tonight') return toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (lower === 'yesterday') return addLocalDays(now, -1);
    if (lower === 'tomorrow') return addLocalDays(now, 1);
    if (lower === 'day after tomorrow' || lower === 'the day after tomorrow') return addLocalDays(now, 2);

    const offsetDays = parseRelativeOffsetDays(lower, now);
    if (offsetDays) return offsetDays;

    const relativeMonth = parseRelativeMonthDay(lower, now);
    if (relativeMonth) return relativeMonth;

    const weekday = parseWeekday(lower, now);
    if (weekday) return weekday;

    if (lower.startsWith('next ')) {
      const target = WEEKDAYS.indexOf(lower.replace('next ', ''));
      if (target !== -1) {
        const todayDow = now.getUTCDay();
        const diff = (target - todayDow + 7) % 7 || 7;
        return addLocalDays(now, diff);
      }
    }

    const numeric = parseNumericDate(raw, now);
    if (numeric) return numeric;

    const ordinalDay = parseOrdinalDayPhrase(lower, now);
    if (ordinalDay) return ordinalDay;

    const dayMonth = parseDayMonthPhrase(lower, now);
    if (dayMonth) return dayMonth;

    // Never let native Date mangle weekday phrases like "On Friday" → Jan 1.
    if (containsWeekdayName(lower)) return null;

    const stripped = raw.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
    const parsed = new Date(stripped);
    if (!isNaN(parsed.getTime()) && looksLikeNativeDateFragment(stripped)) {
      const yr = parsed.getFullYear();
      if (yr < now.getUTCFullYear()) {
        const withYear = `${stripped} ${now.getUTCFullYear()}`;
        const p2 = new Date(withYear);
        if (!isNaN(p2.getTime())) return toUtcMidnight(p2.getFullYear(), p2.getMonth(), p2.getDate());
      }
      if (yr > now.getUTCFullYear() + 2) {
        const withYear = `${stripped} ${now.getUTCFullYear()}`;
        const p2 = new Date(withYear);
        if (!isNaN(p2.getTime())) return toUtcMidnight(p2.getFullYear(), p2.getMonth(), p2.getDate());
      }
      return toUtcMidnight(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    }

    if (looksLikeNativeDateFragment(stripped)) {
      const withYear = `${stripped} ${now.getUTCFullYear()}`;
      const parsed2 = new Date(withYear);
      if (!isNaN(parsed2.getTime())) return toUtcMidnight(parsed2.getFullYear(), parsed2.getMonth(), parsed2.getDate());
    }

    return null;
  } catch {
    return null;
  }
}

export function looksLikeDate(input) {
  if (!input || input.length < 2) return false;
  const s = input.toLowerCase().trim();
  if (['today', 'tomorrow', 'yesterday', 'tonight'].includes(s)) return true;
  if (/^day after tomorrow$/i.test(s)) return true;
  if (/^in\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:days?|weeks?)$/i.test(s)) return true;
  if (/^(this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(s)) return true;
  if (/^on\s+(?:the\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(s)) return true;
  if (/^on\s+next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(s)) return true;
  if (/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(s)) return true;
  if (/\d{1,2}[\/\-\.]\d{1,2}([\/\-\.]\d{2,4})?/.test(s)) return true;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return true;
  if (/(?:on\s+the\s+|the\s+)?\d{1,2}(?:st|nd|rd|th)?(?:\s+of\s+(?:this\s+)?month)?$/i.test(s)) return true;
  if (/^\d{1,2}(?:st|nd|rd|th)?(\s+\w+)?$/i.test(s)) return true;
  if (/\bnext\s+month/i.test(s) && /\b(first|1st|day)\b/i.test(s)) return true;
  if (/\bfirst\s+day\s+of\s+next\s+month\b/i.test(s)) return true;
  if (/\d/.test(s) && /\b(date|month|day)\b/i.test(s)) return true;
  return false;
}

const DATE_PHRASE_RES = [
  /\b(?:today|tomorrow|yesterday|tonight)\b/i,
  /\bin\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+days?\b/i,
  /\bin\s+(?:\d+|one|two|three|four)\s+weeks?\b/i,
  /\b(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:on\s+)?next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(?:the\s+)?(?:first|1st)(?:\s+(?:day\s+of|of))?\s+next\s+month\b/i,
  /\b(?:the\s+)?last\s+day\s+of\s+next\s+month\b/i,
  /\bend\s+of\s+(?:this\s+)?month\b/i,
  /\bday after tomorrow\b/i,
  /\b(?:the\s+)?(?:first|1st)\s+of\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
  /\bnext\s+month(?:'?s)?\s+(?:first|1st)(?:\s+day)?\b/i,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?\b/i,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?\b/i,
  /\b\d{1,2}[\/\-\.]\d{1,2}(?:[\/\-\.]\d{2,4})?\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
];

/** Pull a date phrase from a longer booking message. */
export function extractBookingDatePhraseFromText(text) {
  const raw = String(text || '');
  for (const re of DATE_PHRASE_RES) {
    const m = raw.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

function stripBookingCorrectionPrefix(input) {
  let s = String(input || '').trim();
  const re = /^(?:actually|make it|change(?: it)? to|i meant|instead|no,?)\s+/i;
  while (re.test(s)) s = s.replace(re, '').trim();
  return s;
}

export function formatBookingDateLabel(parsed, tz = 'UTC') {
  if (!parsed) return '';
  return parsed.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function validateBookingDate(parsed, tz) {
  if (!parsed) return { error: null, parsed: null };

  const localNow = getLocalNow(tz);
  const localMidnight = toUtcMidnight(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());

  if (parsed < localMidnight) {
    const fmt = formatBookingDateLabel(parsed, tz);
    return {
      error: `⚠️ *${fmt}* has already passed.\n\nPlease choose an *upcoming date*.\n\n(e.g. *tomorrow*, *next Friday*, *25 June*)`,
      parsed: null,
    };
  }

  const maxFuture = new Date(localMidnight);
  maxFuture.setUTCMonth(maxFuture.getUTCMonth() + MAX_BOOKING_MONTHS_AHEAD);
  if (parsed > maxFuture) {
    return {
      error: `⚠️ That date is too far ahead. We accept bookings up to *${MAX_BOOKING_MONTHS_AHEAD} months* from today.\n\n(e.g. *next week*, *25 June*)`,
      parsed: null,
    };
  }

  return { parsed, error: null };
}

function isoFromParsed(parsed) {
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const d = String(parsed.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parsedFromIso(iso) {
  const m = String(iso || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = toUtcMidnight(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  if (isoFromParsed(d) !== m[0]) return null;
  return d;
}

async function parseDateWithAI(raw, tz) {
  const now = getLocalNow(tz);
  const todayIso = isoFromParsed(toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const maxFuture = new Date(toUtcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  maxFuture.setUTCMonth(maxFuture.getUTCMonth() + MAX_BOOKING_MONTHS_AHEAD);
  const maxIso = isoFromParsed(maxFuture);

  try {
    const { parseBookingDate } = await import('../core/ai/providers/groqProvider.js');
    const iso = await parseBookingDate({
      message: raw,
      todayIso,
      maxIso,
      tz: tz || 'UTC',
    });
    return parsedFromIso(iso);
  } catch {
    return null;
  }
}

/**
 * resolveBookingDateInput — deterministic parse, AI fallback, then validation.
 * Returns { ok, parsed, label, raw, error? }
 */
export async function resolveBookingDateInput(raw, tz) {
  const trimmed = stripBookingCorrectionPrefix(String(raw || '').trim());
  if (!trimmed) {
    return { ok: false, raw: trimmed, error: 'empty' };
  }

  let parsed = tryParseDate(trimmed, tz);
  if (!parsed) parsed = await parseDateWithAI(trimmed, tz);
  if (!parsed) {
    return { ok: false, raw: trimmed, error: 'unparseable' };
  }

  const validation = validateBookingDate(parsed, tz);
  if (validation.error) {
    return { ok: false, raw: trimmed, parsed, error: 'invalid', message: validation.error };
  }

  return {
    ok: true,
    raw: trimmed,
    parsed: validation.parsed,
    label: formatBookingDateLabel(validation.parsed, tz),
  };
}
