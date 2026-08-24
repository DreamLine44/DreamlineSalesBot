/**
 * bookingDatePickerUI.js
 *
 * WhatsApp-friendly date picker: hub → week list / month list → day list.
 * Lists are the closest equivalent to dropdowns on WhatsApp (max 10 rows).
 */

import {
  getLocalNow,
  formatBookingDateLabel,
  resolveBookingDateInput,
  MAX_BOOKING_MONTHS_AHEAD,
} from './bookingDateParser.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function toDayId(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `DATE_D_${y}${m}${day}`;
}

export function parseDayId(raw) {
  const m = String(raw || '').toUpperCase().match(/^DATE_D_(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
}

export function parseMonthId(raw) {
  const m = String(raw || '').toUpperCase().match(/^DATE_M_(\d{4})(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) - 1 };
}

function addDays(base, n) {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + n));
}

function localMidnight(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function maxBookableDate(now) {
  const max = localMidnight(now);
  max.setUTCMonth(max.getUTCMonth() + MAX_BOOKING_MONTHS_AHEAD);
  return max;
}

function shortWeekday(d) {
  return d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

function shortMonthDay(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Simple one-step picker: next 10 bookable days in a single list. */
export function buildSimpleDayList(tz, headingOrError = null) {
  const now = getLocalNow(tz);
  const today = localMidnight(now);
  const maxDate = maxBookableDate(now);
  let cursor = today;
  if (now.getUTCHours() >= 20) cursor = addDays(today, 1);

  const rows = [];
  for (let i = 0; rows.length < 10; i++) {
    const d = addDays(cursor, i);
    if (d > maxDate) break;
    const offsetFromToday = Math.round((d - today) / 86400000);
    const title = offsetFromToday === 0
      ? '📅 Today'
      : offsetFromToday === 1
        ? '📅 Tomorrow'
        : `📅 ${shortWeekday(d)} ${shortMonthDay(d)}`;
    rows.push({
      id: toDayId(d),
      title: title.slice(0, 24),
      description: formatBookingDateLabel(d, tz).slice(0, 72),
    });
  }

  const body = headingOrError
    ? `${headingOrError}\n\nPlease select your preferred date.`
    : `What date would you like? 📅\n\nPlease select your preferred date.`;

  return {
    type:     'list',
    body,
    button:   'Choose a date',
    sections: [{ title: '📅 Upcoming dates', rows }],
  };
}

/** Hub: This week / Next week / Choose month (3 buttons — legacy fallback). */
export function buildDatePickerHub(headingOrError = null) {
  const body = headingOrError
    ? `${headingOrError}\n\nPlease select how you'd like to choose your date.`
    : `What date would you like? 📅\n\nPlease select how you'd like to choose your date.`;

  return {
    type:    'buttons',
    body,
    buttons: [
      { id: 'DATE_HUB_WEEK_0', title: '📅 This week'    },
      { id: 'DATE_HUB_WEEK_1', title: '📅 Next week'    },
      { id: 'DATE_HUB_MONTH',  title: '📆 Choose month' },
    ],
  };
}

/** Week slice as a dropdown-style list (7 days). */
export function buildWeekDayList(weekOffset, tz, heading = null) {
  const now = getLocalNow(tz);
  const today = localMidnight(now);
  const maxDate = maxBookableDate(now);
  let start = addDays(today, weekOffset * 7);
  if (weekOffset === 0 && now.getUTCHours() >= 20) start = addDays(today, 1);

  const rows = [];
  for (let i = 0; i < 7 && rows.length < 10; i++) {
    const d = addDays(start, i);
    if (d > maxDate) break;
    const offsetFromToday = Math.round((d - today) / 86400000);
    const title = offsetFromToday === 0
      ? '📅 Today'
      : offsetFromToday === 1
        ? '📅 Tomorrow'
        : `📅 ${shortWeekday(d)} ${shortMonthDay(d)}`;
    rows.push({
      id: toDayId(d),
      title: title.slice(0, 24),
      description: formatBookingDateLabel(d, tz).slice(0, 72),
    });
  }

  const label = weekOffset === 0 ? 'This week' : 'Next week';
  const body = heading
    ? `${heading}\n\nPlease select a day from ${label.toLowerCase()}.`
    : `${label} — please select your preferred day.`;

  return {
    type:     'list',
    body,
    button:   'Pick a day',
    sections: [{ title: `📅 ${label}`, rows }],
  };
}

/** Month dropdown — next bookable months (max 10 rows). */
export function buildMonthPickerList(tz, heading = null) {
  const now = getLocalNow(tz);
  const today = localMidnight(now);
  const maxDate = maxBookableDate(now);

  const rows = [];
  let cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

  while (rows.length < 10 && cursor <= maxDate) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const monthEnd = new Date(Date.UTC(y, m + 1, 0));
    if (monthEnd >= today) {
      const id = `DATE_M_${y}${String(m + 1).padStart(2, '0')}`;
      rows.push({
        id,
        title: `📆 ${MONTH_NAMES[m]} ${y}`.slice(0, 24),
        description: 'Tap to pick a day',
      });
    }
    cursor = new Date(Date.UTC(y, m + 1, 1));
  }

  const body = heading
    ? `${heading}\n\nPlease select a month.`
    : `Please select a month, then choose your preferred day.`;

  return {
    type:     'list',
    body,
    button:   'Choose month',
    sections: [{ title: '📆 Months', rows }],
  };
}

/** Day dropdown for a chosen month (paginated, 9 days + nav row). */
export function buildMonthDayList({ year, month, tz, page = 0, heading = null }) {
  const now = getLocalNow(tz);
  const today = localMidnight(now);
  const maxDate = maxBookableDate(now);
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const bookable = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, month, day));
    if (d >= today && d <= maxDate) bookable.push(d);
  }

  const pageSize = 9;
  const start = page * pageSize;
  const slice = bookable.slice(start, start + pageSize);
  const hasMore = start + pageSize < bookable.length;

  const rows = [];
  if (page > 0) {
    const ym = `${year}${String(month + 1).padStart(2, '0')}`;
    rows.push({
      id:    `DATE_DAY_MORE_${ym}_${page - 1}`,
      title: '⬅️ Previous days',
      description: 'Go back',
    });
  }

  const daySlots = 10 - rows.length - (hasMore ? 1 : 0) - 1;
  for (const d of slice.slice(0, Math.max(daySlots, 1))) {
    rows.push({
      id: toDayId(d),
      title: `📅 ${shortWeekday(d)} ${d.getUTCDate()}`.slice(0, 24),
      description: formatBookingDateLabel(d, tz).slice(0, 72),
    });
  }

  if (hasMore && rows.length < 9) {
    const ym = `${year}${String(month + 1).padStart(2, '0')}`;
    rows.push({
      id:    `DATE_DAY_MORE_${ym}_${page + 1}`,
      title: '➡️ More days…',
      description: 'Show more days this month',
    });
  }

  rows.push({
    id:    'DATE_MONTH_BACK',
    title: '⬅️ Change month',
    description: 'Pick a different month',
  });

  const monthLabel = `${MONTH_NAMES[month]} ${year}`;
  const body = heading
    ? `${heading}\n\nPlease select a day in ${monthLabel}.`
    : `${monthLabel} — please select your preferred day.`;

  return {
    type:     'list',
    body,
    button:   'Pick a day',
    sections: [{ title: `📅 ${monthLabel}`, rows: rows.slice(0, 10) }],
  };
}

export async function resolveDayPick(raw, tz) {
  const parsed = parseDayId(raw);
  if (!parsed) return null;
  const resolved = await resolveBookingDateInput(
    `${parsed.getUTCDate()} ${MONTH_NAMES[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`,
    tz,
  );
  return resolved.ok ? resolved : null;
}
