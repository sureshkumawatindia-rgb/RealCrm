const mongoose = require('mongoose');

// Every automatic assignment (and every lead no rule could place), for the lead timeline and
// later the agent reports (Phase 9). Append-only.
const assignmentHistorySchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    entityType: { type: String, default: 'Lead' },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    fromMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    toMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    ruleId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssignmentRule' },
    reason: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

assignmentHistorySchema.index({ organizationId: 1, entityType: 1, entityId: 1, createdAt: -1 });
assignmentHistorySchema.index({ organizationId: 1, toMemberId: 1, createdAt: -1 });

module.exports = mongoose.model('AssignmentHistory', assignmentHistorySchema);
