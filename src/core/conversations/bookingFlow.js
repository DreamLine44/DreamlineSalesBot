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
import { completeFlow, cancelFlow } from './flowEngine.js';
import {
  saveBooking,
  getLocalNow,
  tryParseDate,
  resolveBookingDateInput,
  formatBookingDateLabel,
  buildSimpleDayList,
  buildWeekDayList,
  buildMonthPickerList,
  buildMonthDayList,
  parseMonthId,
  resolveDayPick,
  shouldUseBookingDateFlow,
  resolveBookingDateFlowId,
  buildBookingDateFlowMessage,
  parseBookingDateFlowReply,
  resolveFlowBookingDate,
} from '../../services/booking/bookingFeature.js';
// buildAdminBookingAlertBody is imported dynamically inside BOOKING_CONFIRM to stay consistent
// with the dynamic import already there. The static buildAdminBookingAlert alias was dead code.
import { trackBookingAnalytics }   from '../analytics/analyticsService.js';
// [FIX-BC-2] dispatchText was imported but never called anywhere in this file — dead import removed.
import logger                      from '../../config/logger.js';
import { formatMoney }             from '../../utils/formatCurrency.js';
import { getAdminPhones }          from '../../utils/adminPhones.js';
import {
  isBookingDateClosed,
  formatClosedDayMessage,
} from '../../utils/businessHoursUtils.js';

// Re-export for backward compatibility (bakery/delivery flows import from here).
export { tryParseDate } from '../nlu/resolution/bookingDateParser.js';

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

async function _confirmBookingDate(session, data, resolved, { business, tenant, tz, heading = null } = {}) {
  if (business?.hours?.enabled && resolved?.parsed) {
    if (isBookingDateClosed(resolved.parsed, business.hours, tz)) {
      const msg = formatClosedDayMessage(resolved.label, business.hours, tz, resolved.parsed);
      return _buildDatePickerUI(heading ? `${heading}\n\n${msg}` : msg, tz, { business, tenant, customerPhone: session.customerPhone });
    }
  }

  await updateSession(session.customerPhone, session.tenantId, {
    step: 'DATE_CONFIRM',
    data: {
      ...data,
      date: resolved.label,
      dateRaw: resolved.raw,
      parsedDate: resolved.parsed,
    },
  });
  const confirmBody = `Just to confirm — did you mean *${resolved.label}*? 📅`;
  return {
    type:    'buttons',
    body:    heading ? `${heading}\n\n${confirmBody}` : confirmBody,
    buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
  };
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

// [FEAT-NLU-BOOKING-PREFILL] Lands the customer on the first genuinely
// UNKNOWN field when `data` already carries partySize/parsedDate/time
// extracted from their original natural-language message (see
// parseDirectBookingRequest() in core/shared/moduleRegistry.js). Reuses the
// exact same UI builders and confirm-screens (_buildDatePickerUI,
// _confirmBookingDate → DATE_CONFIRM, _buildTimePickerUI → TIME_CONFIRM) the
// step-by-step flow already uses — so an extracted date/time is always
// re-confirmed with the customer via the same "Just to confirm — did you
// mean X?" screen a manually-typed answer would get, rather than silently
// trusted. Never asks about a field twice: PARTY_SIZE's success handler and
// DATE_CONFIRM's "yes" handler each also check for a pre-filled next value
// (see their [FEAT-NLU-BOOKING-PREFILL] comments below) so a value found here
// but not yet reached carries all the way through instead of being re-asked
// once the customer answers the field that WAS missing.
async function _resumeFromPrefill(session, data, { business, tenant, tz, heading = null } = {}) {
  const isRestaurant = (business?.businessMode || '').toUpperCase() === 'RESTAURANT';
  // [AUDIT-FIX-BOOKING-SERVICES-PREFILL] `heading` lets a caller that already
  // showed its own confirmation line (e.g. SELECT_SERVICE's "Great — X
  // selected! ✅") prepend it to whichever prompt this function lands on,
  // instead of that context being silently dropped. Optional and defaults to
  // null so the original no-services call site (INIT, no heading) is
  // byte-for-byte unchanged.
  const withHeading = (body) => (heading ? `${heading}\n\n${body}` : body);

  if (isRestaurant && !data.partySize) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'PARTY_SIZE', data: { ...data } });
    return {
      type:    'buttons',
      body:    withHeading(`How many guests will be dining? 👥`),
      buttons: [
        { id: 'PARTY_2', title: '👥 2 guests'  },
        { id: 'PARTY_4', title: '👥 4 guests'  },
        { id: 'PARTY_6', title: '👥 6+ guests' },
      ],
      footer: 'Or type any number e.g. 8',
    };
  }

  if (!data.parsedDate) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'DATE', data: { ...data } });
    const partyLine = data.partySize
      ? `Perfect — *${data.partySize} guest${data.partySize > 1 ? 's' : ''}* 👥`
      : null;
    const datePrompt = [heading, partyLine, 'What date would you like? 📅'].filter(Boolean).join('\n\n');
    return _buildDatePickerUI(datePrompt || null, tz, { business, tenant, customerPhone: session.customerPhone });
  }

  if (!data.time) {
    const parsedDate = data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate);
    return _confirmBookingDate(session, data, {
      ok: true, parsed: parsedDate, label: data.date, raw: data.dateRaw || data.date,
    }, { business, tenant, tz, heading });
  }

  // Every field is pre-filled — validate the extracted time before trusting
  // it (it may be a same-day time that's already passed) and go straight to
  // the same "confirm time?" screen the TIME step itself would show.
  const parsedDate = data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate);
  const timeValidation = validateTime(data.time, parsedDate, tz);
  if (timeValidation?.error) {
    await updateSession(session.customerPhone, session.tenantId, { step: 'TIME', data: { ...data, time: null } });
    return _buildTimePickerUI(withHeading(timeValidation.error), { tz, bookingDate: parsedDate });
  }
  await updateSession(session.customerPhone, session.tenantId, { step: 'TIME_CONFIRM', data: { ...data } });
  return {
    type:    'buttons',
    body:    withHeading(`Confirm time: *${data.time}*? ⏰`),
    buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ No, re-enter' }],
  };
}

// ── Booking flow handler ───────────────────────────────────────────────────────
export async function handleBookingFlow({ session, message, business, tenant, isInteractive, flowReply = null }) {
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
    // [FEAT-NLU-BOOKING-PREFILL] If the customer's original message already
    // told us the party size / date / time (e.g. "book a table for three
    // people on the first of next month at 3 pm" — see
    // parseDirectBookingRequest() in core/shared/moduleRegistry.js), `data`
    // arrives here already carrying whichever of those fields were
    // confidently extracted. Skip straight past any step whose answer we
    // already have instead of asking again from scratch. Safe unconditionally:
    // in EVERY normal (non-prefilled) flow start, `data` is always `{}` at
    // this exact point — partySize/parsedDate/time are only ever written by
    // their own step's handler, which by definition hasn't run yet on a
    // fresh INIT call — so this never fires or misfires mid-flow, only for a
    // genuine direct-parse pre-fill.
    if (!services.length && (data.partySize || data.parsedDate || data.time)) {
      return _resumeFromPrefill(session, data, { business, tenant, tz });
    }

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
            description: [s.price ? `D${formatMoney(s.price)}` : null, s.duration ? `${s.duration} min` : null].filter(Boolean).join(' · ') || undefined,
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
    return _buildDatePickerUI(null, tz, { business, tenant, customerPhone: session.customerPhone });
  }

  switch (step) {

    case 'SELECT_SERVICE': {
      // [AUDIT-FIX-PARSEINT-9] parseInt("2 haircuts please", 10) === 2, NOT NaN
      // — so any message merely STARTING with a digit silently hijacked the
      // services array index instead of falling through to name matching below.
      // Only trust the parsed index for a bare number.
      const isPureNumeric = /^\d+$/.test(raw.trim());
      const idx = isPureNumeric ? parseInt(raw, 10) - 1 : NaN;
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
              description: s.price ? `D${formatMoney(s.price)}${s.duration ? ` · ${s.duration}min` : ''}` : undefined,
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
      //
      // [AUDIT-FIX-BOOKING-SERVICES-PREFILL] This used to hardcode "ask
      // party size" / "show the date picker" unconditionally after a service
      // was picked — completely ignoring any date/time the customer's
      // original message already gave us (e.g. "book a haircut on the 15th
      // at 3pm"). Any booking-capable business with a services list
      // configured (SALON/BARBERSHOP/SERVICES/GENERAL — the common case for
      // those modes) hit this branch, so the NLU-prefill feature effectively
      // never applied to them even though moduleRegistry.js's START_BOOKING
      // action had already merged the extracted fields into session data.
      // Delegating to _resumeFromPrefill() (same "what's still missing?"
      // logic INIT uses for services-less businesses) fixes that: it skips
      // straight past party size/date/time confirmation for whichever of
      // those were already extracted, and asks normally for the rest — with
      // the "Great — X selected!" line preserved via the heading param.
      const updatedData = { ...data, service: service.name, serviceDuration: service.duration, servicePrice: service.price };
      return _resumeFromPrefill(session, updatedData, {
        business, tenant, tz, heading: `Great — *${service.name}* selected! ✅`,
      });
    }

    // [FIX-7] PARTY_SIZE step — only reached for RESTAURANT mode
    case 'PARTY_SIZE': {
      if (_isCancelIntent(clean, raw)) return cancelFlow(session, business);

      // Support quick-pick buttons (PARTY_2, PARTY_4, PARTY_6) as well as typed numbers
      const PARTY_SHORTCUTS = { 'PARTY_2': 2, 'PARTY_4': 4, 'PARTY_6': 6 };
      const { parseQuantity } = await import('../nlu/resolution/parseQuantity.js');
      const partySize = PARTY_SHORTCUTS[raw.toUpperCase()] ?? parseQuantity(raw);
      if (!partySize || partySize < 1) {
        const triedCancel = _isCancelIntent(clean, raw);
        if (triedCancel) return cancelFlow(session, business);
        return {
          type:    'buttons',
          body:    `How many guests will be dining? 👥\n\n_Type *cancel* anytime to stop._`,
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
      // [FEAT-NLU-BOOKING-PREFILL] If the original message already gave us a
      // date too (e.g. "table for three on the first of next month at 3pm" —
      // partySize was missing so _resumeFromPrefill landed here on PARTY_SIZE,
      // but data.parsedDate is already set), skip the date picker and go
      // straight to confirming the date we already extracted — same as
      // _resumeFromPrefill would do if it were re-entered with partySize now
      // known. Without this check, a party size typed in response to this
      // step would silently overwrite/ignore the already-known date and ask
      // for it again from scratch.
      if (data.parsedDate) {
        const parsedDate = data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate);
        return _confirmBookingDate(session, { ...data, partySize }, {
          ok: true, parsed: parsedDate, label: data.date, raw: data.dateRaw || data.date,
        }, { business, tenant, tz });
      }
      return _buildDatePickerUI(`Perfect — *${partySize} guest${partySize > 1 ? 's' : ''}* 👥\n\nWhat date would you like? 📅`, tz, { business, tenant, customerPhone: session.customerPhone });
    }

    case 'DATE_MONTH': {
      const upper = raw.toUpperCase();
      if (upper === 'DATE_HUB_BACK' || upper === 'DATE_MONTH_BACK') {
        await updateSession(session.customerPhone, session.tenantId, { step: 'DATE' });
        return _buildDatePickerUI(null, tz, { business, tenant, customerPhone: session.customerPhone });
      }
      const monthInfo = parseMonthId(raw);
      if (monthInfo) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'DATE_DAY',
          data: { ...data, pickYear: monthInfo.year, pickMonth: monthInfo.month, pickDayPage: 0 },
        });
        return buildMonthDayList({
          year: monthInfo.year, month: monthInfo.month, tz, page: 0,
        });
      }
      return buildMonthPickerList(tz);
    }

    case 'DATE_DAY': {
      const upper = raw.toUpperCase();
      const pickYear = data.pickYear;
      const pickMonth = data.pickMonth;

      if (upper === 'DATE_MONTH_BACK') {
        await updateSession(session.customerPhone, session.tenantId, { step: 'DATE_MONTH' });
        return buildMonthPickerList(tz);
      }

      const moreMatch = upper.match(/^DATE_DAY_MORE_(\d{6})_(\d+)$/);
      if (moreMatch && pickYear != null && pickMonth != null) {
        const page = parseInt(moreMatch[2], 10);
        await updateSession(session.customerPhone, session.tenantId, {
          data: { ...data, pickDayPage: page },
        });
        return buildMonthDayList({ year: pickYear, month: pickMonth, tz, page });
      }

      const dayPick = await resolveDayPick(raw, tz);
      if (dayPick) {
        return _confirmBookingDate(session, data, dayPick, { business, tenant, tz });
      }

      const page = data.pickDayPage || 0;
      if (pickYear != null && pickMonth != null) {
        return buildMonthDayList({ year: pickYear, month: pickMonth, tz, page });
      }
      await updateSession(session.customerPhone, session.tenantId, { step: 'DATE_MONTH' });
      return buildMonthPickerList(tz);
    }

    case 'DATE': {
      const upper = raw.toUpperCase();

      // WhatsApp Flow calendar reply (nfm_reply with booking_date YYYY-MM-DD)
      if (flowReply) {
        const isoDate = parseBookingDateFlowReply(flowReply);
        if (isoDate) {
          const resolved = await resolveFlowBookingDate(isoDate, tz);
          if (resolved.ok) return _confirmBookingDate(session, data, resolved, { business, tenant, tz });
          return _buildDatePickerUI(resolved.message || `Invalid date from calendar.`, tz, { business, tenant, customerPhone: session.customerPhone });
        }
      }

      if (upper === 'DATE_HUB_WEEK_0') return buildWeekDayList(0, tz);
      if (upper === 'DATE_HUB_WEEK_1') return buildWeekDayList(1, tz);
      if (upper === 'DATE_HUB_MONTH') {
        await updateSession(session.customerPhone, session.tenantId, { step: 'DATE_MONTH' });
        return buildMonthPickerList(tz);
      }

      const dayPick = await resolveDayPick(raw, tz);
      if (dayPick) return _confirmBookingDate(session, data, dayPick, { business, tenant, tz });

      const _localNowForShortcut = getLocalNow(tz);
      const _addLocalDays = (n) => new Date(Date.UTC(
        _localNowForShortcut.getUTCFullYear(), _localNowForShortcut.getUTCMonth(),
        _localNowForShortcut.getUTCDate() + n
      ));
      const _fmtLocal = (d) => `${d.getUTCDate()} ${d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}`;

      // Legacy quick-pick offsets (DATE_PICK_0…9)
      const pickMatch = raw.toUpperCase().match(/^DATE_PICK_(\d+)$/);
      if (pickMatch) {
        const offset = parseInt(pickMatch[1], 10);
        if (offset >= 0 && offset < 10) {
          const parsed = _addLocalDays(offset);
          return _confirmBookingDate(session, data, {
            ok: true,
            raw,
            parsed,
            label: formatBookingDateLabel(parsed, tz),
          }, { business, tenant, tz });
        }
      }

      const DATE_SHORTCUTS = {
        'DATE_TODAY':    'today',
        'DATE_TOMORROW': 'tomorrow',
        'DATE_NEXT_SAT': (() => { const diff = (6 - _localNowForShortcut.getUTCDay() + 7) % 7 || 7; return _fmtLocal(_addLocalDays(diff)); })(),
        'DATE_NEXT_SUN': (() => { const diff = (0 - _localNowForShortcut.getUTCDay() + 7) % 7 || 7; return _fmtLocal(_addLocalDays(diff)); })(),
      };
      const resolvedRaw = DATE_SHORTCUTS[raw.toUpperCase()] || raw;

      const resolved = await resolveBookingDateInput(resolvedRaw, tz);
      if (!resolved.ok) {
        const isBareOrdinal = /^\d{1,2}(st|nd|rd|th)$/i.test(raw.trim());
        if (resolved.error === 'invalid' && resolved.message) {
          return _buildDatePickerUI(resolved.message, tz, { business, tenant, customerPhone: session.customerPhone });
        }
        const hint = isBareOrdinal
          ? `Please include the month as well.\n\nFor example: *${raw} June*, *${raw} July*`
          : `I couldn't find a date in *${raw}*.\n\nTry a format like *25 June*, *tomorrow*, or *next Friday*.`;
        return _buildDatePickerUI(hint, tz, { business, tenant, customerPhone: session.customerPhone });
      }

      return _confirmBookingDate(session, data, resolved, { business, tenant, tz });
    }

    case 'DATE_CONFIRM': {
      // [AUDIT-FIX-BOOKING-CONFIRM-WIDEN] DATE_CONFIRM and TIME_CONFIRM only
      // ever recognised a narrow literal regex (yes/y/yep/yeah — no/n/re-
      // enter/change/back), even though BOOKING_CONFIRM further down this
      // SAME file was already widened via confirmationMatcher.js's shared
      // isAffirmative/isNegative (see [FIX-DUALLAYER-CONFIRM] there) so
      // natural replies like "sure", "sounds good", "yes please", "nah
      // change it", "no thanks" are recognised. A customer typing anything
      // outside the narrow literal set at THESE two confirm screens fell
      // through to unrelated re-parsing (as a new date/time attempt) instead
      // of being recognised as a plain yes/no — exactly the "bot ignores
      // what I typed" gap confirmationMatcher.js exists to close.
      const { isAffirmative: _isAffirmativeDate, isNegative: _isNegativeDate } =
        await import('../nlu/resolution/confirmationMatcher.js');
      if (clean === 'confirm' || /^(yes|y|yep|yeah)$/i.test(clean) || _isAffirmativeDate(raw)) {
        const bookingParsedDate = data.parsedDate
          ? (data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate))
          : tryParseDate(data.date, tz);
        // [FEAT-NLU-BOOKING-PREFILL] If the original message also gave us a
        // time (e.g. _resumeFromPrefill landed on DATE_CONFIRM because only
        // the date needed confirming, but data.time was already extracted),
        // skip the time picker and go straight to confirming the time we
        // already have — mirrors the partySize check in the PARTY_SIZE case
        // above. Falls through to the normal time picker if the pre-filled
        // time turns out to be invalid (e.g. already passed today).
        if (data.time) {
          const timeValidation = validateTime(data.time, bookingParsedDate, tz);
          if (!timeValidation?.error) {
            await updateSession(session.customerPhone, session.tenantId, { step: 'TIME_CONFIRM', data: { ...data } });
            return {
              type:    'buttons',
              body:    `Confirm time: *${data.time}*? ⏰`,
              buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ No, re-enter' }],
            };
          }
          await updateSession(session.customerPhone, session.tenantId, { step: 'TIME', data: { ...data, time: null } });
          return _buildTimePickerUI(timeValidation.error, { tz, bookingDate: bookingParsedDate });
        }
        await updateSession(session.customerPhone, session.tenantId, { step: 'TIME' });
        return _buildTimePickerUI(null, { tz, bookingDate: bookingParsedDate });
      }
      if (clean === 'date_back' || /^(no|n|re-enter|change|back)$/i.test(clean) || _isNegativeDate(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'DATE' });
        return _buildDatePickerUI(null, tz, { business, tenant, customerPhone: session.customerPhone });
      }
      const resolvedInline = await resolveBookingDateInput(raw, tz);
      if (resolvedInline.ok) {
        return _confirmBookingDate(session, data, resolvedInline, { business, tenant, tz });
      }
      if (resolvedInline.error === 'invalid' && resolvedInline.message) {
        return _buildDatePickerUI(resolvedInline.message, tz, { business, tenant, customerPhone: session.customerPhone });
      }
      return _buildDatePickerUI(`Please choose a date:`, tz, { business, tenant, customerPhone: session.customerPhone });
    }

    case 'TIME': {
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
        'TIME_7PM':  '7:00 PM',
      };
      const resolvedTime = TIME_SHORTCUTS[raw.toUpperCase()] || raw;

      const bookingParsedDate = data.parsedDate
        ? (data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate))
        : tryParseDate(data.date, tz);

      if (!looksLikeTime(resolvedTime)) {
        return _buildTimePickerUI(`Please enter a valid time ⏰\n\n(e.g. *10:00*, *2pm*, *14:30*)`, { tz, bookingDate: bookingParsedDate });
      }

      const timeValidation = validateTime(resolvedTime, bookingParsedDate, tz);
      if (timeValidation?.error) {
        return _buildTimePickerUI(timeValidation.error, { tz, bookingDate: bookingParsedDate });
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
      // [AUDIT-FIX-BOOKING-CONFIRM-WIDEN] See the matching note on
      // DATE_CONFIRM above — same gap, same fix.
      const { isAffirmative: _isAffirmativeTime, isNegative: _isNegativeTime } =
        await import('../nlu/resolution/confirmationMatcher.js');
      if (clean === 'confirm' || /^(yes|y|yep|yeah)$/i.test(clean) || _isAffirmativeTime(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'BOOKING_CONFIRM' });
        const { date, time, service, partySize, stylist, staff } = data;
        // [FIX-SALON-9] Show stylist/staff in booking summary when set by salon flow.
        // session.data.stylist is written by handleSalonBooking SELECT_STYLIST step.
        const staffDisplay = stylist || staff || null;
        const isBarbershopSummary = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
        const summary =
          `📋 *Booking Summary*\n\n` +
          (service      ? `${isBarbershopSummary ? '✂️' : '💇'} *${service}*\n`                      : '') +
          (staffDisplay ? `👤 *${isBarbershopSummary ? 'Barber' : 'Stylist'}:* ${staffDisplay}\n`    : '') +
          (partySize    ? `👥 *${partySize} guest${partySize > 1 ? 's' : ''}*\n`                     : '') +
          `📅 *${date}*\n⏰ *${time}*\n\nShall we confirm this booking?`;
        return {
          type:    'buttons',
          body:    summary,
          buttons: [{ id: 'CONFIRM', title: '✅ Confirm Booking' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      if (clean === 'time_back' || /^(no|n|back|change)$/i.test(clean) || _isNegativeTime(raw)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'TIME' });
        const bpdBack = data.parsedDate
          ? (data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate))
          : tryParseDate(data.date, tz);
        return _buildTimePickerUI(null, { tz, bookingDate: bpdBack });
      }
      if (looksLikeTime(raw)) {
        const bpd = data.parsedDate
          ? (data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate))
          : tryParseDate(data.date, tz);
        const tv2 = validateTime(raw, bpd, tz);
        if (tv2?.error) return _buildTimePickerUI(tv2.error, { tz, bookingDate: bpd });
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
      // [FIX-v14-BUG-1] CANCEL must be intercepted FIRST, before the summary re-prompt.
      // Without this guard, CANCEL at the booking summary screen hits the else-branch
      // of the confirm regex and re-shows the booking summary — an infinite loop.
      // handleSalonBooking's global escape catches it only when the flow delegates here;
      // for non-salon modes (restaurant, services) that call handleBookingFlow directly,
      // no outer escape exists, so the fix must live here in the shared flow.
      // [FIX-DUALLAYER-CONFIRM] Widened via the shared regex guard so "no thanks",
      // "please cancel it", "nah changed my mind" etc. also escape instead of
      // silently falling through to the confirm re-prompt below.
      const { isAffirmative: _isAffirmativeBooking, isNegative: _isNegativeBooking } =
        await import('../nlu/resolution/confirmationMatcher.js');
      if (/^(cancel|cancel_booking|no|nope|show_menu)$/i.test(clean) || _isNegativeBooking(raw)) {
        return cancelFlow(session, business);
      }

      // [FIX-CONFIRM-1] "yeah"/"yep" were missing here even though DATE_CONFIRM
      // and TIME_CONFIRM in this same file already accept them. This is the step
      // that actually saves the booking, so it matters most.
      // [FIX-DUALLAYER-CONFIRM] Widened via the shared regex guard so "yes
      // please", "sounds good", "go ahead" etc. also confirm — not just a bare
      // single-word match.
      const isBookingConfirm = /^(yes|y|yeah|yep|confirm|ok|okay|sure)$/i.test(clean) || clean === 'confirm' ||
        _isAffirmativeBooking(raw);
      if (!isBookingConfirm) {
        const { date, time, service, partySize, stylist, staff } = data;
        const staffDisplay2 = stylist || staff || null;
        const isBarbershopReprompt = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
        return {
          type:    'buttons',
          body:
            `📋 *Booking Summary*\n\n` +
            (service       ? `${isBarbershopReprompt ? '✂️' : '💇'} *${service}*\n`                         : '') +
            (staffDisplay2 ? `👤 *${isBarbershopReprompt ? 'Barber' : 'Stylist'}:* ${staffDisplay2}\n`      : '') +
            (partySize     ? `👥 *${partySize} guest${partySize > 1 ? 's' : ''}*\n`                         : '') +
            `📅 *${date}*\n⏰ *${time}*\n\nShall we confirm this booking?`,
          buttons: [{ id: 'CONFIRM', title: '✅ Confirm Booking' }, { id: 'CANCEL', title: '❌ Cancel' }],
        };
      }

      // Save booking
      const customerName = session.customerName || null;
      const { date, time, service, partySize, stylist, staff } = data;
      // [FIX-SALON-9] stylist is set by handleSalonBooking SELECT_STYLIST → session.data.stylist
      const staffToSave = stylist || staff || null;
      // [FIX-SALON-2] Mark appointments as 'appointment' type (vs walk-in 'walkin')
      const isSalonMode = ['SALON','BARBERSHOP'].includes((business?.businessMode || '').toUpperCase());
      const bookingTypeToSave = isSalonMode ? 'appointment' : null;

      // [v14-DUPLICATE] Double-booking guard: same customer, same date, within ±30 min.
      if (isSalonMode && date) {
        try {
          const { default: _BookingModel } = await import('../../models/Booking.js');
          const sameDayBookings = await _BookingModel.find({
            customerPhone: session.customerPhone,
            tenantId:      session.tenantId,
            date,
            status:        { $in: ['pending', 'confirmed'] },
            bookingType:   { $ne: 'walkin' },
          }).lean().catch(() => []);

          const newMinutes = parseTimeToMinutes(time);
          let conflict = null;

          if (newMinutes !== null && sameDayBookings.length > 0) {
            conflict = sameDayBookings.find(b => {
              const existing = parseTimeToMinutes(b.time);
              return existing !== null && Math.abs(existing - newMinutes) <= 30;
            }) || null;
          } else if (sameDayBookings.length > 0) {
            conflict = sameDayBookings[0];
          }

          if (conflict) {
            return {
              type: 'buttons',
              body:
                `⚠️ *You already have a booking on ${date}*` +
                (conflict.time && newMinutes !== null ? ' around this time' : '') +
                `\n\n` +
                (conflict.service ? `💇 *${conflict.service}*\n` : '') +
                (conflict.time    ? `⏰ *${conflict.time}*\n`    : '') +
                `\nWould you like to reschedule that booking, or book a different date?`,
              buttons: [
                { id: 'RESCHEDULE', title: '📅 Reschedule'      },
                { id: 'BOOK',       title: '📅 Different Date'  },
                { id: 'SHOW_MENU',  title: '🔄 Main Menu'        },
              ],
            };
          }
        } catch { /* non-fatal — proceed with save */ }
      }

      // [FIX-16] parsedDate is stored as a Date object but comes back from
      // session.data (lean MongoDB read) as an ISO string. Coerce explicitly
      // so saveBooking always receives a real Date or null — never a string.
      const rawParsedDate = data.parsedDate;
      // [AUDIT-FIX-BOOK-1] Fallback re-parse was missing the `tz` argument that every
      // other tryParseDate() call site in this file passes. data.parsedDate is only
      // absent here when the DATE step's own tryParseDate() call returned null (an
      // edge case where looksLikeDate() matched but the stricter parser didn't), so
      // this fallback re-parse path is rare but real. Without `tz`, getLocalNow()
      // inside tryParseDate() defaults to UTC, so "today"/"tomorrow"/ordinal-year
      // corrections would resolve against the server's UTC calendar day instead of
      // the business's configured timezone — the same class of bug [FIX-TZ-2] fixed
      // for the rest of this file.
      const parsedDate = rawParsedDate
        ? (rawParsedDate instanceof Date ? rawParsedDate : new Date(rawParsedDate))
        : tryParseDate(date, tz);

      let savedBooking = null;
      try {
        savedBooking = await saveBooking({
          customerPhone: session.customerPhone,
          customerName,
          date, time, service,
          partySize:    partySize || null,
          parsedDate,
          // [FIX-SALON-1] Persist stylist in dedicated staff field
          staff:        staffToSave,
          // [FIX-SALON-2] Persist booking type
          bookingType:  bookingTypeToSave,
          tenantId:     session.tenantId,
          businessId:   business._id,
        });
      } catch (err) {
        logger.error('[BookingFlow] saveBooking failed', { err: err.message });
        // [FIX-SAVE-ERR] If we couldn't persist the booking, do NOT proceed to send a
        // confirmation — the customer would think they're booked when they're not, and
        // the admin would never receive an alert. Clear the flow and show a retry prompt.
        await updateSession(session.customerPhone, session.tenantId, {
          currentFlow: null, step: null, data: {},
        });
        return {
          type:    'buttons',
          body:    `⚠️ *Something went wrong saving your booking.*\n\nPlease try again — tap below to restart.`,
          buttons: [
            { id: 'BOOK',    title: '📅 Try Again'  },
            { id: 'SUPPORT', title: '💬 Contact Us' },
          ],
        };
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
        const adminPhones = getAdminPhones(business, tenant);
        if (adminPhones.length && tenant && savedBooking) {
          const { buildAdminBookingAlertBody } = await import('../../services/admin/adminCommandService.js');
          const { dispatchMessage } = await import('../whatsapp/dispatcher.js');
          // [v14-BUG-10] Pass staff (stylist) to admin alert so admin sees who
          // the customer requested. Previously omitted — admin saw service/date/time
          // but no stylist name even when the salon booking flow captured one.
          const alertBody = buildAdminBookingAlertBody({
            customerPhone: session.customerPhone,
            date,
            time,
            service,
            partySize:   partySize || null,
            staff:       staffToSave,
            business,
            shortId: savedBooking.shortId,
          });
          const alertPayload = {
            type:    'buttons',
            body:    alertBody,
            buttons: [
              { id: `CONFIRM_BOOK_${savedBooking.shortId}`, title: '✅ Confirm' },
              { id: `DECLINE_BOOK_${savedBooking.shortId}`, title: '❌ Decline' },
            ],
          };
          for (const adminPhone of adminPhones) {
            await dispatchMessage(adminPhone, alertPayload, tenant).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn('[BookingFlow] Admin notification failed (non-fatal)', { err: err.message });
      }

      const _lcRb = await completeFlow(session, 'BOOKING', business, tenant);
      if (_lcRb) return _lcRb;

      // [FIX-BC-1] CRITICAL: isBarbershopConfirm and shortIdLine were used below
      // but never declared anywhere in this function — this was a ReferenceError crash
      // on every successful booking save, meaning NO customer ever received a booking
      // confirmation message. Both variables defined here.
      const isBarbershopConfirm = (business?.businessMode || '').toUpperCase() === 'BARBERSHOP';
      const shortIdLine = savedBooking?.shortId
        ? `🔖 Ref: \`#${savedBooking.shortId}\`\n`
        : '';

      // [v14-PREP] Service-specific preparation tip on booking receipt (salon/barbershop)
      let prepLine = '';
      if (isSalonMode && service) {
        try {
          const { getSalonPrepTip } = await import('../../modules/salon/salonHelpers.js');
          const tip = getSalonPrepTip(service, business);
          if (tip) prepLine = `\n💡 *Prep tip:* ${tip}\n`;
        } catch { /* non-fatal */ }
      }

      const confirmBody =
        `📅 *Booking Request Received!* ✨\n\n` +
        (service     ? `${isBarbershopConfirm ? '✂️' : '💇'}  Service: *${service}*\n`   : '') +
        (staffToSave ? `👤  ${isBarbershopConfirm ? 'Barber' : 'Stylist'}: *${staffToSave}*\n` : '') +
        (date        ? `📅  Date: *${date}*\n`          : '') +
        (time        ? `⏰  Time: *${time}*\n`          : '') +
        (partySize   ? `👥  Party size: *${partySize} guest${partySize > 1 ? 's' : ''}*\n` : '') +
        shortIdLine +
        prepLine +
        `\n⏳ We're reviewing your booking and will confirm shortly. We'll send you a message as soon as it's confirmed! 🙏`;

      // [SPEC-6C] No welcome/sales buttons on booking receipt — customer is waiting
      // for admin confirmation. Just a cancel escape.
      return {
        type:    'buttons',
        body:    confirmBody,
        buttons: [{ id: 'CANCEL_BOOKING', title: '❌ Cancel Booking' }],
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

function _isCancelIntent(clean, raw) {
  const normalized = String(raw || clean || '')
    .trim()
    .toLowerCase()
    .replace(/^\\+/, '')
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(cancel|cancel_booking|stop|quit|exit|nevermind|never mind)$/.test(normalized)
    || /^cancel (my )?(booking|order|it|this)( please)?$/.test(normalized);
}

/**
 * _buildDatePickerUI — standard list picker by default; Flow calendar only when explicitly enabled.
 */
function _buildDatePickerUI(headingOrError = null, tz = 'UTC', { business, tenant, customerPhone } = {}) {
  const standardPicker = buildSimpleDayList(tz, headingOrError);
  if (!shouldUseBookingDateFlow(business, tenant)) {
    return standardPicker;
  }
  const flowId = resolveBookingDateFlowId(business, tenant);
  const flowMsg = buildBookingDateFlowMessage({
    heading: headingOrError,
    tz,
    flowId,
    customerPhone,
  });
  if (flowMsg) return { ...flowMsg, fallbackUi: standardPicker };
  return standardPicker;
}

const ALL_TIME_SLOTS = [
  { id: 'TIME_9AM',  title: '9:00 AM',  minutes: 9 * 60,  period: '🌅 Morning'   },
  { id: 'TIME_10AM', title: '10:00 AM', minutes: 10 * 60, period: '🌅 Morning'   },
  { id: 'TIME_11AM', title: '11:00 AM', minutes: 11 * 60, period: '🌅 Morning'   },
  { id: 'TIME_12PM', title: '12:00 PM', minutes: 12 * 60, period: '☀️ Afternoon' },
  { id: 'TIME_1PM',  title: '1:00 PM',  minutes: 13 * 60, period: '☀️ Afternoon' },
  { id: 'TIME_2PM',  title: '2:00 PM',  minutes: 14 * 60, period: '☀️ Afternoon' },
  { id: 'TIME_3PM',  title: '3:00 PM',  minutes: 15 * 60, period: '☀️ Afternoon' },
  { id: 'TIME_4PM',  title: '4:00 PM',  minutes: 16 * 60, period: '☀️ Afternoon' },
  { id: 'TIME_5PM',  title: '5:00 PM',  minutes: 17 * 60, period: '🌆 Evening'   },
  { id: 'TIME_6PM',  title: '6:00 PM',  minutes: 18 * 60, period: '🌆 Evening'   },
  { id: 'TIME_7PM',  title: '7:00 PM',  minutes: 19 * 60, period: '🌆 Evening'   },
];

function _filterAvailableTimeSlots({ tz = 'UTC', bookingDate = null } = {}) {
  const localNow = getLocalNow(tz);
  const localToday = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()));
  const bookingIsToday = bookingDate && bookingDate.getTime() === localToday.getTime();
  const nowMinutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
  const GRACE = 5;

  return ALL_TIME_SLOTS.filter((slot) => {
    if (!bookingIsToday) return true;
    return slot.minutes >= nowMinutes - GRACE;
  });
}

/**
 * _buildTimePickerUI — tap-only time list; hides past slots when booking is today.
 */
function _buildTimePickerUI(headingOrError = null, { tz = 'UTC', bookingDate = null } = {}) {
  const available = _filterAvailableTimeSlots({ tz, bookingDate });

  const sections = [];
  for (const slot of available.slice(0, 10)) {
    let sec = sections.find(s => s.title === slot.period);
    if (!sec) {
      sec = { title: slot.period, rows: [] };
      sections.push(sec);
    }
    sec.rows.push({ id: slot.id, title: slot.title });
  }

  const body = headingOrError
    ? `${headingOrError}\n\nPlease select your preferred time.`
    : `What time works for you? ⏰\n\nPlease select your preferred time.`;

  if (!sections.length) {
    return {
      type:    'buttons',
      body:    `${body}\n\n⚠️ No slots left today. Please pick a later date or type a time.`,
      buttons: [{ id: 'DATE_BACK', title: '📅 Change date' }, { id: 'CANCEL', title: '❌ Cancel' }],
    };
  }

  return {
    type: 'list',
    body,
    button: 'Choose a time',
    sections,
  };
}

/**
 * Resume booking at the shared DATE step after a reschedule — shows the
 * professional date picker immediately instead of a plain-text prompt.
 */
export async function buildRescheduleDatePicker({ session, business, tenant, resumeData = {} }) {
  const data = {
    service:         resumeData.service ?? resumeData.selectedService ?? null,
    selectedService: resumeData.selectedService ?? resumeData.service ?? null,
    stylist:         resumeData.stylist ?? resumeData.staff ?? null,
  };

  await updateSession(session.customerPhone, session.tenantId, {
    currentFlow: 'BOOKING',
    step:        'DATE',
    postFlowAck: null,
    postFlowData: null,
    data,
  });

  return handleBookingFlow({
    session: { ...session, currentFlow: 'BOOKING', step: 'DATE', postFlowAck: null, data },
    message: null,
    business,
    tenant,
    isInteractive: false,
  });
}

