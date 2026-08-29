/**
 * bookingInterpretation.js
 *
 * Thin NL interpretation layer: extract structured booking fields from free text
 * and merge them into session data. Execution stays in bookingFlow.js.
 */

import logger from '../../config/logger.js';
import {
  parseDirectBookingRequest,
  resolveDirectBookingStep,
} from '../../core/shared/moduleRegistry.js';
import { MAX_PARTY_SIZE } from '../../utils/parsePartySize.js';
import { isBookingDateClosed, formatClosedDayMessage } from '../../utils/businessHoursUtils.js';
import { coerceBookingParsedDate } from './bookingState.js';

const SYSTEM_ACTIONS = new Set([
  'CONFIRM', 'CANCEL', 'CANCEL_BOOKING', 'CANCEL_ORDER',
  'DATE_BACK', 'TIME_BACK', 'DATE_HUB_BACK', 'DATE_MONTH_BACK',
  'MFQ_SWITCH_YES', 'MFQ_SWITCH_NO', 'MFQ_RESUME_FLOW',
  'FSI_SWITCH_YES', 'FSI_SWITCH_NO',
  'SHOW_MENU', 'MENU', 'HOME', '0',
]);

const SYSTEM_ACTION_RE = /^(PARTY_|DATE_|TIME_|SVC_|DATE_HUB_|DATE_DAY_|DATE_PICK_|TIME_M_)/;

const isoFromParsed = (parsed) => {
  if (!parsed) return null;
  const d = parsed instanceof Date ? parsed : new Date(parsed);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const coerceParsedDate = (data, tz) => {
  return coerceBookingParsedDate(data, tz);
}

/** Button / list ids — never treat as NL date/time/guest input. */
export const isBookingSystemAction = (raw) => {
  const upper = String(raw || '').trim().toUpperCase();
  if (!upper) return false;
  if (SYSTEM_ACTIONS.has(upper)) return true;
  if (SYSTEM_ACTION_RE.test(upper)) return true;
  if (upper === 'CONFIRM' || upper === 'DATE_BACK' || upper === 'TIME_BACK') return true;
  return false;
}

/**
 * Guard merged NL data before skipping ahead — same rules as the stepped flow.
 * Returns a UI payload to show, or null when safe to continue.
 */
export const guardMergedBookingData = (data, business, tz, {
  buildPartySizeErrorFn,
  buildDatePickerFn,
  buildTimePickerFn,
  validateTimeFn,
} = {}) => {
  if (data.partySize && data.partySize > MAX_PARTY_SIZE) {
    return buildPartySizeErrorFn?.() || null;
  }

  const parsedDate = coerceParsedDate(data, tz);
  if (parsedDate && business?.hours?.enabled && isBookingDateClosed(parsedDate, business.hours, tz)) {
    const msg = formatClosedDayMessage(data.date, business.hours, tz, parsedDate);
    return buildDatePickerFn?.(msg) || null;
  }

  if (parsedDate && data.time && validateTimeFn) {
    const tv = validateTimeFn(data.time, parsedDate, tz);
    if (tv?.error) return buildTimePickerFn?.(tv.error, { tz, bookingDate: parsedDate, business }) || null;
  }

  return null;
}

/**
 * Extract guests / date / time from a message and merge into existing booking data.
 * Uses parsedDate as source of truth once normalized — never re-parses data.date label.
 */
export const interpretBookingMessage = async (message, business, existingData = {}) => {
  const raw = String(message || '').trim();
  if (!raw || isBookingSystemAction(raw)) {
    return { extracted: null, merged: { ...existingData }, changed: false, changedFields: { partySize: false, date: false, time: false } };
  }

  const extracted = await parseDirectBookingRequest(raw, business);
  if (!extracted) {
    return { extracted: null, merged: { ...existingData }, changed: false, changedFields: { partySize: false, date: false, time: false } };
  }

  const merged = { ...(existingData || {}) };
  let changed = false;
  const changedFields = { partySize: false, date: false, time: false };

  if (extracted.partySize) {
    if (extracted.partySize <= MAX_PARTY_SIZE) {
      if (merged.partySize !== extracted.partySize) {
        changed = true;
        changedFields.partySize = true;
      }
      merged.partySize = extracted.partySize;
    }
  }
  if (extracted.parsedDate && extracted.date) {
    const newIso = isoFromParsed(extracted.parsedDate);
    const oldIso = merged.bookingDateIso || isoFromParsed(merged.parsedDate);
    if (newIso !== oldIso || merged.date !== extracted.date) {
      changed = true;
      changedFields.date = true;
    }
    merged.date = extracted.date;
    merged.parsedDate = extracted.parsedDate;
    merged.dateRaw = extracted.dateRaw || extracted.date;
    merged.bookingDateIso = newIso;
    if (changedFields.date) delete merged.time;
  }
  if (extracted.time) {
    if (merged.time !== extracted.time) {
      changed = true;
      changedFields.time = true;
    }
    merged.time = extracted.time;
  }

  logger.debug('[BookingInterpret] NL booking trace', {
    rawMessage: raw.slice(0, 160),
    intent: 'BOOK_TABLE',
    guests: extracted.partySize ?? merged.partySize ?? null,
    dateExpression: extracted.dateRaw || null,
    normalizedDate: isoFromParsed(extracted.parsedDate || merged.parsedDate),
    time: extracted.time ?? merged.time ?? null,
    changed,
    changedFields,
  });

  return { extracted, merged, changed, changedFields };
}

/** Where the booking should resume given merged field values. */
export const resolveBookingResumeStep = (data, business) => {
  const isRestaurant = (business?.businessMode || '').toUpperCase() === 'RESTAURANT';
  return resolveDirectBookingStep({
    partySize: data.partySize || null,
    date:      data.date || null,
    time:      data.time || null,
    isRestaurant,
  });
}

/**
 * After NL merge, skip ahead to the appropriate booking UI when the message
 * already supplied fields for later steps. Returns a UI payload or null to
 * fall through to the normal step handler.
 */
export const continueFromMergedBookingData = async ({
  session, data, step, business, tenant, tz, changed = false,
  changedFields = { partySize: false, date: false, time: false },
  confirmBookingDateFn,
  buildBookingSummaryFn,
  buildTimePickerFn,
  buildPartySizeErrorFn,
  buildDatePickerFn,
  validateTimeFn,
}) => {
  const resumeStep = resolveBookingResumeStep(data, business);
  if (!resumeStep) {
    if (changed) await updateSessionFromInterpretation(session, data, step);
    return null;
  }

  const guardUi = guardMergedBookingData(data, business, tz, {
    buildPartySizeErrorFn,
    buildDatePickerFn,
    buildTimePickerFn,
    validateTimeFn,
  });
  if (guardUi) {
    if (changed) await updateSessionFromInterpretation(session, data, step);
    return guardUi;
  }

  const STEP_RANK = {
    SELECT_SERVICE: 0, PARTY_SIZE: 1, DATE: 2, DATE_CONFIRM: 3,
    TIME: 4, TIME_CONFIRM: 5, BOOKING_CONFIRM: 6,
  };
  const currentRank = STEP_RANK[step] ?? 0;
  let effectiveResumeStep = resumeStep;

  // Date corrections must re-confirm before time/summary — clear stale time.
  if (changedFields.date && ['DATE_CONFIRM', 'TIME', 'TIME_CONFIRM', 'BOOKING_CONFIRM'].includes(step)) {
    delete data.time;
    effectiveResumeStep = 'DATE_CONFIRM';
  }

  // At DATE_CONFIRM, never skip the date confirmation button — store extras only.
  if (step === 'DATE_CONFIRM' && STEP_RANK[effectiveResumeStep] > STEP_RANK.DATE_CONFIRM) {
    effectiveResumeStep = 'DATE_CONFIRM';
  }

  const targetRank = STEP_RANK[effectiveResumeStep] ?? 0;

  if (effectiveResumeStep === step) {
    await updateSessionFromInterpretation(session, data, step);
    if (effectiveResumeStep === 'BOOKING_CONFIRM') return buildBookingSummaryFn(data, business);
    if (effectiveResumeStep === 'DATE_CONFIRM' && data.parsedDate && data.date) {
      return confirmBookingDateFn(session, data, {
        ok: true,
        parsed: coerceParsedDate(data, tz),
        label: data.date,
        raw: data.dateRaw || data.date,
      }, { business, tenant, tz });
    }
    return null;
  }

  if (targetRank <= currentRank) {
    if (!changed) return null;
    if (step === 'BOOKING_CONFIRM') {
      await updateSessionFromInterpretation(session, data, step);
      return buildBookingSummaryFn(data, business);
    }
    if (effectiveResumeStep === 'DATE_CONFIRM' && data.parsedDate && data.date) {
      await updateSessionFromInterpretation(session, data, 'DATE_CONFIRM');
      return confirmBookingDateFn(session, data, {
        ok: true,
        parsed: coerceParsedDate(data, tz),
        label: data.date,
        raw: data.dateRaw || data.date,
      }, { business, tenant, tz });
    }
    if (effectiveResumeStep === 'TIME_CONFIRM' && data.time) {
      await updateSessionFromInterpretation(session, data, 'TIME_CONFIRM');
      return {
        type:    'buttons',
        body:    `Confirm time: *${data.time}*? ⏰`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ No, re-enter' }],
      };
    }
    await updateSessionFromInterpretation(session, data, step);
    return null;
  }

  await updateSessionFromInterpretation(session, data, effectiveResumeStep);

  if (effectiveResumeStep === 'DATE_CONFIRM' && data.parsedDate && data.date) {
    return confirmBookingDateFn(session, data, {
      ok: true,
      parsed: coerceParsedDate(data, tz),
      label: data.date,
      raw: data.dateRaw || data.date,
    }, { business, tenant, tz });
  }
  if (effectiveResumeStep === 'TIME' && data.parsedDate) {
    const bookingParsedDate = coerceParsedDate(data, tz);
    const heading = data.partySize && data.date
      ? `*${data.partySize} guest${data.partySize > 1 ? 's' : ''}* on *${data.date}* 👥\n\nWhat time works for you? ⏰`
      : null;
    return buildTimePickerFn(heading, { tz, bookingDate: bookingParsedDate, business });
  }
  if (effectiveResumeStep === 'TIME_CONFIRM' && data.time) {
    return {
      type:    'buttons',
      body:    `Confirm time: *${data.time}*? ⏰`,
      buttons: [{ id: 'CONFIRM', title: '✅ Yes, that time' }, { id: 'TIME_BACK', title: '❌ No, re-enter' }],
    };
  }
  if (effectiveResumeStep === 'BOOKING_CONFIRM') {
    return buildBookingSummaryFn(data, business);
  }
  if (effectiveResumeStep === 'DATE' && data.partySize && !data.parsedDate) {
    return null; // fall through — PARTY_SIZE handler will set heading
  }

  return null;
}

const updateSessionFromInterpretation = async (session, data, step) => {
  const { updateSession } = await import('../../core/sessions/sessionService.js');
  await updateSession(session.customerPhone, session.tenantId, { step, data });
}
