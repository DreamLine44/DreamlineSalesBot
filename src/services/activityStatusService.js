/**
 * services/activityStatusService.js
 *
 * Single source of truth for activity-scoped status lookups (Prompt 1 + 4).
 * Orders query Order records only; bookings query Booking records only.
 * Status is never inferred from conversation history — DB only.
 */

import { resolveActiveOrder } from './activeOrderResolver.js';
import { getActiveBookings } from './bookingService.js';
import { formatOrderItemSummary } from './orderService.js';
import { getModeConfig } from '../config/modes.js';

const ORDER_STATUS_LABELS = {
  pending:                      '⏳ Pending',
  payment_pending_verification: '⏳ Awaiting payment verification',
  confirmed:                    '✅ Confirmed',
  preparing:                    '👨‍🍳 Preparing',
  ready:                        '📦 Ready for collection',
  out_for_delivery:             '🚚 Out for delivery',
  delivered:                    '✅ Delivered',
  completed:                    '✅ Completed',
};

const PAYMENT_STATUS_LABELS = {
  unpaid:         '💳 Awaiting payment',
  proof_received: '📸 Payment screenshot received — verifying',
  verified:       '✅ Payment verified',
  paid:           '✅ Paid',
  confirmed:      '✅ Payment confirmed',
  rejected:       '❌ Payment rejected — please resubmit',
};

const BOOKING_STATUS_LABELS = {
  pending:   '⏳ Awaiting confirmation',
  confirmed: '✅ Confirmed',
};

/**
 * Detect whether the customer asked about orders, bookings, or both.
 * Explicit mentions win over generic phrasing like bare "status".
 */
export function detectStatusScope(message) {
  const raw = String(message || '').trim().toLowerCase();
  if (!raw) return 'BOTH';

  const bookingOnly = /\b(track my booking|booking status|check my booking|where is my booking|my booking|check my appointment|appointment status|my appointment|my reservation|reservation status|check my reservation|active booking)\b/.test(raw);
  const orderOnly = /\b(track my order|order status|check my order|where is my order|my order|where('s| is) my food|check my delivery|delivery status|active order)\b/.test(raw);

  if (bookingOnly && !orderOnly) return 'BOOKING';
  if (orderOnly && !bookingOnly) return 'ORDER';

  const mentionsBooking = /\b(booking|bookings?|appointment|appointments?|reservation|reservations?)\b/.test(raw);
  const mentionsOrder = /\b(order|orders?|delivery|food)\b/.test(raw) && !/\bbooking\b/.test(raw);

  if (mentionsBooking && !mentionsOrder) return 'BOOKING';
  if (mentionsOrder && !mentionsBooking) return 'ORDER';

  return 'BOTH';
}

export function formatOrderStatusCard(order, business) {
  if (!order) return '';
  const ref = order.shortId || '???';
  const items = formatOrderItemSummary(order);
  const status = ORDER_STATUS_LABELS[order.status] || order.status;
  const payment = PAYMENT_STATUS_LABELS[order.paymentStatus] || order.paymentStatus || '—';
  const updated = order.updatedAt || order.createdAt;
  const updatedStr = updated ? new Date(updated).toLocaleString() : '—';

  return (
    `📦 *Order #${ref}*\n` +
    `• Items: ${items}\n` +
    `• Status: ${status}\n` +
    `• Payment: ${payment}\n` +
    `• Last updated: ${updatedStr}`
  );
}

export function formatBookingStatusCard(booking) {
  if (!booking) return '';
  const ref = booking.shortId || '???';
  const when = [booking.date, booking.time].filter(Boolean).join(' at ') || '—';
  const guests = booking.partySize ? `${booking.partySize}` : '—';
  const status = BOOKING_STATUS_LABELS[booking.status] || booking.status;

  return (
    `📅 *Booking #${ref}*\n` +
    `• Date: ${booking.date || '—'}\n` +
    `• Time: ${booking.time || '—'}\n` +
    `• Guests: ${guests}\n` +
    `• Status: ${status}` +
    (when !== '—' && !booking.date ? `\n• When: ${when}` : '')
  );
}

function _defaultButtons(business) {
  const cfg = getModeConfig(business);
  const canOrder = cfg.flows?.includes('ORDER');
  return [
    canOrder ? { id: 'ORDER', title: '🛍 New Order' } : null,
    { id: 'SUPPORT', title: '💬 Contact Support' },
    { id: 'SHOW_MENU', title: '🔄 Start Over' },
  ].filter(Boolean).slice(0, 3);
}

function _multipleBookingsList(bookings) {
  const rows = bookings.slice(0, 9).map(b => ({
    id:          `BOOKING_STATUS_${b.shortId || String(b._id).slice(-6).toUpperCase()}`,
    title:       `#${b.shortId || '???'} — ${(b.date || 'Booking').slice(0, 24)}`,
    description: `${BOOKING_STATUS_LABELS[b.status] || b.status}${b.partySize ? ` · ${b.partySize} guests` : ''}`,
  }));

  return {
    type: 'list',
    body: `📅 You have *${bookings.length} active bookings*.\n\nWhich one would you like to view?`,
    button: 'View Bookings',
    sections: [{ title: 'Active Bookings', rows }],
  };
}

/**
 * Build a WhatsApp reply for status lookups scoped to the customer's message.
 */
export async function buildStatusReply({ session, business, message }) {
  const scope = detectStatusScope(message);
  const phone = session.customerPhone;
  const tenantId = session.tenantId;
  const adminPhone = business?.adminPhone;

  let orderResolution = null;
  let bookings = [];

  if (scope === 'ORDER' || scope === 'BOTH') {
    orderResolution = await resolveActiveOrder(phone, tenantId, business, session).catch(() => null);
  }
  if (scope === 'BOOKING' || scope === 'BOTH') {
    bookings = await getActiveBookings(phone, tenantId).catch(() => []);
  }

  const multipleOrders = orderResolution?.state === 'MULTIPLE_ACTIVE_ORDERS';
  const activeOrder = orderResolution?.order && orderResolution?.state !== 'NO_ACTIVE_ORDER'
    ? orderResolution.order
    : null;

  if (scope === 'ORDER' && multipleOrders && orderResolution?.uiResponse) {
    return orderResolution.uiResponse;
  }

  if (scope === 'BOOKING' && bookings.length > 1) {
    return _multipleBookingsList(bookings);
  }

  const sections = [];

  if (scope === 'ORDER' || scope === 'BOTH') {
    if (multipleOrders && orderResolution?.orders?.length) {
      const summary = orderResolution.orders.slice(0, 3).map(o =>
        `• #${o.shortId || '???'} — ${formatOrderItemSummary(o)} (${ORDER_STATUS_LABELS[o.status] || o.status})`
      ).join('\n');
      sections.push(`📦 *Active orders (${orderResolution.orders.length})*\n${summary}\n\n_Reply with a reference or tap below to pick one._`);
    } else if (activeOrder) {
      sections.push(formatOrderStatusCard(activeOrder, business));
    } else if (scope === 'ORDER') {
      sections.push(`📦 No matching order was found for your number.`);
    }
  }

  if (scope === 'BOOKING' || scope === 'BOTH') {
    if (bookings.length > 1 && scope === 'BOTH') {
      const summary = bookings.slice(0, 3).map(b =>
        `• #${b.shortId || '???'} — ${b.date || '—'} ${b.time || ''} (${BOOKING_STATUS_LABELS[b.status] || b.status})`
      ).join('\n');
      sections.push(`📅 *Active bookings (${bookings.length})*\n${summary}`);
    } else if (bookings.length === 1) {
      sections.push(formatBookingStatusCard(bookings[0]));
    } else if (scope === 'BOOKING') {
      sections.push(`📅 No matching booking was found for your number.`);
    }
  }

  if (scope === 'BOTH' && !sections.length) {
    sections.push(`You don't have any active orders or bookings right now.`);
  }

  let body;
  if (sections.length) {
    const heading = scope === 'ORDER' ? '📦 *Order status*'
      : scope === 'BOOKING' ? '📅 *Booking status*'
      : '📋 *Your active records*';
    body = `${heading}\n\n${sections.join('\n\n')}`;
    if (adminPhone) body += `\n\nFor live updates: 📞 *${adminPhone}*`;
  } else {
    body = `No active records were found.\n\n${adminPhone ? `Contact us: 📞 *${adminPhone}*` : 'Contact us directly for help.'}`;
  }

  if (multipleOrders && (scope === 'ORDER' || scope === 'BOTH') && orderResolution?.uiResponse) {
    return orderResolution.uiResponse;
  }

  return {
    type: 'buttons',
    body,
    buttons: _defaultButtons(business),
  };
}
