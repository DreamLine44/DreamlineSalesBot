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
 * [FIX-A] postFlowAck on completion (not clearSession)
 */

import { updateSession }           from '../sessions/sessionService.js';
import { completeFlow }            from './flowEngine.js';
import { saveBooking }             from '../../services/bookingService.js';
import { buildAdminBookingAlert }  from '../../services/adminCommandService.js';
import { trackBookingAnalytics }   from '../analytics/analyticsService.js';
import { dispatchText }            from '../whatsapp/dispatcher.js';
import logger                      from '../../config/logger.js';

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * tryParseDate — converts free-text date to JS Date.
 * Strips ordinal suffixes (st/nd/rd/th) before native parse.
 * [FIX-B] "15th March" was returning Invalid Date — now stripped to "15 March"
 */
export function tryParseDate(dateStr) {
  if (!dateStr) return null;
  try {
    const now   = new Date();
    const lower = String(dateStr).toLowerCase().trim();

    if (lower === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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

    // Strip ordinal suffixes: "15th" → "15", "1st" → "1"
    const stripped = dateStr.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');

    // Native parse on stripped string
    const parsed = new Date(stripped);
    if (!isNaN(parsed.getTime())) {
      // If year is implausible, add current year
      if (parsed.getFullYear() < now.getFullYear()) {
        const withYear = `${stripped} ${now.getFullYear()}`;
        const p2 = new Date(withYear);
        if (!isNaN(p2.getTime())) return p2;
      }
      return parsed;
    }

    // Last resort: add current year
    const withYear = `${stripped} ${now.getFullYear()}`;
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

function validateDate(dateInput) {
  const parsed = tryParseDate(dateInput);
  if (!parsed) return null; // unparseable — don't block

  const nowMidnight = new Date();
  nowMidnight.setHours(0, 0, 0, 0);

  if (parsed < nowMidnight) {
    const fmt = parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    return {
      error: `⚠️ *${fmt}* has already passed.\n\nPlease choose an *upcoming date*.\n\n(e.g. *tomorrow*, *next Friday*, *25 June*)`,
    };
  }

  const maxFuture = new Date();
  maxFuture.setMonth(maxFuture.getMonth() + 18);
  if (parsed > maxFuture) {
    return {
      error: `⚠️ That date is too far in the future. We accept bookings up to *18 months* ahead.\n\n(e.g. *next week*, *25 June*)`,
    };
  }

  return { parsed };
}

// ── Booking flow handler ───────────────────────────────────────────────────────
export async function handleBookingFlow({ session, message, business, tenant, isInteractive }) {
  const raw      = String(message || '').trim();
  const clean    = raw.toLowerCase().trim();
  const step     = session.step;
  const data     = session.data || {};
  const services = (business?.services || []).filter(s => s.available !== false);

  // ── INIT ──────────────────────────────────────────────────────────────────
  if (message === null) {
    // Determine first step
    const firstStep = services.length ? 'SELECT_SERVICE' : 'DATE';
    await updateSession(session.customerPhone, session.tenantId, { step: firstStep, data: {} });

    if (firstStep === 'SELECT_SERVICE') {
      const serviceList = services.map((s, i) => `*${i+1}.* ${s.name}${s.price ? ` — D${s.price}` : ''}${s.duration ? ` (${s.duration} min)` : ''}`).join('\n');
      return {
        type:    'buttons',
        body:    `Which service would you like to book?\n\n${serviceList}`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }
    // No services — for restaurants ask party size first, then date
    const isRestaurant = (business?.businessMode || '').toUpperCase() === 'RESTAURANT';
    if (isRestaurant) {
      await updateSession(session.customerPhone, session.tenantId, { step: 'PARTY_SIZE', data: {} });
      return {
        type:    'buttons',
        body:    `How many guests will be dining? 👥\n\n(e.g. *2*, *4*, *six*)`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel Booking' }],
      };
    }
    return {
      type:    'buttons',
      body:    `What date would you like to book? 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`,
      buttons: [{ id: 'CANCEL', title: '❌ Cancel Booking' }],
    };
  }

  switch (step) {

    case 'SELECT_SERVICE': {
      const idx = parseInt(raw, 10) - 1;
      let service = null;

      if (!isNaN(idx) && services[idx]) {
        service = services[idx];
      } else {
        service = services.find(s => s.name.toLowerCase().includes(clean));
      }

      if (!service) {
        const list = services.map((s, i) => `*${i+1}.* ${s.name}`).join('\n');
        return {
          type:    'buttons',
          body:    `Please choose a service by number or name:\n\n${list}`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
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
          body:    `Great — *${service.name}* selected! ✅\n\nHow many guests will be dining? 👥\n\n(e.g. *2*, *4*, *six*)`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      return {
        type:    'buttons',
        body:    `Great — *${service.name}* selected! ✅\n\nWhat date would you like? 📅\n\n(e.g. *25 June*, *tomorrow*, *next Friday*)`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
      };
    }

    // [FIX-7] PARTY_SIZE step — only reached for RESTAURANT mode
    case 'PARTY_SIZE': {
      const { parseQuantity } = await import('../../utils/parseQuantity.js');
      const partySize = parseQuantity(raw);
      if (!partySize || partySize < 1) {
        return {
          type:    'buttons',
          body:    `Please enter the number of guests (e.g. *2*, *four*, *6*):`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
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
      return {
        type:    'buttons',
        body:    `Perfect — *${partySize} guest${partySize > 1 ? 's' : ''}* 👥\n\nWhat date would you like? 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`,
        buttons: [{ id: 'CANCEL', title: '❌ Cancel Booking' }],
      };
    }

    case 'DATE': {
      if (!looksLikeDate(raw)) {
        const isBareOrdinal = /^\d{1,2}(st|nd|rd|th)$/i.test(raw.trim());
        const hint = isBareOrdinal
          ? `I need the *month* too 📅\n\nFor example:\n• *${raw} June*\n• *${raw} July*\n• *${raw} August*`
          : `I couldn't recognise *${raw}* as a date.\n\nExamples: *25 June*, *tomorrow*, *next Friday*`;
        return { type: 'buttons', body: hint, buttons: [{ id: 'CANCEL', title: '❌ Cancel' }] };
      }

      // [FIX-B] Past/future validation
      const validation = validateDate(raw);
      if (validation?.error) {
        return { type: 'buttons', body: validation.error, buttons: [{ id: 'CANCEL', title: '❌ Cancel' }] };
      }

      await updateSession(session.customerPhone, session.tenantId, {
        step: 'DATE_CONFIRM', data: { ...data, date: raw, parsedDate: validation?.parsed || null },
      });
      return {
        type:    'buttons',
        body:    `Just to confirm — did you mean *${raw}*? 📅`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
      };
    }

    case 'DATE_CONFIRM': {
      if (clean === 'confirm' || /^(yes|y|yep|yeah)$/i.test(clean)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'TIME' });
        return {
          type:    'buttons',
          body:    `And what time? ⏰\n\n(e.g. *10:00*, *2pm*, *14:30*)`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      if (clean === 'date_back' || /^(no|n|re-enter|change|back)$/i.test(clean)) {
        await updateSession(session.customerPhone, session.tenantId, { step: 'DATE' });
        return {
          type:    'buttons',
          body:    `What date would you like? 📅\n\n(e.g. *25 June*, *tomorrow*, *next Monday*)`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      // Inline new date
      if (looksLikeDate(raw)) {
        const v2 = validateDate(raw);
        if (v2?.error) return { type: 'buttons', body: v2.error, buttons: [{ id: 'CANCEL', title: '❌ Cancel' }] };
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'DATE_CONFIRM', data: { ...data, date: raw, parsedDate: v2?.parsed || null },
        });
        return {
          type:    'buttons',
          body:    `Just to confirm — did you mean *${raw}*? 📅`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ No, re-enter' }],
        };
      }
      return {
        type:    'buttons',
        body:    `Please confirm *${data.date}*, or go back to re-enter.`,
        buttons: [{ id: 'CONFIRM', title: '✅ Yes, that date' }, { id: 'DATE_BACK', title: '❌ Re-enter' }],
      };
    }

    case 'TIME': {
      if (!looksLikeTime(raw)) {
        return {
          type:    'buttons',
          body:    `Please enter a valid time ⏰\n\n(e.g. *10:00*, *2pm*, *14:30*)`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      await updateSession(session.customerPhone, session.tenantId, {
        step: 'TIME_CONFIRM', data: { ...data, time: raw },
      });
      return {
        type:    'buttons',
        body:    `Confirm time: *${raw}*? ⏰`,
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
        return {
          type:    'buttons',
          body:    `What time works for you? ⏰\n\n(e.g. *10:00*, *2pm*, *14:30*)`,
          buttons: [{ id: 'CANCEL', title: '❌ Cancel' }],
        };
      }
      if (looksLikeTime(raw)) {
        await updateSession(session.customerPhone, session.tenantId, {
          step: 'TIME_CONFIRM', data: { ...data, time: raw },
        });
        return {
          type:    'buttons',
          body:    `Confirm time: *${raw}*? ⏰`,
          buttons: [{ id: 'CONFIRM', title: '✅ Yes' }, { id: 'TIME_BACK', title: '❌ Re-enter' }],
        };
      }
      return {
        type:    'buttons',
        body:    `Please confirm *${data.time}*, or go back to re-enter.`,
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
      const { date, time, service, parsedDate, partySize } = data;

      let savedBooking = null;
      try {
        savedBooking = await saveBooking({
          customerPhone: session.customerPhone,
          customerName,
          date, time, service,
          partySize:    partySize || null,
          parsedDate:   parsedDate || tryParseDate(date),
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

      return {
        type:    'buttons',
        body:    confirmBody,
        buttons: [
          { id: 'ORDER',     title: '🛍 Place an Order'  },
          { id: 'QUESTION',  title: '❓ Ask a Question'  },
          { id: 'SHOW_MENU', title: '🔄 Start Over'      },
        ],
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
