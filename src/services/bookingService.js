/**
 * services/bookingService.js
 *
 * [FIX-BUG5] Now calls recordBooking() after every successful booking so
 *            customer memory stats.totalBookings is actually tracked.
 */
import Booking from '../models/Booking.js';
import { recordBooking } from '../core/memory/customerMemory.js';
import logger from '../config/logger.js';

export async function saveBooking({ customerPhone, customerName, date, time, service, partySize, parsedDate, tenantId, businessId, staff, bookingType, notes }) {
  const booking = await Booking.create({
    customerPhone,
    customerName:  customerName || null,
    date, time,
    service:       service      || null,
    partySize:     partySize    || null,
    parsedDate:    parsedDate   || null,
    // [FIX-SALON-1] Persist stylist/barber name in dedicated field
    staff:         staff        || null,
    // [FIX-SALON-2] Persist booking type (appointment vs walkin)
    bookingType:   bookingType  || null,
    notes:         notes        || null,
    tenantId, businessId,
    status: 'pending',
  });

  // [FIX-BUG5] Update customer memory — fire-and-forget
  recordBooking(customerPhone, String(tenantId)).catch(err =>
    logger.debug('[BookingService] recordBooking failed (non-fatal)', { err: err.message })
  );

  return booking;
}

export async function getBookingByShortId(shortId, tenantId) {
  return Booking.findOne({ shortId: shortId.toUpperCase(), tenantId }).lean();
}
