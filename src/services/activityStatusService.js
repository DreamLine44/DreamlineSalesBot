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
  pending:                      '⏳ Waiting for our team to confirm',
  payment_pending_verification: '⏳ Awaiting payment verification',
  confirmed:                    '🍳 Being prepared',
  preparing:                    '👨‍🍳 Being prepared',
  ready:                        '✅ Ready for collection!',
  out_for_delivery:             '🚚 Out for delivery',
  delivered:                    '✅ Delivered',
  completed:                    '✅ Completed — thank you!',
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
  confirmed: '✅ Confirmed — see you soon!',
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
  const multiItem = Array.isArray(order?.items) && order.items.length > 1;
  const status = ORDER_STATUS_LABELS[order.status] || order.status;
  const payment = PAYMENT_STATUS_LABELS[order.paymentStatus] || order.paymentStatus || '—';
  const updated = order.updatedAt || order.createdAt;
  const updatedStr = updated
    ? new Date(updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null;
  const showUpdated = updatedStr && !['completed', 'delivered', 'cancelled'].includes(order.status);

  return (
    `📦 *Order Update*\n\n` +
    `• ${multiItem ? 'Items' : 'Item'}: ${items}\n` +
    `• Ref: *#${ref}*\n` +
    `• Status: ${status}\n` +
    `• Payment: ${payment}` +
    (showUpdated ? `\n• Updated: ${updatedStr}` : '')
  );
}

export function formatBookingStatusCard(booking) {
  if (!booking) return '';
  const ref = booking.shortId || '???';
  const guests = booking.partySize ? `${booking.partySize}` : '—';
  const status = BOOKING_STATUS_LABELS[booking.status] || booking.status;

  const lines = ['📅 *Booking Update*\n'];
  if (booking.service) lines.push(`• Service: *${booking.service}*`);
  lines.push(`• Ref: *#${ref}*`);
  if (booking.date) lines.push(`• Date: *${booking.date}*`);
  if (booking.time) lines.push(`• Time: *${booking.time}*`);
  lines.push(`• Guests: ${guests}`);
  lines.push(`• Status: ${status}`);

  return lines.join('\n');
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
      sections.push(`📦 *Active Orders (${orderResolution.orders.length})*\n\n${summary}\n\n_Tap below to pick one._`);
    } else if (activeOrder) {
      sections.push(formatOrderStatusCard(activeOrder, business));
    } else if (scope === 'ORDER') {
      sections.push(`📦 *Order Update*\n\nNo matching order was found for your number.`);
    }
  }

  if (scope === 'BOOKING' || scope === 'BOTH') {
    if (bookings.length > 1 && scope === 'BOTH') {
      const summary = bookings.slice(0, 3).map(b =>
        `• *#${b.shortId || '???'}* — ${b.date || '—'} ${b.time || ''} (${BOOKING_STATUS_LABELS[b.status] || b.status})`
      ).join('\n');
      sections.push(`📅 *Active Bookings (${bookings.length})*\n\n${summary}`);
    } else if (bookings.length === 1) {
      sections.push(formatBookingStatusCard(bookings[0]));
    } else if (scope === 'BOOKING') {
      sections.push(`📅 *Booking Update*\n\nNo matching booking was found for your number.`);
    }
  }

  if (scope === 'BOTH' && !sections.length) {
    sections.push(`📋 *Status Update*\n\nYou don't have any active orders or bookings right now.`);
  }

  let body;
  if (sections.length) {
    const singleCard = sections.length === 1 &&
      (activeOrder || bookings.length === 1) &&
      !multipleOrders;
    body = singleCard
      ? sections[0]
      : sections.join('\n\n');
    if (adminPhone) body += `\n\n_For live updates:_ 📞 *${adminPhone}*`;
  } else {
    body = `📋 *Status Update*\n\nNo active records were found.${adminPhone ? `\n\nContact us: 📞 *${adminPhone}*` : '\n\nContact us directly for help.'}`;
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
