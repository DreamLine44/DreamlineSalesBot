/**
 * businessHoursUtils.js — shared helpers for business-hours / closed-day checks.
 * Used by bookingFlow (closed-day validation) and can be reused elsewhere.
 */

import { formatBookingDateLabel } from '../services/bookingDateParser.js';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Normalise hours.days from Mongoose Map or plain object. */
export function normalizeHoursDays(hours) {
  const days = hours?.days;
  if (!days) return {};
  if (days instanceof Map) return Object.fromEntries(days);
  if (typeof days.toObject === 'function') return days.toObject();
  return days;
}

/** Weekday key (e.g. "monday") for a calendar date in the business timezone. */
export function getDayKeyForDate(date, tz = 'UTC') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return DAY_NAMES[0];
  if (tz && tz !== 'UTC') {
    try {
      const weekday = new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'long' }).format(date);
      return weekday.toLowerCase();
    } catch { /* fall through */ }
  }
  return DAY_NAMES[date.getUTCDay()];
}

/** True when hours checking is enabled and the given date falls on a closed day. */
export function isBookingDateClosed(parsedDate, hours, tz = 'UTC') {
  if (!hours?.enabled || !parsedDate) return false;
  const dayKey = getDayKeyForDate(parsedDate, hours.timezone || tz);
  const dayConfig = normalizeHoursDays(hours)[dayKey];
  return dayConfig?.closed === true;
}

/**
 * Find the next open calendar day on or after `fromDate`.
 * Returns { parsed: Date, label: string } or null if none within maxDays.
 */
export function getNextOpenBookingDate(fromDate, hours, tz = 'UTC', maxDays = 21) {
  if (!fromDate || !hours?.enabled) return null;
  const zone = hours.timezone || tz || 'UTC';
  const start = fromDate instanceof Date ? fromDate : new Date(fromDate);
  if (Number.isNaN(start.getTime())) return null;

  for (let offset = 1; offset <= maxDays; offset++) {
    const candidate = new Date(Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate() + offset,
    ));
    if (!isBookingDateClosed(candidate, hours, zone)) {
      return {
        parsed: candidate,
        label:  formatBookingDateLabel(candidate, zone),
      };
    }
  }
  return null;
}

/** Human-readable closed-day message with optional next-open hint. */
export function formatClosedDayMessage(selectedLabel, hours, tz, parsedDate) {
  const next = getNextOpenBookingDate(parsedDate, hours, tz);
  if (next) {
    return `We're closed on *${selectedLabel}*. Our next available day is *${next.label}* — please pick a date below. 📅`;
  }
  return `We're closed on *${selectedLabel}*. Please choose another date. 📅`;
}
