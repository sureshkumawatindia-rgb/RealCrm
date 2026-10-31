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
    // Where it sits on the board (D84): its pipeline and stage (for Won and Lost, the last open
    // one), and since when. stage above stays the fixed kind every report reads. No pipeline:
    // the company's default pipeline.
    pipelineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pipeline' },
    pipelineStageId: { type: mongoose.Schema.Types.ObjectId },
    pipelineStageAt: { type: Date },
    // A private number (D61): only owners see it (and its leads and chats).
    private: { type: Boolean },
    convertedAt: { type: Date },
    lastActivityAt: { type: Date },
    lastQuoteSentAt: { type: Date },
    lastCustomerReplyAt: { type: Date },
    // Where it came from (D79, services/attributionService.js): the first enquiry's touch, and the
    // latest one (a repeat enquiry on this lead updates only "last").
    attribution: {
      first: { channel: String, source: String, medium: String, campaign: String, adId: String, ad: String, at: Date },
      last: { channel: String, source: String, medium: String, campaign: String, adId: String, ad: String, at: Date },
    },
    // How warm an open lead is (G2, D106, services/leadScoreService.js): 0–100 points, hot / warm /
    // cold, and why (reason codes with their points and numbers, shown in the person's language).
    // Worked out again a minute after a reply, a quotation view, an order or a stage change, and
    // every day; a closed lead has none.
    score: {
      points: { type: Number, min: 0, max: 100 },
      band: { type: String, enum: ['hot', 'warm', 'cold'] },
      reasons: { type: [{ code: String, points: Number, params: mongoose.Schema.Types.Mixed, _id: false }], default: undefined },
      at: { type: Date },
    },
    version: { type: Number, default: 0 },
    // The company's own fields (D73): { key: value }, checked by services/customFieldService.js.
    customFields: { type: mongoose.Schema.Types.Mixed },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

leadSchema.plugin(softDelete);
leadSchema.index({ organizationId: 1, deletedAt: 1, stage: 1, createdAt: -1 });
leadSchema.index({ organizationId: 1, ownerId: 1, stage: 1 });
leadSchema.index({ organizationId: 1, followUpAt: 1 });
leadSchema.index({ stage: 1, 'score.at': 1 }); // the scoring sweep (D106)
leadSchema.index({ organizationId: 1, contactId: 1 });
leadSchema.index({ organizationId: 1, legacyIds: 1 });
leadSchema.index(
  { organizationId: 1, source: 1, sourceRef: 1 },
  { unique: true, partialFilterExpression: { sourceRef: { $type: 'string' } } },
);

module.exports = mongoose.model('Lead', leadSchema);
