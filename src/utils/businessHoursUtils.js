/**
 * businessHoursUtils.js — shared helpers for business-hours / closed-day checks.
 * Used by bookingFlow (closed-day validation) and can be reused elsewhere.
 */

import { formatBookingDateLabel } from '../services/booking/bookingDateParser.js';

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

/** Decimal hour (8.5 = 08:30) → minutes since midnight. */
export function decimalHourToMinutes(h) {
  if (h == null || Number.isNaN(Number(h))) return null;
  const n = Number(h);
  const hours = Math.floor(n);
  const mins = Math.round((n - hours) * 60);
  return hours * 60 + mins;
}

/** Opening window for a booking date — null when the day is closed. */
export function getHoursForBookingDate(parsedDate, hours, tz = 'UTC') {
  if (!parsedDate) return { openMinutes: 9 * 60, closeMinutes: 21 * 60 };
  if (hours?.enabled && isBookingDateClosed(parsedDate, hours, tz)) return null;

  const dayKey = getDayKeyForDate(parsedDate, hours?.timezone || tz);
  const dayConfig = hours?.enabled ? normalizeHoursDays(hours)[dayKey] : null;
  const openMinutes  = decimalHourToMinutes(dayConfig?.open  ?? hours?.open  ?? 9)  ?? (9 * 60);
  const closeMinutes = decimalHourToMinutes(dayConfig?.close ?? hours?.close ?? 21) ?? (21 * 60);
  if (closeMinutes <= openMinutes) return { openMinutes: 9 * 60, closeMinutes: 21 * 60 };
  return { openMinutes, closeMinutes };
}

function formatMinutesAsLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${period}` : `${h12}:00 ${period}`;
}

function slotPeriodLabel(minutes) {
  if (minutes < 12 * 60) return '🌅 Morning';
  if (minutes < 17 * 60) return '☀️ Afternoon';
  return '🌆 Evening';
}

/**
 * Build hourly booking time slots for a date, respecting business hours when configured.
 * Returns [{ id, title, minutes, period }] — id uses TIME_M_<minutes> for dynamic resolution.
 */
export function buildBookingTimeSlotDefs({ parsedDate, hours, tz = 'UTC', intervalMinutes = 60 } = {}) {
  const range = getHoursForBookingDate(parsedDate, hours, tz);
  if (!range) return [];

  const slots = [];
  for (let m = range.openMinutes; m < range.closeMinutes; m += intervalMinutes) {
    slots.push({
      id:      `TIME_M_${m}`,
      title:   formatMinutesAsLabel(m),
      minutes: m,
      period:  slotPeriodLabel(m),
    });
  }
  return slots;
}
