/**
 * services/bookingService.js
 *
 * [FIX-BUG5] Now calls recordBooking() after every successful booking so
 *            customer memory stats.totalBookings is actually tracked.
 */
import Booking from '../../models/Booking.js';
import { recordBooking } from '../../core/memory/customerMemory.js';
import logger from '../../config/logger.js';
import { normalizeCustomerPhone } from '../../utils/customerPhone.js';

export const saveBooking = async ({ customerPhone, customerName, date, time, service, partySize, parsedDate, tenantId, businessId, staff, bookingType, notes }) => {
  const phone = normalizeCustomerPhone(customerPhone);
  const booking = await Booking.create({
    customerPhone: phone,
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
  recordBooking(phone, String(tenantId)).catch(err =>
    logger.debug('[BookingService] recordBooking failed (non-fatal)', { err: err.message })
  );

  return booking;
}

export const getBookingByShortId = async (shortId, tenantId) => {
  return Booking.findOne({ shortId: shortId.toUpperCase(), tenantId }).lean();
}

// [AUDIT-FIX-14] Added — no equivalent of orderService.getRecentOrders() existed for
// bookings, so nothing in the codebase could answer "do I have a booking?" with real
// data. Booking.status enum is ['pending','confirmed','completed','cancelled']; a
// booking is "active" (still relevant to the customer) while it's pending admin
// confirmation or already confirmed — completed/cancelled bookings are history, not
// something to surface as "you have an active booking".
export const getActiveBooking = async (customerPhone, tenantId) => {
  const { buildActiveBookingFilter } = await import('../activity/activityLifecycleService.js');
  return Booking.findOne(buildActiveBookingFilter(customerPhone, tenantId))
    .sort({ createdAt: -1 })
    .lean();
}

export const getActiveBookings = async (customerPhone, tenantId, limit = 10) => {
  const { buildActiveBookingFilter } = await import('../activity/activityLifecycleService.js');
  return Booking.find(buildActiveBookingFilter(customerPhone, tenantId))
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}
