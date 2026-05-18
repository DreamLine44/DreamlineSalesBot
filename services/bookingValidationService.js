/**
 * services/bookingValidationService.js — DreamLine SalesBot v29.0
 *
 * Real-time booking validation service.
 *
 * Validates:
 *   1. Past time (e.g. booking 9am when it's 2:36pm)
 *   2. Past date
 *   3. Business hours (open/close)
 *   4. Preparation time buffer
 *   5. Stale confirmation (time gap between summary shown and confirm tapped)
 *
 * Returns: { valid: true } | { valid: false, reason: 'PAST_TIME' | 'PAST_DATE' |
 *           'OUTSIDE_HOURS' | 'PREP_TIME' | 'STALE', message: string }
 *
 * NEVER throws — always returns a result object so callers can handle gracefully.
 */

import logger from '../config/logger.js';

// ─── Time parsing helpers ─────────────────────────────────────────────────────

/**
 * Parse a free-text time string (e.g. "9:00 am", "14:00", "morning") into
 * a { hour, minute } in 24-hour format. Returns null if unparseable.
 */
function parseTimeString(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim().toLowerCase();

  // Named periods → representative hours
  const named = {
    midnight: { hour: 0,  minute: 0 },
    morning:  { hour: 9,  minute: 0 },
    noon:     { hour: 12, minute: 0 },
    midday:   { hour: 12, minute: 0 },
    afternoon:{ hour: 14, minute: 0 },
    evening:  { hour: 18, minute: 0 },
    night:    { hour: 20, minute: 0 },
  };
  for (const [key, val] of Object.entries(named)) {
    if (s.includes(key)) return val;
  }

  // "HH:MM am/pm" or "H:MM am/pm"
  const ampmFull = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (ampmFull) {
    let h = parseInt(ampmFull[1], 10);
    const m = parseInt(ampmFull[2], 10);
    const period = ampmFull[3].toLowerCase();
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return { hour: h, minute: m };
  }

  // "Ham" or "Hpm" (no colon)
  const ampmShort = s.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (ampmShort) {
    let h = parseInt(ampmShort[1], 10);
    const period = ampmShort[2].toLowerCase();
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return { hour: h, minute: 0 };
  }

  // "HH:MM" (24-hour)
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    return { hour: parseInt(h24[1], 10), minute: parseInt(h24[2], 10) };
  }

  return null;
}

/**
 * Parse a free-text date string into a JS Date at midnight local time.
 * Returns null if unparseable.
 * (Mirrors tryParseDate in flowService but standalone so this service
 *  can be imported without circular deps.)
 */
function parseDateString(dateStr) {
  if (!dateStr) return null;
  try {
    const now   = new Date();
    const lower = String(dateStr).toLowerCase().trim();

    if (lower === 'today') {
      const d = new Date(now); d.setHours(0,0,0,0); return d;
    }
    if (lower === 'tomorrow') {
      const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(0,0,0,0); return d;
    }
    if (lower.startsWith('next ')) {
      const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const target = days.indexOf(lower.replace('next ', ''));
      if (target !== -1) {
        const d = new Date(now);
        const diff = (target - d.getDay() + 7) % 7 || 7;
        d.setDate(d.getDate() + diff); d.setHours(0,0,0,0); return d;
      }
    }

    const stripped = dateStr.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
    const parsed = new Date(stripped);
    if (!isNaN(parsed.getTime())) {
      if (parsed.getFullYear() < now.getFullYear()) {
        const withYear = `${stripped} ${now.getFullYear()}`;
        const p2 = new Date(withYear);
        if (!isNaN(p2.getTime())) return p2;
      }
      return parsed;
    }

    const withYear = `${stripped} ${now.getFullYear()}`;
    const p3 = new Date(withYear);
    if (!isNaN(p3.getTime())) return p3;

    return null;
  } catch {
    return null;
  }
}

/**
 * Get business open/close hours for the given date.
 * Returns { open: number, close: number } in hours (e.g. { open: 8, close: 22 })
 * or null if hours are not configured / not enabled.
 */
function getBusinessHoursForDate(business, date) {
  const hours = business?.hours;
  if (!hours?.enabled) return null;

  const tz  = hours.timezone || 'UTC';
  const day = date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' }).toLowerCase();
  const dayConfig = (hours.days instanceof Map)
    ? hours.days.get(day)
    : (hours.days?.[day] ?? null);

  if (dayConfig?.closed === true) return { open: null, close: null, closed: true };
  if (dayConfig?.open != null && dayConfig?.close != null) {
    return { open: dayConfig.open, close: dayConfig.close, closed: false };
  }
  // Global fallback
  return {
    open:  hours.open  ?? 8,
    close: hours.close ?? 22,
    closed: false,
  };
}

// ─── Format helpers ────────────────────────────────────────────────────────────

function formatTime12h(hour, minute) {
  const period = hour >= 12 ? 'pm' : 'am';
  const h12    = hour % 12 || 12;
  const mm     = String(minute).padStart(2, '0');
  return minute === 0 ? `${h12}${period}` : `${h12}:${mm}${period}`;
}

function suggestNextSlots(business, dateStr, afterHour, afterMinute) {
  const hoursConfig = business?.hours;
  const openHour    = hoursConfig?.open  ?? 8;
  const closeHour   = hoursConfig?.close ?? 22;
  const prepMins    = business?.settings?.preparationMinutes ?? 30;

  const suggestions = [];
  // Round up to next 30-min slot after afterHour:afterMinute + prepMins buffer
  let startMins = (afterHour * 60 + afterMinute + prepMins);
  // Round up to next 30-min boundary
  startMins = Math.ceil(startMins / 30) * 30;

  for (let i = 0; i < 3; i++) {
    const slotMins = startMins + i * 30;
    const slotHour = Math.floor(slotMins / 60);
    const slotMin  = slotMins % 60;
    if (slotHour < closeHour) {
      suggestions.push(formatTime12h(slotHour, slotMin));
    }
  }
  return suggestions;
}

// ─── STALE CONFIRMATION threshold ─────────────────────────────────────────────
// If more than this many minutes have elapsed since the booking summary was
// shown, we revalidate the time before finalising.
const STALE_THRESHOLD_MINUTES = 10;

// ─── Main validator ───────────────────────────────────────────────────────────

/**
 * validateBooking({ dateStr, timeStr, business, session })
 *
 * @param {object} opts
 * @param {string}  opts.dateStr   - Free-text date (e.g. "18 May", "tomorrow")
 * @param {string}  opts.timeStr   - Free-text time (e.g. "9:00 am", "14:00")
 * @param {object}  opts.business  - BusinessConfig document
 * @param {object}  [opts.session] - Session object (used for stale-check)
 * @param {boolean} [opts.isFinal] - true when called at final CONFIRM step
 *
 * @returns {{ valid: boolean, reason?: string, message?: string, suggestions?: string[] }}
 */
export function validateBooking({ dateStr, timeStr, business, session, isFinal = false }) {
  try {
    const now      = new Date();
    const parsedDate = parseDateString(dateStr);
    const parsedTime = parseTimeString(timeStr);

    // ── 1. Past date check ─────────────────────────────────────────────────
    if (parsedDate) {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      if (parsedDate < midnight) {
        const formatted = parsedDate.toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric',
        });
        return {
          valid:   false,
          reason:  'PAST_DATE',
          message: `⚠️ *${formatted}* has already passed.\n\nPlease choose an upcoming date for your booking. 😊`,
        };
      }
    }

    // ── 2. Past time check (only relevant if booking is for today) ─────────
    if (parsedTime) {
      const isToday = parsedDate
        ? parsedDate.toDateString() === now.toDateString()
        : true; // if no parseable date, assume today for safety

      if (isToday) {
        const nowHour   = now.getHours();
        const nowMinute = now.getMinutes();
        const bookingMins = parsedTime.hour * 60 + parsedTime.minute;
        const nowMins     = nowHour * 60 + nowMinute;

        if (bookingMins <= nowMins) {
          const formatted = formatTime12h(parsedTime.hour, parsedTime.minute);
          const suggestions = suggestNextSlots(business, dateStr, nowHour, nowMinute);
          const suggStr = suggestions.length > 0
            ? `\n\nAvailable soon: *${suggestions.join('* · *')}*`
            : '';
          return {
            valid:       false,
            reason:      'PAST_TIME',
            suggestions,
            message:
              `⚠️ *${formatted}* has already passed today.\n\nPlease choose another time 😊` + suggStr,
          };
        }

        // ── 3. Preparation time check ────────────────────────────────────
        const prepMins    = business?.settings?.preparationMinutes ?? 30;
        const latestMins  = nowMins + prepMins;

        if (bookingMins < latestMins) {
          const formatted    = formatTime12h(parsedTime.hour, parsedTime.minute);
          const minReadyTime = formatTime12h(
            Math.floor(latestMins / 60),
            latestMins % 60,
          );
          const suggestions = suggestNextSlots(business, dateStr, nowHour, nowMinute);
          const suggStr = suggestions.length > 0
            ? `\n\nEarliest available: *${suggestions.join('* · *')}*`
            : '';
          return {
            valid:       false,
            reason:      'PREP_TIME',
            suggestions,
            message:
              `⚠️ We need at least *${prepMins} minutes* to prepare.\n\n` +
              `*${formatted}* is too soon — the earliest we can book you is around *${minReadyTime}*.` + suggStr,
          };
        }
      }
    }

    // ── 4. Business hours check ────────────────────────────────────────────
    if (parsedTime) {
      const checkDate = parsedDate || now;
      const bh = getBusinessHoursForDate(business, checkDate);
      if (bh) {
        if (bh.closed) {
          return {
            valid:   false,
            reason:  'CLOSED_DAY',
            message: `⚠️ Sorry, we are closed on that day. Please choose another date. 😊`,
          };
        }
        const bookingMins = parsedTime.hour * 60 + parsedTime.minute;
        const openMins    = bh.open  * 60;
        const closeMins   = bh.close * 60;

        if (bookingMins < openMins || bookingMins >= closeMins) {
          const openStr  = formatTime12h(bh.open,  0);
          const closeStr = formatTime12h(bh.close, 0);
          const formatted = formatTime12h(parsedTime.hour, parsedTime.minute);
          return {
            valid:   false,
            reason:  'OUTSIDE_HOURS',
            message:
              `⚠️ *${formatted}* is outside our working hours.\n\n` +
              `We are open from *${openStr}* to *${closeStr}*. Please choose a time within that range 😊`,
          };
        }
      }
    }

    // ── 5. Stale confirmation check (final confirm only) ──────────────────
    if (isFinal && session) {
      const summaryShownAt = session.bookingSummaryShownAt
        || session.data?.summaryShownAt
        || null;

      if (summaryShownAt) {
        const elapsedMs   = Date.now() - new Date(summaryShownAt).getTime();
        const elapsedMins = elapsedMs / 60000;

        if (elapsedMins > STALE_THRESHOLD_MINUTES) {
          logger.info('[BookingValidation] Stale confirmation detected', {
            elapsedMins: elapsedMins.toFixed(1),
            dateStr,
            timeStr,
            customerPhone: session.customerPhone,
          });

          // Re-run time validation with current time against the original booking time
          // (the recursive call has isFinal=false so it won't loop)
          const recheck = validateBooking({ dateStr, timeStr, business, session: null, isFinal: false });
          if (!recheck.valid) {
            return {
              ...recheck,
              reason:  'STALE_' + recheck.reason,
              message: `⚠️ Sorry, that time slot is no longer available.\n\n` + recheck.message,
            };
          }
        }
      }
    }

    return { valid: true };

  } catch (err) {
    logger.error('[BookingValidation] Unexpected error', { err: err.message });
    return { valid: true }; // Fail open — never block a booking on our own error
  }
}

/**
 * Convenience: validate only the time string for today.
 * Used in the TIME step before showing TIME_CONFIRM.
 */
export function validateTimeToday(timeStr, business) {
  return validateBooking({ dateStr: 'today', timeStr, business });
}
