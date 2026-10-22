const mongoose = require('mongoose');
const { TELEPHONY_PROVIDERS } = require('../constants/calls');

// The company's cloud-telephony account for click-to-call (Phase 6, D85): one per company. The
// API key and token are encrypted (secretBox) and never sent back to a page. webhookKey is the
// secret part of the status webhook's address (the provider does not sign its callbacks).
const telephonyConnectionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    provider: { type: String, enum: TELEPHONY_PROVIDERS, required: true },
    accountSid: { type: String, trim: true, default: '' },
    apiKeyEnc: { type: String, default: '' },
    apiTokenEnc: { type: String, default: '' },
    subdomain: { type: String, trim: true, default: 'api.exotel.com' },
    callerId: { type: String, trim: true, default: '' }, // the number customers see (an ExoPhone)
    webhookKey: { type: String, required: true },
    status: { type: String, enum: ['active', 'error'], default: 'active' },
    lastError: { type: String, default: '' },
    lastCallAt: { type: Date },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

telephonyConnectionSchema.index({ organizationId: 1 }, { unique: true });
telephonyConnectionSchema.index({ webhookKey: 1 }, { unique: true });

module.exports = mongoose.model('TelephonyConnection', telephonyConnectionSchema);
