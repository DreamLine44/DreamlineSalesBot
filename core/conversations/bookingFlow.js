/**
 * core/conversations/bookingFlow.js
 *
 * SHARED BOOKING FLOW — handles DATE, TIME, SERVICE steps identically
 * across all booking-capable modules. Each module registers this flow.
 *
 * Steps: [SELECT_SERVICE?] → DATE → DATE_CONFIRM → TIME → TIME_CONFIRM → CONFIRM
 *
 * KEY FIXES:
 * [FIX-B] Past-date and far-future-date rejection (with ordinal stripping)
 * [FIX-A]    postFlowAck on completion (not clearSession)
 * [FIX-TZ-2] business?.timezone corrected to business?.hours?.timezone. The timezone
 *            field is nested under the hours sub-document (hours.timezone), not at the
 *            top level of BusinessConfig. Reading the non-existent top-level path always
 *            returned undefined, so every date/time comparison silently fell back to UTC
 *            regardless of what timezone the business had configured.
 */

import { updateSession }           from '../sessions/sessionService.js';
import { completeFlow }            from './flowEngine.js';
import { saveBooking }             from '../../services/bookingService.js';
// buildAdminBookingAlertBody is imported dynamically inside BOOKING_CONFIRM to stay consistent
// with the dynamic import already there. The static buildAdminBookingAlert alias was dead code.
import { trackBookingAnalytics }   from '../analytics/analyticsService.js';
import { dispatchText }            from '../whatsapp/dispatcher.js';
import logger                      from '../../config/logger.js';

// ── Timezone helper ───────────────────────────────────────────────────────────

/**
 * getLocalNow — returns the current wall-clock moment in the business's
 * configured timezone (business.hours.timezone, e.g. "Africa/Banjul").
 *
 * [FIX-TZ-1] All previous date/time comparisons used `new Date()` (UTC server
 * time). A server running in UTC at 23:30 is still 23:30 the same day in GMT
 * but already 00:30 the next day in UTC+1. "Today" and "tomorrow" must resolve
 * relative to the *business* clock, not the server clock.
 *
 * Falls back to UTC when the tz string is absent or unrecognised by Intl.
 */
function getLocalNow(tz) {
  const safeZone = (() => {
    if (!tz) return 'UTC';
    try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; }
    catch { return 'UTC'; }
  })();

  // Parse current UTC moment into local calendar fields
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:    safeZone,
    year:        'numeric',
    month:       '2-digit',
    day:         '2-digit',
    hour:        '2-digit',
    minute:      '2-digit',
    second:      '2-digit',
    hour12:      false,
  }).formatToParts(new Date());

  const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);
  // Construct a Date whose *UTC* fields hold the local wall-clock values.
  // This "fake-UTC" date is only used for date arithmetic (midnight comparisons,
  // day-of-week calculations) — never serialised to the DB as-is.
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * tryParseDate — converts free-text date to JS Date (midnight local).
 * Strips ordinal suffixes (st/nd/rd/th) before native parse.
 * [FIX-B]    "15th March" was returning Invalid Date — now stripped to "15 March"
 * [FIX-TZ-1] Relative keywords (today/tomorrow/yesterday/next X) now resolve
 *             against the business's local clock, not the UTC server clock.
 *
 * @param {string}  dateStr
 * @param {string=} tz  IANA timezone string, e.g. "Africa/Banjul"
 */
export function tryParseDate(dateStr, tz) {
  if (!dateStr) return null;
  try {
    // Use local "now" for all relative keyword resolution
    const now   = getLocalNow(tz);
    const lower = String(dateStr).toLowerCase().trim();

    if (lower === 'today') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // [FIX-12] Handle "yesterday" so it resolves to a real Date — validateDate
    // then correctly rejects it as a past date instead of silently storing the string.
    if (lower === 'yesterday') {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    }
    if (lower === 'tomorrow') {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    }
    if (lower.startsWith('next ')) {
      const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const target = days.indexOf(lower.replace('next ', ''));
      if (target !== -1) {
        // [FIX-TZ-1] Use local day-of-week so "next Monday" is Monday in the
        // business's timezone, not whatever day UTC happens to be.
        const todayDow = now.getUTCDay(); // 0–6
        const diff = (target - todayDow + 7) % 7 || 7;
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
      }
    }

    // Strip ordinal suffixes: "15th" → "15", "1st" → "1"
    const stripped = dateStr.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');

    // Native parse on stripped string
    const parsed = new Date(stripped);
    if (!isNaN(parsed.getTime())) {
      const yr = parsed.getFullYear();
      // Correct implausible past year — e.g. "15 March" parsed as "15 March 1901"
      if (yr < now.getUTCFullYear()) {
        const withYear = `${stripped} ${now.getUTCFullYear()}`;
        const p2 = new Date(withYear);
        if (!isNaN(p2.getTime())) {
          // [FIX-BOOK-1] Return the year-corrected date even if it is also in the past
          // (e.g. "15 March" typed in June → March 2026). validateDate will reject it
          // with a proper formatted "March 15, 2026 has already passed" message rather
          // than the opaque "invalid date" message caused by returning the 1901 original.
          return p2;
        }
      }
      // [FIX-6] Correct implausible far-future year (engine quirk on ambiguous formats)
      if (yr > now.getUTCFullYear() + 2) {
        const withYear = `${stripped} ${now.getUTCFullYear()}`;
        const p2 = new Date(withYear);
        if (!isNaN(p2.getTime())) return p2;
      }
      return parsed;
    }

    // Last resort: add current year
    const withYear = `${stripped} ${now.getUTCFullYear()}`;
    const parsed2  = new Date(withYear);
    if (!isNaN(parsed2.getTime())) return parsed2;

    return null;
  } catch { return null; }
}

function looksLikeDate(input) {
  if (!input || input.length < 2) return false;
  const s = input.toLowerCase().trim();
  if (['today', 'tomorrow', 'yesterday'].includes(s)) return true;
  if (/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(s)) return true;
  if (/\d{1,2}[\/\-\.]\d{1,2}([\/\-\.]\d{2,4})?/.test(s)) return true;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return true;
  if (/^\d{1,2}(st|nd|rd|th)?(\s+\w+)?$/.test(s)) return true;
  return false;
}

function looksLikeTime(input) {
  if (!input) return false;
  return /^(\d{1,2})(:\d{2})?\s*(am|pm)?$/i.test(input.trim()) ||
    /^([01]?\d|2[0-3]):[0-5]\d$/.test(input.trim());
}

/**
 * parseTimeToMinutes — converts a human time string to minutes-since-midnight.
 * Returns null if unparseable.
 * Examples: "2pm" → 840, "14:30" → 870, "9:00 AM" → 540, "9AM" → 540
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim();

  // HH:MM [am/pm]
  const hhmm = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (hhmm) {
    let h = parseInt(hhmm[1], 10);
    const m = parseInt(hhmm[2], 10);
    const meridiem = (hhmm[3] || '').toLowerCase();
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }

  // H [am/pm]  (no minutes)
  const ham = s.match(/^(\d{1,2})\s*(am|pm)$/i);
  if (ham) {
    let h = parseInt(ham[1], 10);
    const meridiem = ham[2].toLowerCase();
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    if (h > 23) return null;
    return h * 60;
  }

  return null;
}

/**
 * validateDate — checks a date string against business local "today".
 *
 * [FIX-TZ-1] Uses business timezone for midnight boundary so "today" is
 *             resolved in the business's local clock.
 *
 * @param {string}  dateInput
 * @param {string=} tz  IANA timezone string
 */
function validateDate(dateInput, tz) {
  const parsed = tryParseDate(dateInput, tz);
  if (!parsed) return null; // unparseable — don't block

  // "Today midnight" in the business's local timezone
  const localNow = getLocalNow(tz);
  const localMidnight = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()));

  if (parsed < localMidnight) {
    const fmt = parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    return {
      error: `⚠️ *${fmt}* has already passed.\n\nPlease choose an *upcoming date*.\n\n(e.g. *tomorrow*, *next Friday*, *25 June*)`,
    };
  }

  const maxFuture = new Date(localMidnight);
  maxFuture.setUTCMonth(maxFuture.getUTCMonth() + 18);
  if (parsed > maxFuture) {
    return {
      error: `⚠️ That date is too far in the future. We accept bookings up to *18 months* ahead.\n\n(e.g. *next week*, *25 June*)`,
    };
  }

  return { parsed };
}

/**
 * validateTime — checks that a time input is not in the past when the booking
 * date is today (in the business's local timezone).
 *
 * [FIX-TIME-1] Previously there was NO time validation at all. A customer
 *              could book "today at 3am" at 4pm and the booking would go
 *              through. This now rejects any same-day time that has already
 *              passed, with a 5-minute grace buffer for slightly-late taps.
 *
 * @param {string}  timeInput  raw time string ("2pm", "14:30", etc.)
 * @param {object}  parsedBookingDate  Date object for the booking date (midnight)
 * @param {string=} tz   IANA timezone
 * @returns {{ error: string } | { minutes: number } | null}
 *   null  → unparseable (don't block — bot will re-prompt)
 *   error → past-time error message
 *   ok    → { minutes: number } (minutes since midnight, for reference)
 */
function validateTime(timeInput, parsedBookingDate, tz) {
  const minutes = parseTimeToMinutes(timeInput);
  if (minutes === null) return null; // unparseable — don't block here

  const localNow = getLocalNow(tz);
  const localToday = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()));

  // Only validate past-time when the booking is for today
  const bookingIsToday = parsedBookingDate && parsedBookingDate.getTime() === localToday.getTime();
  if (!bookingIsToday) return { minutes }; // future date — any time is fine

  // Current minutes since midnight in the business's local clock
  const nowMinutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
  const GRACE = 5; // 5-minute grace — allow taps that land just past the hour

  if (minutes < nowMinutes - GRACE) {
    // Format the rejected time for the error message
    const hh = Math.floor(minutes / 60);
    const mm = String(minutes % 60).padStart(2, '0');
    const period = hh >= 12 ? 'PM' : 'AM';
    const h12 = hh % 12 || 12;
    const fmtTime = `${h12}:${mm} ${period}`;

    // Suggest the next round hour
    const nextHour = Math.floor(nowMinutes / 60) + 1;
    const suggestH12 = nextHour % 12 || 12;
    const suggestPeriod = nextHour >= 12 ? 'PM' : 'AM';
    const suggest = nextHour < 24 ? ` (e.g. *${suggestH12}:00 ${suggestPeriod}*)` : '';

    return {
      error: `⚠️ *${fmtTime}* has already passed today.\n\nPlease choose an *upcoming time*${suggest}.`,
    };
  }

  return { minutes };
}

// ── Booking flow handler ───────────────────────────────────────────────────────
export async function handleBookingFlow({ session, message, business, tenant, isInteractive }) {
  const raw      = String(message || '').trim();
  const clean    = raw.toLowerCase().trim();
  const step     = session.step;
  const data     = session.data || {};
  const services = (business?.services || []).filter(s => s.available !== false);
  // [FIX-TZ-1] Resolve the business IANA timezone for all date/time comparisons.
  // Falls back to UTC when not configured so "today" and "past time" decisions
  // are relative to the business's local clock, not the UTC server clock.
  // [FIX-TZ-2] timezone lives at business.hours.timezone (nested under hours).
  // The previous business?.timezone was reading a non-existent top-level field —
  // always undefined — so date/time validation silently fell back to UTC for every
  // business not configured in UTC. Past-date and past-time checks were wrong for
  // all businesses using a non-UTC timezone (e.g. Africa/Banjul = GMT+0 in winter,
  // but named zones handle DST edge cases correctly; UTC is only coincidentally right).
  const tz       = business?.hours?.timezone || 'UTC';

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    // Determine first step
    const firstStep = services.length ? 'SELECT_SERVICE' : 'DATE';
    await updateSession(session.customerPhone, session.tenantId, { step: firstStep, data: { ...data } });

    if (firstStep === 'SELECT_SERVICE') {
      if (services.length > 3) {
        return {
          type: 'list',
          body: 'Which service would you like to book?',
          button: 'View services',
          sections: [{ title: 'Our Services', rows: services.map(s => ({
            id: `SVC_${s.name.toUpperCase().replace(/\s+/g, '_')}`,
            title: s.name.slice(0, 24),
            description: [s.price ? `D${s.price}` : null, s.duration ? `${s.duration} min` : null].filter(Boolean).join(' · ') || undefined,
          }))}],
        };
      }
      return {
        type:    'buttons',
        body:    'Which service would you like to book?',
        buttons: services.slice(0, 3).map(s => ({
          id: `SVC_${s.name.toUpperCase().replace(/\s+/g, '_')}`,
          title: s.name.slice(0, 20),
        })).concat([{ id: 'CANCEL', title: '❌ Cancel' }]).slice(0, 3),
      };
    }
    // No services — for restaurants ask party size first, then date
    const isRestaurant = (business?.businessMode || '').toUpperCase() === 'RESTAURANT';
    if (isRestaurant) {
      await updateSession(session.customerPhone, session.tenantId, { step: 'PARTY_SIZE', data: { ...data } });
      return {
        type:    'buttons',
        body:    `How many guests will be dining? 👥`,
        buttons: [
          { id: 'PARTY_2', title: '👥 2 guests'  },
          { id: 'PARTY_4', title: '👥 4 guests'  },
          { id: 'PARTY_6', title: '👥 6+ guests' },
        ],
        footer: 'Or type any number e.g. 8',
      };
    }
    return _buildDatePickerUI(null, tz);
  }

  switch (step) {

    case 'SELECT_SERVICE': {
      const idx = parseInt(raw, 10) - 1;
      // Handle SVC_ button ID prefixes from list responses
      let service = null;

      if (raw.startsWith('SVC_')) {
        const nameFromId = raw.slice(4).replace(/_/g, ' ');
        service = services.find(s => s.name.toUpperCase().replace(/\s+/g, '_') === raw.slice(4)) ||
                  services.find(s => s.name.toLowerCase() === nameFromId.toLowerCase());
      } else if (!isNaN(idx) && services[idx]) {
        service = services[idx];
      } else {
        service = services.find(s => s.name.toLowerCase().includes(clean));
      }

      if (!service) {
        // Show as list for more than 3 services, buttons for ≤3
        if (services.length > 3) {
          return {
            type: 'list',
            body: `Please choose a service:`,
            button: 'View services',
            sections: [{ title: 'Our Services', rows: services.map(s => ({
              id: `SVC_${s.name.toUpperCase().replace(/\s+/g, '_')}`,
              title: s.name.slice(0, 24),
              description: s.price ? `D${s.price}${s.duration ? ` · ${s.duration}min` : ''}` : undefined,
            }))}],
          };
        }
        return {
          type:    'buttons',
          body:    `Please choose a service:`,
          buttons: services.slice(0, 3).map(s => ({
            id: `SVC_${s.name.toUpperCase().replace(/\s+/g, '_')}`,
            title: s.name.slice(0, 20),
          })).concat([{ id: 'CANCEL', title: '❌ Cancel' }]).slice(0, 3),
        };
      }

      // [FIX-7] For RESTAURANT mode, ask how many people (partySize) after service selection.
      // The Booking model has a partySize field but the flow never captured it — admin had
      // no idea how many covers to prepare.
      const isRestaurant = (business?.businessMode || '').toUpperCase() === 'RESTAURANT';
      const nextStep = isRestaurant ? 'PARTY_SIZE' : 'DATE';

      await updateSession(session.customerPhone, session.tenantId, {
        step: nextStep, data: { ...data, service: service.name, serviceDuration: service.duration, servicePrice: service.price },
      });

      if (isRestaurant) {
        return {
          type:    'buttons',
          body:    `Great — *${service.name}* selected! ✅\n\nHow many guests will be dining? 👥`,
          // [UX-BOOK-1] Drop Cancel from party size — keeps within 3-button limit.
          buttons: [
            { id: 'PARTY_2', title: '👥 2 guests'  },
            { id: 'PARTY_4', title: '👥 4 guests'  },
            { id: 'PARTY_6', title: '👥 6+ guests' },
          ],
          footer: 'Or type any number e.g. 8',
        };
      }
      return _buildDatePickerUI(`Great — *${service.name}* selected! ✅\n\nWhat date would you like? 📅`, tz);
    }

    // [FIX-7] PARTY_SIZE step — only reached for RESTAURANT mode
    case 'PARTY_SIZE': {
      // Support quick-pick buttons (PARTY_2, PARTY_4, PARTY_6) as well as typed numbers
      const PARTY_SHORTCUTS = { 'PARTY_2': 2, 'PARTY_4': 4, 'PARTY_6': 6 };
      const { parseQuantity } = await import('../../utils/parseQuantity.js');
      const partySize = PARTY_SHORTCUTS[raw.toUpperCase()] ?? parseQuantity(raw);
      if (!partySize || partySize < 1) {
        return {
          type:    'buttons',
          body:    `How many guests will be dining? 👥`,
          // [UX-BOOK-1] Drop Cancel from party size — keeps within 3-button limit.
          buttons: [
            { id: 'PARTY_2', title: '👥 2 guests'  },
            { id: 'PARTY_4', title: '👥 4 guests'  },
            { id: 'PARTY_6', title: '👥 6+ guests' },
          ],
          footer: 'Or type any number e.g. 8',
        };
      }
      if (partySize > 50) {
        return {
          type:    'buttons',
          body:    `⚠️ Maximum party size is *50*. For larger groups please contact us directly.`,
          buttons: [{ id: 'SUPPORT', title: '💬 Contact Us' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DATE', data: { ...data, partySize },
      });
      return _buildDatePickerUI(`Perfect — *${partySize} guest${partySize > 1 ? 's' : ''}* 👥\n\nWhat date would you like? 📅`, tz);
    }

    case 'DATE': {
      // Handle quick-pick date buttons (DATE_TODAY, DATE_TOMORROW, DATE_NEXT_SAT, DATE_NEXT_SUN)
      // [FIX-TZ-1] Resolve quick-pick button IDs to date strings using the local clock
      const _localNowForShortcut = getLocalNow(tz);
      const _addLocalDays = (n) => new Date(Date.UTC(
        _localNowForShortcut.getUTCFullYear(), _localNowForShortcut.getUTCMonth(),
        _localNowForShortcut.getUTCDate() + n
      ));
      const _fmtLocal = (d) => `${d.getUTCDate()} ${d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}`;
      const DATE_SHORTCUTS = {
        'DATE_TODAY':    'today',
        'DATE_TOMORROW': 'tomorrow',
        'DATE_NEXT_SAT': (() => { const diff = (6 - _localNowForShortcut.getUTCDay() + 7) % 7 || 7; return _fmtLocal(_addLocalDays(diff)); })(),
        'DATE_NEXT_SUN': (() => { const diff = (0 - _localNowForShortcut.getUTCDay() + 7) % 7 || 7; return _fmtLocal(_addLocalDays(diff)); })(),
      };
      const resolvedRaw = DATE_SHORTCUTS[raw.toUpperCase()] || raw;

      if (!looksLikeDate(resolvedRaw)) {
        const isBareOrdinal = /^\d{1,2}(st|nd|rd|th)$/i.test(raw.trim());
        const hint = isBareOrdinal
          ? `I need the *month* too 📅\n\nFor example:\n• *${raw} June*\n• *${raw} July*\n• *${raw} August*`
          : `I couldn't recognise *${raw}* as a date.\n\nExamples: *25 June*, *tomorrow*, *next Friday*`;
        return _buildDatePickerUI(hint, tz);
      }

      // [FIX-B] Past/future validation
      const validation = validateDate(resolvedRaw, tz);
      if (validation?.error) {
        return _buildDatePickerUI(validation.error, tz);
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DATE_CONFIRM', data: { ...data, date: resolvedRaw, parsedDate: validation?.parsed || null },
      });
      return {
        type:    'buttons',
        body:    `Just to confirm — did you mean *${resolvedRaw}*? 📅`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
      };
    }

    case 'DATE_CONFIRM': {
      if (clean === 'confirm' || /^(yes|y|yep|yeah)$/i.test(clean)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'TIME' });
        return _buildTimePickerUI();
      }
      if (clean === 'date_back' || /^(no|n|re-enter|change|back)$/i.test(clean)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'DATE' });
        return _buildDatePickerUI(null, tz);
      }
      // Inline new date
      if (looksLikeDate(raw)) {
        const v2 = validateDate(raw, tz);
        if (v2?.error) return _buildDatePickerUI(v2.error, tz);
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'DATE_CONFIRM', data: { ...data, date: raw, parsedDate: v2?.parsed || null },
        });
        return {
          type:    'buttons',
          body:    `Just to confirm — did you mean *${raw}*? 📅`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
        };
      }
      return _buildDatePickerUI(`Please choose a date:`, tz);
    }

    case 'TIME': {
      // Handle time slot quick-pick buttons
      const TIME_SHORTCUTS = {
        'TIME_9AM':  '9:00 AM',
        'TIME_10AM': '10:00 AM',
        'TIME_11AM': '11:00 AM',
        'TIME_12PM': '12:00 PM',
        'TIME_1PM':  '1:00 PM',
        'TIME_2PM':  '2:00 PM',
        'TIME_3PM':  '3:00 PM',
        'TIME_4PM':  '4:00 PM',
        'TIME_5PM':  '5:00 PM',
        'TIME_6PM':  '6:00 PM',
      };
      const resolvedTime = TIME_SHORTCUTS[raw.toUpperCase()] || raw;

      if (!looksLikeTime(resolvedTime)) {
        return _buildTimePickerUI(`Please enter a valid time ⏰\n\n(e.g. *10:00*, *2pm*, *14:30*)`);
      }

      // [FIX-TIME-1] Reject past times when booking is for today.
      // parsedDate is stored in session.data from the DATE step.
      const bookingParsedDate = data.parsedDate
        ? (data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate))
        : tryParseDate(data.date, tz);
      const timeValidation = validateTime(resolvedTime, bookingParsedDate, tz);
      if (timeValidation?.error) {
        return _buildTimePickerUI(timeValidation.error);
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'TIME_CONFIRM', data: { ...data, time: resolvedTime },
      });
      return {
        type:    'buttons',
        body:    `Confirm time: *${resolvedTime}*? ⏰`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ No, re-enter' }],
      };
    }

    case 'TIME_CONFIRM': {
      if (clean === 'confirm' || /^(yes|y|yep|yeah)$/i.test(clean)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'BOOKING_CONFIRM' });
        const { date, time, service } = data;
        const summary =
          `📋 *Booking Summary*\n\n` +
          (service ? `🗓 *${service}*\n` : '') +
          `📅 *${date}*\n⏰ *${time}*\n\nShall we confirm this booking?`;
        return {
          type:    'buttons',
          body:    summary,
          buttons: [{ id: 'CONFIRM', title: '✅ Confirm Booking' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      if (clean === 'time_back' || /^(no|n|back|change)$/i.test(clean)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'TIME' });
        return _buildTimePickerUI();
      }
      if (looksLikeTime(raw)) {
        // [FIX-TIME-1] Validate past-time on inline re-entry too
        const bpd = data.parsedDate
          ? (data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate))
          : tryParseDate(data.date, tz);
        const tv2 = validateTime(raw, bpd, tz);
        if (tv2?.error) return _buildTimePickerUI(tv2.error);
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'TIME_CONFIRM', data: { ...data, time: raw },
        });
        return {
          type:    'buttons',
          body:    `Confirm time: *${raw}*? ⏰`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes' }, { id: 'TIME_BACK', title: '❌ Re-enter' }],
        };
      }
      // [FIX-13] Use a local `confirmedTime` that both the inline-new-time branch
      // and the fallback message read from, so they're always consistent.
      const confirmedTime = data.time;
      return {
        type:    'buttons',
        body:    `Please confirm *${confirmedTime}*, or go back to re-enter.`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ Re-enter' }],
      };
    }

    case 'BOOKING_CONFIRM': {
      if (!/^(yes|y|confirm|ok|okay|sure)$/i.test(clean) && clean !== 'confirm') {
        const { date, time, service } = data;
        return {
          type:    'buttons',
          body:    `📋 *Booking Summary*\n\n${service ? `🗓 *${service}*\n` : ''}📅 *${date}*\n⏰ *${time}*\n\nConfirm?`,
          buttons: [{ id: 'CONFIRM', title: '✅ Confirm' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      // Save booking
      const customerName = session.customerName || null;
      const { date, time, service, partySize } = data;
      // [FIX-16] parsedDate is stored as a Date object but comes back from
      // session.data (lean MongoDB read) as an ISO string. Coerce explicitly
      // so saveBooking always receives a real Date or null — never a string.
      const rawParsedDate = data.parsedDate;
      const parsedDate = rawParsedDate
        ? (rawParsedDate instanceof Date ? rawParsedDate : new Date(rawParsedDate))
        : tryParseDate(date);

      let savedBooking = null;
      try {
        savedBooking = await saveBooking({
          customerPhone: session.customerPhone,
          customerName,
          date, time, service,
          partySize:    partySize || null,
          parsedDate,
          tenantId:     session.tenantId,
          businessId:   business._id,
        });
      } catch (err) {
        logger.error('[BookingFlow] saveBooking failed', { err: err.message });
      }

      // Track booking analytics
      if (savedBooking) {
        trackBookingAnalytics({
          date:          data.date,
          time:          data.time,
          phoneNumberId: business.phoneNumberId || null,
          tenantId:      session.tenantId,
        }).catch(() => {});
      }

      // [FIX-E] Notify admin — every other flow (order, payment) alerts the admin;
      // bookings never did. Now mirrors the pattern used in paymentService.
      try {
        const adminPhone = business?.adminPhone || tenant?.adminPhone;
        if (adminPhone && tenant && savedBooking) {
          const { buildAdminBookingAlertBody } = await import('../../services/adminCommandService.js');
          const { dispatchMessage } = await import('../whatsapp/dispatcher.js');
          const alertBody = buildAdminBookingAlertBody({
            customerPhone: session.customerPhone,
            date,
            time,
            service,
            partySize:   partySize || null,
            business,
            shortId: savedBooking.shortId,
          });
          await dispatchMessage(adminPhone, {
            type:    'buttons',
            body:    alertBody,
            buttons: [
              { id: `CONFIRM_BOOK_${savedBooking.shortId}`, title: '✅ Confirm' },
              { id: `DECLINE_BOOK_${savedBooking.shortId}`, title: '❌ Decline' },
            ],
          }, tenant).catch(() => {});
        }
      } catch (err) {
        logger.warn('[BookingFlow] Admin notification failed (non-fatal)', { err: err.message });
      }

      const _lcRb = await completeFlow(session, 'BOOKING', business, tenant);
      if (_lcRb) return _lcRb;

      const confirmBody =
        `✅ *Booking confirmed!*\n\n` +
        (service ? `🗓 *${service}*\n` : '') +
        `📅 *${date}*\n⏰ *${time}*\n` +
        (partySize ? `👥 *${partySize} guest${partySize > 1 ? 's' : ''}*\n` : '') +
        `\nWe look forward to seeing you! 😊`;

      // [FIX-BOOK-MODE] Use the mode's welcomeButtons instead of hardcoded ORDER/BOOK buttons.
      // SALON and BARBERSHOP have no ORDER flow — showing "🛒 Place New Order" would launch
      // an order flow with no menu, confusing the customer. getModeConfig returns each mode's
      // own welcome buttons so the post-booking screen always matches what the mode supports.
      const { getModeConfig: _getBookingModeCfg } = await import('../../config/modes.js');
      const _bookingModeCfg = _getBookingModeCfg(business);
      return {
        type:    'buttons',
        body:    confirmBody,
        buttons: (_bookingModeCfg.ui?.welcomeButtons || [{ id: 'SHOW_MENU', title: '🔄 Start Over' }]).slice(0, 3),
      };
    }

    default:
      return {
        type:    'buttons',
        body:    `What date would you like to book? 📅`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
  }
}

// ── UI Builder Helpers ─────────────────────────────────────────────────────────

/**
 * _buildDatePickerUI — shows quick-pick date buttons so customers tap instead of type.
 * [FIX-TZ-1] Button labels resolved against business local clock.
 * [UX-6] "Today" button is suppressed after 20:00 local time (last common booking slot
 *         is 6pm; showing "Today" at 10pm only to reject every time choice is confusing).
 *         "Tomorrow" is always shown. Next Sat/Sun shown for weekend convenience.
 */
function _buildDatePickerUI(headingOrError = null, tz = 'UTC') {
  const now = getLocalNow(tz);
  const addDays = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n));
  const fmt = (d) => `${d.getUTCDate()} ${d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}`;

  const satDiff = (6 - now.getUTCDay() + 7) % 7 || 7;
  const sunDiff = (0 - now.getUTCDay() + 7) % 7 || 7;
  const nextSat = addDays(satDiff);
  const nextSun = addDays(sunDiff);

  // [UX-6] Suppress "Today" if it's past 20:00 local — no reasonable slots remain.
  const localHour = now.getUTCHours();
  const showToday = localHour < 20;

  const body = headingOrError
    ? `${headingOrError}\n\n_Tap a date or type your own (e.g. *${fmt(addDays(7))}*, *next Monday*)_`
    : `What date would you like to book? 📅\n\n_Tap a date below or type any date_`;

  // Build candidate buttons — WhatsApp max 3 per message
  const candidates = [
    showToday ? { id: 'DATE_TODAY',    title: `📅 Today`              } : null,
                { id: 'DATE_TOMORROW', title: `📅 Tomorrow`           },
                { id: 'DATE_NEXT_SAT', title: `📅 Sat ${fmt(nextSat)}` },
                { id: 'DATE_NEXT_SUN', title: `📅 Sun ${fmt(nextSun)}` },
  ].filter(Boolean).slice(0, 3);

  return {
    type:    'buttons',
    body,
    buttons: candidates,
    footer:  'Or type any date e.g. 25 June',
  };
}

/**
 * _buildTimePickerUI — shows AM/PM slot buttons so customers tap instead of type.
 * Renders a WhatsApp list (up to 10 rows per section) for morning/afternoon/evening.
 */
function _buildTimePickerUI(headingOrError = null) {
  const body = headingOrError
    ? `${headingOrError}\n\n_Tap a slot or type a time (e.g. *2pm*, *14:30*)_`
    : `What time works for you? ⏰\n\n_Tap a time slot or type your preferred time_`;

  return {
    type: 'list',
    body,
    button: 'Choose a time',
    sections: [
      {
        title: '🌅 Morning',
        rows: [
          { id: 'TIME_9AM',  title: '9:00 AM'  },
          { id: 'TIME_10AM', title: '10:00 AM' },
          { id: 'TIME_11AM', title: '11:00 AM' },
        ],
      },
      {
        title: '☀️ Afternoon',
        rows: [
          { id: 'TIME_12PM', title: '12:00 PM' },
          { id: 'TIME_1PM',  title: '1:00 PM'  },
          { id: 'TIME_2PM',  title: '2:00 PM'  },
          { id: 'TIME_3PM',  title: '3:00 PM'  },
          { id: 'TIME_4PM',  title: '4:00 PM'  },
        ],
      },
      {
        title: '🌆 Evening',
        rows: [
          { id: 'TIME_5PM', title: '5:00 PM' },
          { id: 'TIME_6PM', title: '6:00 PM' },
        ],
      },
    ],
    footer: 'Or type any time e.g. 2:30pm',
  };
}
