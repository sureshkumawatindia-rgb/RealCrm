const mongoose = require('mongoose');
const { LEAD_SOURCES } = require('../constants/crm');

// Who gets a new lead (Phase 4). Rules are tried in priority order; the first whose conditions
// all match decides. An empty condition list matches anything. Round-robin keeps its turn in
// rrCounter (one atomic increment per lead), so two leads at the same moment go to different people.
const assignmentRuleSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, trim: true, default: '' },
    active: { type: Boolean, default: true },
    priority: { type: Number, default: 100 },
    conditions: {
      sources: { type: [{ type: String, enum: LEAD_SOURCES }], default: [] },
      productIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }], default: [] },
      states: { type: [String], default: [] },
      cities: { type: [String], default: [] },
    },
    strategy: { type: String, enum: ['round_robin', 'specific'], default: 'round_robin' },
    memberIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' }], default: [] },
    respectWorkingHours: { type: Boolean, default: false },
    fallbackMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    rrCounter: { type: Number, default: 0 },
    stats: { assigned: { type: Number, default: 0 }, lastAssignedAt: { type: Date } },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

assignmentRuleSchema.index({ organizationId: 1, active: 1, priority: 1 });

module.exports = mongoose.model('AssignmentRule', assignmentRuleSchema);
