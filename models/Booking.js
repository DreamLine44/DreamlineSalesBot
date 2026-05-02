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

export default mongoose.model('Booking', bookingSchema);
