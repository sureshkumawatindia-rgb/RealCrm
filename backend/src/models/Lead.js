const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { LEAD_STAGES, LEAD_SOURCES } = require('../constants/crm');

// The sales opportunity. Leads and deals are one pipeline (D13); the Deals page is the
// Kanban view of leads. Probability comes from the stage; version guards concurrent edits.
const leadSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    title: { type: String, trim: true, default: '' },
    stage: { type: String, enum: LEAD_STAGES, default: 'New' },
    probability: { type: Number, min: 0, max: 100, default: 10 },
    lostReason: { type: String, trim: true, default: '' },
    source: { type: String, enum: LEAD_SOURCES, default: 'Manual' },
    sourceRef: { type: String },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, min: 0 },
    expectedValuePaise: { type: Number, min: 0 },
    expectedCloseDate: { type: Date },
    followUpAt: { type: Date },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    notes: { type: String, default: '' },
    noteEntries: {
      type: [{
        _id: false,
        id: { type: String, required: true },
        title: { type: String, default: '' },
        text: { type: String, default: '' },
        createdAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    stageChangedAt: { type: Date },
    convertedAt: { type: Date },
    lastActivityAt: { type: Date },
    lastQuoteSentAt: { type: Date },
    lastCustomerReplyAt: { type: Date },
    version: { type: Number, default: 0 },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

leadSchema.plugin(softDelete);
leadSchema.index({ organizationId: 1, deletedAt: 1, stage: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, ownerId: 1, stage: 1 });
leadSchema.index({ organizationId: 1, followUpAt: 1 });
leadSchema.index({ organizationId: 1, contactId: 1 });
leadSchema.index({ organizationId: 1, legacyIds: 1 });
leadSchema.index(
  { organizationId: 1, source: 1, sourceRef: 1 },
  { unique: true, partialFilterExpression: { sourceRef: { $type: 'string' } } },
);

module.exports = mongoose.model('Lead', leadSchema);
