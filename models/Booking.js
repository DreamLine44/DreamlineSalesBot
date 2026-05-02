/**
 * models/Booking.js — WhatsBotLyn v15
 *
 * v15 additions:
 * - service: selected service name (Salon mode)
 * - duration: minutes (from services[])
 * - notes: freeform customer note
 * - notifiedAt: when admin was alerted
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
