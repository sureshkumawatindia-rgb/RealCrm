const mongoose = require('mongoose');
const { LEAD_STAGES } = require('../constants/crm');

// Meta Conversions API for CRM (Phase 10C, Settings → API & webhooks): the company's Meta
// dataset (pixel) and a system user token (encrypted), and which lead stages are sent, so Meta
// can optimise Lead Ads for the leads that become customers. One per organization.
const conversionsApiConnectionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    datasetId: { type: String, required: true, trim: true },
    datasetName: { type: String, default: '' },
    accessTokenEnc: { type: String, required: true },
    accessTokenLast4: { type: String, default: '' },
    testEventCode: { type: String, default: '' }, // while set, events go to Meta's Test events only
    enabled: { type: Boolean, default: true },
    // Lead Ads leads (with Meta's lead id) always; leads from other sources only when asked
    // (they are matched by hashed phone and email).
    allSources: { type: Boolean, default: false },
    stages: [{ type: String, enum: LEAD_STAGES }],
    status: { type: String, enum: ['connected', 'error'], default: 'connected' },
    statusMessage: { type: String, default: '' },
    checkedAt: Date,
    stats: {
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      lastSentAt: Date,
      lastError: { type: String, default: '' },
      lastErrorAt: Date,
    },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

conversionsApiConnectionSchema.index({ organizationId: 1 }, { unique: true });

module.exports = mongoose.model('ConversionsApiConnection', conversionsApiConnectionSchema);
