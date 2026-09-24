const mongoose = require('mongoose');

// Remembers the response of a retriable request (Idempotency-Key header) for 24 hours.
const idempotencyRecordSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    operation: { type: String, required: true },
    key: { type: String, required: true },
    requestHash: { type: String, required: true },
    statusCode: { type: Number },
    body: { type: mongoose.Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

idempotencyRecordSchema.index({ organizationId: 1, userId: 1, operation: 1, key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
