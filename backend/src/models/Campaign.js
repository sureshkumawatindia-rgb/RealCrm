const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { CAMPAIGN_TYPES, CAMPAIGN_STATUSES } = require('../constants/crm');

// A marketing campaign as planned on the Marketing page. leadsGenerated is entered by the team
// for now; lead sources (Phase 4) will count it. Notes live in the notes collection.
const campaignSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: CAMPAIGN_TYPES, default: 'Email' },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: 'Draft' },
    // Calendar days (YYYY-MM-DD), like tasks.
    startDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    budgetPaise: { type: Number, min: 0, default: 0 },
    leadsGenerated: { type: Number, min: 0, default: 0 },
    audience: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

campaignSchema.plugin(softDelete);
campaignSchema.index({ organizationId: 1, deletedAt: 1, status: 1, startDate: 1 });
campaignSchema.index({ organizationId: 1, ownerId: 1, status: 1 });
campaignSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Campaign', campaignSchema);
