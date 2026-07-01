/**
 * models/Booking.js
 *
 * Stores customer bookings for RESTAURANT (table) and SALON (appointment) modes.
 * Fields: customerPhone, date, time, service, duration, notes, status, notifiedAt.
 */

import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tenant', required: true, index: true,
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BusinessConfig', index: true,
  },

  customerPhone: { type: String, required: true, index: true },
  phone:         { type: String, index: true }, // legacy alias

  // RESTAURANT/RETAIL: date + time
  date:    { type: String, default: null },
  // Normalised JS Date derived from the free-text `date` field at creation time.
  // Populated by tryParseDate() in flowService — null when unparseable.
  // Used by schedulerService for accurate reminder timing instead of the
  // createdAt-based window hack. [merged from v14]
  parsedDate: { type: Date, default: null },
  time:    { type: String, default: null },

  // SALON: service selected
  service:  { type: String, default: null },
  duration: { type: Number, default: null }, // minutes

  // [FIX-SALON-1] Stylist / barber name chosen during salon booking or walk-in flow.
  // Previously the salon flow saved the stylist inside the `notes` text field only —
  // no dedicated column, so dashboards and admin alerts had no structured way to read it.
  // Now written by saveBooking() when staff is provided; shown in admin alerts and
  // confirmBooking() customer message.
  staff:       { type: String, default: null },

  // [FIX-SALON-2] Booking type — differentiates appointment from walk-in queue entry.
  // 'appointment' = standard date+time booking (BOOKING flow).
  // 'walkin'      = walk-in queue registration (WALKIN flow, date = today, time = 'Walk-In').
  // Absent field (null) = legacy bookings created before this field was added.
  bookingType: {
    type:    String,
    enum:    ['appointment', 'walkin', null],
    default: null,
  },

  // [FIX] Customer display name (captured during booking flow or from UserProfile).
  // Used in booking reminders and admin dashboard — previously absent from model.
  customerName: { type: String, default: null },

  // [FIX] Party / group size — critical for RESTAURANT table booking mode.
  // Without this the admin has no idea how many covers to prepare.
  partySize: { type: Number, default: null, min: 1 },

  notes: { type: String, default: null },

  status: {
    type: String,
    enum: ['pending', 'confirmed', 'completed', 'cancelled'],
    default: 'pending',
  },

  notifiedAt: { type: Date, default: null },

  // [FIX] Admin confirmation workflow — tracks who confirmed/declined and when.
  // Previously bookings moved to 'confirmed' only via schedulerService with no
  // human-in-the-loop step. Admins can now confirm/decline via WhatsApp commands
  // (CONFIRM BOOK <shortId> / DECLINE BOOK <shortId>).
  adminConfirmedAt:   { type: Date,   default: null },
  adminConfirmedBy:   { type: String, default: null }, // admin phone
  adminDeclinedAt:    { type: Date,   default: null },
  adminDeclinedBy:    { type: String, default: null },
  adminNote:          { type: String, default: null }, // optional note to customer

  // [AUDIT-FIX-1] cancelledBy / cancelledAt — written by moduleRouter.js's CANCEL
  // handler and flowEngine.js's cancelFlow() whenever a customer cancels a booking,
  // but previously absent from this schema. Mongoose strict mode silently dropped
  // both fields on every cancel $set — status:'cancelled' saved correctly, but the
  // who/when audit trail was always lost.
  cancelledBy: { type: String, default: null }, // 'customer' | admin phone
  cancelledAt: { type: Date,   default: null },

  // Short ID for admin WhatsApp commands (CONFIRM BOOK ABC123)
  // Last 6 hex chars of _id, indexed, populated by pre-save hook.
  shortId: { type: String, index: true, default: null },

  // [FIX] Set by schedulerService when a booking-reminder WhatsApp template is sent.
  // Without this field, Mongoose strict mode silently drops the $set and the
  // scheduler re-sends the reminder on every hourly run — spamming customers.
  reminderSentAt:     { type: Date, default: null },
  followUpSentAt:     { type: Date, default: null },   // [v15-FOLLOWUP] post-appointment follow-up

}, { timestamps: true });

// [FIX-D] Compound indexes for the two most common query patterns.
// listBookings: Booking.find({ tenantId, status?, createdAt range }).sort({ createdAt: -1 })
// Without a compound index this does a full collection scan scoped only by tenantId.
bookingSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

// exportBookings / getBooking: common lookup by tenantId + customerPhone
bookingSchema.index({ tenantId: 1, customerPhone: 1, createdAt: -1 });

// Populate shortId before first save (mirrors Order model pattern)
bookingSchema.pre('save', function (next) {
  if (!this.shortId) {
    this.shortId = String(this._id).slice(-6).toUpperCase();
  }
  next();
});

// [FIX-8] Defensive insertMany hook — mirrors Order model. pre('save') does not fire
// on insertMany(). No current code path calls Booking.insertMany(), but this prevents
// a future silent shortId=null bug if bulk creation is ever added.
bookingSchema.pre('insertMany', function (next, docs) {
  if (Array.isArray(docs)) {
    for (const doc of docs) {
      if (!doc.shortId && doc._id) {
        doc.shortId = String(doc._id).slice(-6).toUpperCase();
      }
    }
  }
  next();
});

export default mongoose.model('Booking', bookingSchema);
