const mongoose = require('mongoose');
const { WEBHOOK_EVENT_KEYS } = require('../constants/api');

// An outbound webhook (Phase 10C): an https address of the company's own system (or Zapier,
// Make …) that gets the chosen events, signed with its own secret (encrypted, shown once).
const webhookSubscriptionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    url: { type: String, required: true },
    events: [{ type: String, enum: WEBHOOK_EVENT_KEYS }],
    description: { type: String, default: '' },
    secretEnc: { type: String, required: true },
    active: { type: Boolean, default: true },
    disabledReason: { type: String, default: '' },
    failuresInARow: { type: Number, default: 0 },
    lastDeliveryAt: Date,
    lastStatus: String, // delivered / failed
    lastResponseCode: Number,
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

webhookSubscriptionSchema.index({ organizationId: 1, active: 1, events: 1 });

module.exports = mongoose.model('WebhookSubscription', webhookSubscriptionSchema);
