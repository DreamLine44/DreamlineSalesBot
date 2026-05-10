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
  time:    { type: String, default: null },

  // SALON: service selected
  service:  { type: String, default: null },
  duration: { type: Number, default: null }, // minutes

  notes: { type: String, default: null },

  status: {
    type: String,
    enum: ['pending', 'confirmed', 'completed', 'cancelled'],
    default: 'pending',
  },

  notifiedAt: { type: Date, default: null },

}, { timestamps: true });

// [FIX-D] Compound indexes for the two most common query patterns.
// listBookings: Booking.find({ tenantId, status?, createdAt range }).sort({ createdAt: -1 })
// Without a compound index this does a full collection scan scoped only by tenantId.
bookingSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

// exportBookings / getBooking: common lookup by tenantId + customerPhone
bookingSchema.index({ tenantId: 1, customerPhone: 1, createdAt: -1 });

export default mongoose.model('Booking', bookingSchema);
