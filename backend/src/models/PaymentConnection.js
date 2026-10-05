const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { PAYMENT_PROVIDER_KEYS, CONNECTION_STATUSES } = require('../constants/payments');

// A payment gateway account of an organization (Settings → Payments): Razorpay or Cashfree with
// the organization's own keys. keyId (Razorpay key id / Cashfree app id) is not a secret; the key
// secret and Razorpay's webhook secret are encrypted (secretBox) and never sent back. The gateway
// calls /api/v1/webhooks/payments/<provider>/<webhookKey> (one address per connection, D39).
const paymentConnectionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    provider: { type: String, enum: PAYMENT_PROVIDER_KEYS, required: true },
    name: { type: String, trim: true, default: '' },
    mode: { type: String, enum: ['test', 'live'], default: 'test' },
    keyId: { type: String, trim: true, default: '' },
    keySecretEnc: { type: String },
    keySecretLast4: { type: String, default: '' },
    webhookSecretEnc: { type: String },
    webhookKey: { type: String, required: true },
    status: { type: String, enum: CONNECTION_STATUSES, default: 'connected' },
    statusMessage: { type: String, default: '' },
    isDefault: { type: Boolean, default: false },
    lastCheckedAt: { type: Date },
    lastWebhookAt: { type: Date },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

paymentConnectionSchema.plugin(softDelete);
paymentConnectionSchema.index({ webhookKey: 1 }, { unique: true });
paymentConnectionSchema.index({ organizationId: 1, deletedAt: 1, isDefault: -1 });

module.exports = mongoose.model('PaymentConnection', paymentConnectionSchema);
