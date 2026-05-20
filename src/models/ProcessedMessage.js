/**
 * models/ProcessedMessage.js
 *
 * Tracks processed WhatsApp message IDs (wamids) to prevent duplicate processing.
 * Unique compound index on (wamid, tenantId) — only one request can claim a wamid.
 * TTL index on processedAt auto-expires records after 24 hours.
 */

import mongoose from 'mongoose';

const processedMessageSchema = new mongoose.Schema({
  wamid:       { type: String, required: true },
  tenantId:    { type: String, required: true },
  processedAt: { type: Date,   default: Date.now },
}, {
  timestamps: false,
  collection: 'processedmessages',
});

// Unique index — the cornerstone of atomic dedup.
// MongoDB guarantees only one document per (wamid, tenantId) pair.
processedMessageSchema.index({ wamid: 1, tenantId: 1 }, { unique: true });

// TTL index — auto-expire after 24 hours (86400 seconds).
// WhatsApp wamids are unique within a 24-hour window per Meta's guarantees.
processedMessageSchema.index({ processedAt: 1 }, { expireAfterSeconds: 86400 });

export default mongoose.model('ProcessedMessage', processedMessageSchema);
