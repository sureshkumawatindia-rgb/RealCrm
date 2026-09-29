const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { CONNECTION_TYPES, CONNECTION_STATUSES } = require('../constants/leadSources');

// One way leads reach an organization (Settings → Lead sources): a website form, IndiaMART,
// Facebook Lead Ads, … Keys and passwords are encrypted (secretBox) and never sent back in full.
// publicKey identifies a website form (it is visible in the page, so it is not a secret);
// webhookKey is the secret part of a push URL (IndiaMART push, JustDial, Google Ads).
const leadSourceConnectionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    type: { type: String, enum: Object.keys(CONNECTION_TYPES), required: true },
    name: { type: String, trim: true, default: '' },
    status: { type: String, enum: CONNECTION_STATUSES, default: 'active' },
    statusMessage: { type: String, default: '' },
    publicKey: { type: String },
    webhookKey: { type: String },
    credentialsEnc: { type: String },
    credentialsHint: { type: String, default: '' },
    // Type-specific options, e.g. a website form's allowed sites and thank-you text.
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Where a polling source continues from (e.g. IndiaMART's last end time).
    cursor: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastPolledAt: { type: Date },
    lastLeadAt: { type: Date },
    lastError: { type: String, default: '' },
    lastErrorAt: { type: Date },
    stats: {
      received: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      attached: { type: Number, default: 0 },
      duplicate: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
    },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

leadSourceConnectionSchema.plugin(softDelete);
leadSourceConnectionSchema.index({ publicKey: 1 }, { unique: true, sparse: true });
leadSourceConnectionSchema.index({ webhookKey: 1 }, { unique: true, sparse: true });
leadSourceConnectionSchema.index({ organizationId: 1, deletedAt: 1, type: 1 });

module.exports = mongoose.model('LeadSourceConnection', leadSourceConnectionSchema);
