/**
 * services/bookingService.js
 */
import Booking from '../models/Booking.js';

export async function saveBooking({ customerPhone, customerName, date, time, service, parsedDate, tenantId, businessId }) {
  // NOTE: do NOT set shortId here — Booking.pre('save') hook auto-populates it
  // from the last 6 hex chars of _id, consistent with admin command lookups.
  return Booking.create({
    customerPhone, customerName: customerName || null,
    date, time, service: service || null,
    parsedDate: parsedDate || null,
    tenantId, businessId,
    status: 'pending',
  });
}

export async function getBookingByShortId(shortId, tenantId) {
  return Booking.findOne({ shortId: shortId.toUpperCase(), tenantId }).lean();
}
