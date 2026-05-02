/**
 * models/FailedMessage.js
 *
 * Persistent store for WhatsApp messages that failed to send permanently
 * (token expired, all retries exhausted, non-retryable 4xx).
 *
 * Admin can query GET /admin/messages/failed-messages and replay via
 * POST /admin/messages/failed-messages/:id/replay once the issue is resolved.
 */

import mongoose from 'mongoose';

const FailedMessageSchema = new mongoose.Schema(
  {
    to:       { type: String, required: true, index: true },
    text:     { type: String, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    reason:   { type: String, enum: ['TOKEN_EXPIRED', 'RETRIES_EXHAUSTED', 'NON_RETRYABLE', 'UNKNOWN'], default: 'UNKNOWN' },
    httpStatus:  { type: Number, default: null },
    replayed:    { type: Boolean, default: false, index: true },
    retriedAt:   { type: Date, default: null },
    replayError: { type: String, default: null },
  },
  { timestamps: true }
);

FailedMessageSchema.index({ tenantId: 1, replayed: 1, createdAt: -1 });

export default mongoose.model('FailedMessage', FailedMessageSchema);
