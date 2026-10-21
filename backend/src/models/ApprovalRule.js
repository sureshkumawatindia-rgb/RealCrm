const mongoose = require('mongoose');
const { APPROVAL_ROLES, RULE_STATUSES } = require('../constants/approvals');

// A limit on quotations (Phase 1E, D77). A quotation that crosses any of its conditions needs an
// owner's or admin's approval before it is sent, marked sent or accepted, or downloaded as a PDF,
// when the one sending it has a role in appliesTo. Archiving keeps the rule; nothing is deleted.
const approvalRuleSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    object: { type: String, enum: ['quotation'], default: 'quotation' },
    name: { type: String, required: true, trim: true },
    // The whole quotation's discount as a % of its subtotal; "more than" this needs approval.
    discountPercentAbove: { type: Number, min: 0, max: 100 },
    // The grand total in paise; "more than" this needs approval.
    grandTotalAbovePaise: { type: Number, min: 0 },
    appliesTo: { type: [{ type: String, enum: APPROVAL_ROLES }], default: ['agent'] },
    status: { type: String, enum: RULE_STATUSES, default: 'active' },
    archivedAt: { type: Date },
    version: { type: Number, default: 0 },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

approvalRuleSchema.index({ organizationId: 1, object: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model('ApprovalRule', approvalRuleSchema);
