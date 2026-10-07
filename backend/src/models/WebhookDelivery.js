const mongoose = require('mongoose');

// One event sent (or being sent) to one outbound webhook (Phase 10C), with every attempt's
// result, for the delivery log. Kept 30 days.
const webhookDeliverySchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WebhookSubscription', required: true },
    eventId: { type: String, required: true }, // evt_… — the same for every address and attempt
    event: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, enum: ['pending', 'delivered', 'failed', 'cancelled'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: Date,
    responseCode: Number,
    responseBody: { type: String, default: '' },
    error: { type: String, default: '' },
    durationMs: Number,
    deliveredAt: Date,
  },
  { timestamps: true },
);

webhookDeliverySchema.index({ subscriptionId: 1, eventId: 1 }, { unique: true });
webhookDeliverySchema.index({ organizationId: 1, subscriptionId: 1, createdAt: -1 });
webhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('WebhookDelivery', webhookDeliverySchema);
