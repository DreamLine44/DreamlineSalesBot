/**
 * bookingState.js — single source of truth helpers for in-flow booking fields.
 * Keeps parsedDate, human label, and ISO date aligned across confirm → save → track.
 */

import { tryParseDate } from './bookingDateParser.js';

/** YYYY-MM-DD from a UTC-midnight booking Date. */
export const bookingDateIsoFromParsed = (parsed) => {
  if (!parsed) return null;
  const d = parsed instanceof Date ? parsed : new Date(parsed);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const parsedFromBookingDateIso = (iso) => {
  const m = String(iso || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  if (bookingDateIsoFromParsed(d) !== m[0]) return null;
  return d;
}

/**
 * Resolve authoritative booking date from session data.
 * Prefer bookingDateIso → parsedDate → label parse (last resort).
 */
export const coerceBookingParsedDate = (data, tz = 'UTC') => {
  if (!data) return null;

  if (data.bookingDateIso) {
    const fromIso = parsedFromBookingDateIso(data.bookingDateIso);
    if (fromIso) return fromIso;
  }

  if (data.parsedDate) {
    const d = data.parsedDate instanceof Date ? data.parsedDate : new Date(data.parsedDate);
    if (!isNaN(d.getTime())) return d;
  }

  if (data.date) {
    const parsed = tryParseDate(data.date, tz);
    if (parsed) return parsed;
  }

  return null;
}

/** Merge confirmed date fields into session booking data without re-parsing. */
export const enrichBookingSessionData = (data, { parsed, label, raw, tz = 'UTC' }) => {
  const parsedDate = parsed instanceof Date ? parsed : new Date(parsed);
  const bookingDateIso = bookingDateIsoFromParsed(parsedDate);
  return {
    ...(data || {}),
    date:      label,
    dateRaw:   raw || label,
    parsedDate,
    bookingDateIso,
  };
}

/** Snapshot from a saved Booking document for post-flow / tracking context. */
export const bookingSnapshotFromSaved = (saved) => {
  if (!saved) return null;
  return {
    shortId:        saved.shortId || null,
    date:           saved.date || null,
    time:           saved.time || null,
    partySize:      saved.partySize ?? null,
    service:        saved.service || null,
    staff:          saved.staff || null,
    bookingType:    saved.bookingType || null,
    parsedDate:     saved.parsedDate || null,
    bookingDateIso: bookingDateIsoFromParsed(saved.parsedDate) || null,
  };
}
