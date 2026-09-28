const mongoose = require('mongoose');

// Every webhook item (a WhatsApp message or status; later lead sources and payments) is stored
// here before it is processed. The unique (provider, eventId) index makes Meta's retries
// harmless; the payload is kept 60 days for debugging.

const inboundEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    kind: { type: String, required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
    sourceId: { type: mongoose.Schema.Types.ObjectId },
    payload: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, enum: ['received', 'processed', 'ignored', 'failed'], default: 'received' },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: '' },
    processedAt: { type: Date },
  },
  { timestamps: true },
);

inboundEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
inboundEventSchema.index({ status: 1, createdAt: 1 });
inboundEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

module.exports = mongoose.model('InboundEvent', inboundEventSchema);
